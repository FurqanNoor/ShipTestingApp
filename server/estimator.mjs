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
export const parallelSpeedup=(cores,saturation=PARALLEL_SATURATION)=>Math.min(Math.max(1,cores),Math.max(1,saturation))**PARALLEL_EXPONENT;
export const DEFAULTS={
  'calm:quick':{secondsPerCellStep:7.4e-6,dtPerFinestCell:.356,cellGrowth:1.19,meshSecondsPerCell:1.6e-4},
  'calm:standard':{secondsPerCellStep:1.3e-5,dtPerFinestCell:.12,cellGrowth:1.19,meshSecondsPerCell:1.6e-4},
  'waves:quick':{secondsPerCellStep:2.1e-5,dtPerFinestCell:.7,cellGrowth:.98,meshSecondsPerCell:1.8e-4}, // measured: 307k-cell catamaran, 4 cores
  'waves:standard':{secondsPerCellStep:2.4e-5,dtPerFinestCell:.3,cellGrowth:.95,meshSecondsPerCell:1.8e-4},
};
const KEYS=['secondsPerCellStep','dtPerFinestCell','cellGrowth','meshSecondsPerCell'];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;

export function runKey(manifest){
  const mode=manifest?.condition?.kind==='calm'||!manifest?.condition?.kind?'calm':'waves';
  return `${mode}:${manifest?.mesh?.fidelity==='quick'?'quick':'standard'}`;
}

/** Calibrated parameters for one run type; falls back to defaults scaled by this machine's measured speed. */
export function parameters(key,calibration={}){
  const base={...(DEFAULTS[key]??DEFAULTS['calm:standard'])},own=calibration.entries?.[key];
  const speed=finite(calibration.machineSpeedFactor)?calibration.machineSpeedFactor:1;
  const out={...base,secondsPerCellStep:base.secondsPerCellStep*speed,calibrated:false,samples:0};
  if(own)for(const k of KEYS)if(finite(own[k]))out[k]=own[k];
  if(own?.samples)Object.assign(out,{calibrated:true,samples:own.samples});
  return out;
}

/** Predict one run from its generated manifest. */
export function predictRun(manifest,{cores=1,calibration,saturation}={}){
  const key=runKey(manifest),p=parameters(key,calibration);
  const n=manifest?.numerics??{},mesh=manifest?.mesh??{};
  const cells=Math.max(1,(Number(mesh.estimatedBaseCells)||1)*p.cellGrowth);
  const dtCap=finite(n.maxDeltaTS)?n.maxDeltaTS:.001;
  const dt=Math.max(1e-7,Math.min(dtCap,p.dtPerFinestCell*(finite(mesh.finestCellM)?mesh.finestCellM:.003)));
  const steps=(finite(n.durationS)?n.durationS:1)/dt;
  const solveS=steps*cells*p.secondsPerCellStep/parallelSpeedup(cores,saturation);
  const meshS=cells*p.meshSecondsPerCell;
  return {key,cells:Math.round(cells),steps:Math.round(steps),meshS,solveS,totalS:meshS+solveS,calibrated:p.calibrated};
}

/** Learn from a finished run's measured timings. Returns a new calibration object. */
export function learn(calibration={},sample){
  const {manifest,actualCells,steps,solveWallS,meshWallS,cores=1,saturation}=sample??{};
  if(!manifest||!finite(actualCells)||!finite(steps)||!finite(solveWallS))return calibration;
  const key=runKey(manifest),mesh=manifest.mesh??{},n=manifest.numerics??{};
  const measured={
    secondsPerCellStep:solveWallS*parallelSpeedup(cores,saturation)/(steps*actualCells),
    dtPerFinestCell:finite(n.durationS)&&finite(mesh.finestCellM)?n.durationS/steps/mesh.finestCellM:undefined,
    cellGrowth:finite(mesh.estimatedBaseCells)?actualCells/mesh.estimatedBaseCells:undefined,
    meshSecondsPerCell:finite(meshWallS)?meshWallS/actualCells:undefined,
  };
  const entries={...(calibration.entries??{})},prev=entries[key]??{},next={samples:(prev.samples??0)+1};
  // Recent runs weigh more (machine load and Docker limits change), but one odd run cannot swing it fully.
  const w=prev.samples?.5:1;
  for(const k of KEYS){const m=measured[k],old=prev[k];next[k]=finite(m)?(finite(old)?old*(1-w)+m*w:m):old;}
  entries[key]=next;
  const ratios=Object.entries(entries).filter(([k,e])=>DEFAULTS[k]&&finite(e.secondsPerCellStep)).map(([k,e])=>e.secondsPerCellStep/DEFAULTS[k].secondsPerCellStep);
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
