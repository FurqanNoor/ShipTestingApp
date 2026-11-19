/**
 * Wall-clock time estimates for OpenFOAM runs. Estimates are planning aids only and never enter results.
 *
 * Model per run:  meshing  = cells x meshSecondsPerCell                (snappyHexMesh is serial)
 *                 solving  = steps x cells x secondsPerCellStep / cores^PARALLEL_EXPONENT
 *                 steps    = simulated duration / average time step
 *                 time step = min(maxDeltaT, dtPerFinestCell x finest cell size)   (Courant-limited)
 * Defaults were measured with the pinned v2312 image on a slow 4-vCPU VM, so they err on the long side.
 * Every finished run on this machine updates the calibration (cfd-runs/calibration.json).
 */
export const PARALLEL_EXPONENT=.83; // measured: 4 cores ran 3.15x faster than 1 core
/** Ranks beyond this add no speed on typical CPUs (memory bandwidth); measured 8 fastest on an 8-core laptop. */
export const PARALLEL_SATURATION=8;
/** Speed-up over one core. saturation: ranks beyond which a machine gains nothing (8 on desktops/laptops; a cluster node with many memory channels keeps scaling). */
/**
 * Fewer cells per core than this add no speed (communication dominates): on Roihu a 131k-cell calm run was fastest on
 * 64 cores (2.7 min) and slower on 128 (3.1 min), i.e. about 2000 cells per core.
 */
export const MIN_CELLS_PER_CORE=2000;
export const parallelSpeedup=(cores,saturation=PARALLEL_SATURATION,cells=Infinity)=>Math.min(Math.max(1,cores),Math.max(1,saturation),Math.max(1,cells/MIN_CELLS_PER_CORE))**PARALLEL_EXPONENT;
export const DEFAULTS={
  'calm:quick':{secondsPerCellStep:7.4e-6,dtPerFinestCell:.356,cellGrowth:1.19,meshSecondsPerCell:1.6e-4},
  'calm:standard':{secondsPerCellStep:1.3e-5,dtPerFinestCell:.12,cellGrowth:1.19,meshSecondsPerCell:1.6e-4},
  'waves:quick':{secondsPerCellStep:2.1e-5,dtPerFinestCell:.7,cellGrowth:.98,meshSecondsPerCell:1.8e-4}, // measured: 307k-cell catamaran, 4 cores
  'waves:standard':{secondsPerCellStep:2.4e-5,dtPerFinestCell:.3,cellGrowth:.95,meshSecondsPerCell:1.8e-4},
};
/** Courant limit the default/legacy dtPerFinestCell values were measured at; time steps scale with the Courant limit. */
export const REFERENCE_COURANT={calm:.8,waves:1};
const KEYS=['secondsPerCellStep','dtPerFinestCellPerCo','cellGrowth','meshSecondsPerCell'];
const refCo=key=>REFERENCE_COURANT[key.split(':')[0]]??1;
const defaultsFor=key=>DEFAULTS[key.split(':').slice(0,2).join(':')];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;

/**
 * Mesh cells relative to the coarse grid of the same hull: each level halves the near-hull cell (snappyHexMesh surface
 * level +1). Measured medium/coarse 1.78 (220 mm SWATH calm, Roihu). Fine is an estimate until a fine run calibrates it.
 */
export const LEVEL_GROWTH={coarse:1,medium:1.8,fine:4.5};
/** Calibration key: test type, fidelity and mesh level (cell growth differs per level; it used to be shared). */
export function runKey(manifest){
  const mode=manifest?.condition?.kind==='calm'||!manifest?.condition?.kind?'calm':'waves';
  const level=['medium','fine'].includes(manifest?.mesh?.level)?manifest.mesh.level:'coarse';
  return `${mode}:${manifest?.mesh?.fidelity==='quick'?'quick':'standard'}:${level}${manifest?.numerics?.steady?':steady':''}${manifest?.numerics?.interfaceCapturing==='isoAdvector'?':iso':''}`;
}
/**
 * isoAdvector (interIsoFoam) against MULES on the same calm medium mesh, 192 cores on Roihu, 19 Nov 2026: about
 * 360 s per simulated second against ~140 s. Used only until isoAdvector runs of that type have calibrated their own key.
 */
export const ISO_SLOWDOWN=2.5;
const baseKey=key=>key.split(':').slice(0,2).join(':');
const levelOf=key=>key.split(':')[2]??'coarse';
const levelKey=key=>key.split(':').slice(0,3).join(':');

/** Calibrated parameters for one run type; falls back to defaults scaled by this machine's measured speed. */
export function parameters(key,calibration={}){
  const level=levelOf(key),growth=LEVEL_GROWTH[level]??1,entries=calibration.entries??{};
  const base={...(DEFAULTS[baseKey(key)]??DEFAULTS['calm:standard'])};base.cellGrowth*=growth;
  // This level's own calibration; otherwise the coarse one (or the older shared one) with the level's cell growth.
  let own=entries[key];
  const iso=key.endsWith(':iso'),slow=iso&&!own?ISO_SLOWDOWN:1;
  if(!own){
    // A steady or isoAdvector run first borrows the transient MULES calibration of its own mesh level (same mesh, so
    // same cell growth); isoAdvector then costs ISO_SLOWDOWN times more per cell step.
    const same=levelKey(key)!==key?entries[levelKey(key)]:undefined;
    const fb=same??entries[`${baseKey(key)}:coarse`]??entries[baseKey(key)];
    if(fb)own={...fb,...(!same&&finite(fb.cellGrowth)?{cellGrowth:fb.cellGrowth*growth}:{}),...(finite(fb.secondsPerCellStep)?{secondsPerCellStep:fb.secondsPerCellStep*slow}:{}),samples:0};
  }
  const speed=finite(calibration.machineSpeedFactor)?calibration.machineSpeedFactor:1;
  const out={...base,dtPerFinestCellPerCo:base.dtPerFinestCell/refCo(key),secondsPerCellStep:base.secondsPerCellStep*speed*slow,calibrated:false,samples:0};
  // Older calibrations stored the step per finest cell at the reference Courant limit.
  const legacy=own&&!finite(own.dtPerFinestCellPerCo)&&finite(own.dtPerFinestCell)?{dtPerFinestCellPerCo:own.dtPerFinestCell/refCo(key)}:{};
  if(own)for(const k of KEYS){const v=own[k]??legacy[k];if(finite(v))out[k]=v;}
  if(own?.samples)Object.assign(out,{calibrated:true,samples:own.samples});
  return out;
}

/** Predict one run from its generated manifest. */
export function predictRun(manifest,{cores=1,calibration,saturation}={}){
  const key=runKey(manifest),p=parameters(key,calibration);
  const n=manifest?.numerics??{},mesh=manifest?.mesh??{};
  const cells=Math.max(1,(Number(mesh.estimatedBaseCells)||1)*p.cellGrowth);
  const dtCap=finite(n.maxDeltaTS)?n.maxDeltaTS:.001;
  const co=finite(n.maxCo)?n.maxCo:refCo(key);
  const dt=Math.max(1e-7,Math.min(dtCap,p.dtPerFinestCellPerCo*co*(finite(mesh.finestCellM)?mesh.finestCellM:.003)));
  // Steady (local time stepping): durationS counts iterations.
  const steps=n.steady?(finite(n.durationS)?n.durationS:1):(finite(n.durationS)?n.durationS:1)/dt;
  const solveS=steps*cells*p.secondsPerCellStep/parallelSpeedup(cores,saturation,cells);
  const meshS=cells*p.meshSecondsPerCell;
  return {key,cells:Math.round(cells),steps:Math.round(steps),meshS,solveS,totalS:meshS+solveS,calibrated:p.calibrated};
}

/** Learn from a finished run's measured timings. Returns a new calibration object. */
export function learn(calibration={},sample){
  const {manifest,actualCells,steps,solveWallS,meshWallS,cores=1,saturation}=sample??{};
  if(!manifest||!finite(actualCells)||!finite(steps)||!finite(solveWallS))return calibration;
  const key=runKey(manifest),mesh=manifest.mesh??{},n=manifest.numerics??{};
  const measured={
    secondsPerCellStep:solveWallS*parallelSpeedup(cores,saturation,actualCells)/(steps*actualCells),
    dtPerFinestCellPerCo:!n.steady&&finite(n.durationS)&&finite(mesh.finestCellM)?n.durationS/steps/mesh.finestCellM/(finite(n.maxCo)?n.maxCo:refCo(key)):undefined,
    cellGrowth:finite(mesh.estimatedBaseCells)?actualCells/mesh.estimatedBaseCells:undefined,
    meshSecondsPerCell:finite(meshWallS)?meshWallS/actualCells:undefined,
  };
  const entries={...(calibration.entries??{})},stored=entries[key]??{},next={samples:(stored.samples??0)+1};
  const prev=!finite(stored.dtPerFinestCellPerCo)&&finite(stored.dtPerFinestCell)?{...stored,dtPerFinestCellPerCo:stored.dtPerFinestCell/refCo(key)}:stored;
  // Recent runs weigh more (machine load and Docker limits change), but one odd run cannot swing it fully.
  const w=prev.samples?.5:1;
  for(const k of KEYS){const m=measured[k],old=prev[k];next[k]=finite(m)?(finite(old)?old*(1-w)+m*w:m):old;}
  entries[key]=next;
  const ratios=Object.entries(entries).filter(([k,e])=>defaultsFor(k)&&finite(e.secondsPerCellStep)).map(([k,e])=>e.secondsPerCellStep/defaultsFor(k).secondsPerCellStep);
  const machineSpeedFactor=ratios.length?Math.exp(ratios.reduce((s,r)=>s+Math.log(r),0)/ratios.length):1;
  return {schema:1,updatedAt:new Date().toISOString(),machineSpeedFactor,entries};
}

/**
 * Remaining time for a study: the active run uses its live solver rate when available,
 * queued runs use calibrated predictions, scaled by how this study's finished runs compared with their predictions.
 */
export function remainingStudySeconds({pending=[],active=null,finished=[]}){
  const ratios=finished.filter(r=>finite(r.actualS)&&finite(r.predictedS)).map(r=>r.actualS/r.predictedS);
  const scale=ratios.length?Math.min(5,Math.max(.2,ratios.reduce((s,r)=>s+r,0)/ratios.length)):1;
  let activeS=0;
  if(active){
    if(finite(active.liveEtaS)||active.liveEtaS===0)activeS=active.liveEtaS;
    else if(finite(active.predictedS))activeS=Math.max(active.predictedS*scale*.05,active.predictedS*scale-(active.elapsedS??0));
  }
  const queuedS=pending.reduce((s,r)=>s+(finite(r.predictedS)?r.predictedS*scale:0),0);
  return {totalS:activeS+queuedS,activeS,queuedS,scale,basedOnFinishedRuns:ratios.length};
}
