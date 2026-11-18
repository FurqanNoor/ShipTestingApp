import { prepareCfdHull, type CfdEnvelopeMode } from './geometry';
import { computeHydrostatics, type CfdHydroState, type HydroPoint } from './hydro';
import { generateOpenFoamCase, type CfdCasePackage, type MeshLevel } from './case';
import { extendCaseWithWaves } from './waves';
import { estimateMassProperties,type Matrix3 } from './massProperties';
import {solveFloatingEquilibrium,type FloatingEquilibrium} from './equilibrium';
import {standardBallast,AUTOMATIC_PROTOCOL,AUTOMATIC_WAVE_PRESETS,waveGenerationGain} from './automatic';

export type CfdRunMode = 'calm' | 'head-waves' | 'beam-waves';
export type CfdCgSource = 'measured' | 'cad-estimate';
export interface CfdCgEstimateSpec {
  distribution: 'material' | 'solid' | 'shell';
  payloads: {name:string;massKg:number;positionM:HydroPoint}[];
}

/** Physical values use SI with recorded CG provenance; geometry keeps the placed millimetre frame. */
export interface CfdRunRequest {
  name: string;
  /** Experiments only (never ranked): wave-maker zone length/strength and a factor on the calibrated gain. */
  waveGeneration?: { wavelengths?: number; strength?: number; gainScale?: number };
  trianglesMm: number[];
  geometryMode: CfdEnvelopeMode;
  mode: CfdRunMode;
  massKg: number;
  cgM: HydroPoint;
  cgSource: CfdCgSource;
  cgEstimate?: CfdCgEstimateSpec;
  cgAssumptions: string[];
  assumptionsConfirmed: boolean;
  /** Confirms total loaded mass; manual CG is confirmed only when cgSource is measured. */
  measurementsConfirmed: boolean;
  massSource:'measured'|'protocol-default';
  automation?:{schema:1;protocol:'standard-220-v1'};
  modelCgM?:HydroPoint;
  floatingPose?:{rollRad:number;pitchRad:number;rotation:Matrix3;translationM:HydroPoint;residualM:number};
  speedMps: number;
  minimumWallThicknessM?: number;
  waveHeightM?: number;
  wavePeriodS?: number;
  inertiaMeasured: boolean;
  inertiaKgM2?: HydroPoint;
  inertiaSource?:'measured'|'cad-estimate';
  inertiaTensorKgM2?:Matrix3;
  mesh: MeshLevel;
  fidelity: 'standard'|'quick';
  durationS?: number;
  timeStepS?: number;
  maxDeltaTS?:number;
  maxCo: number;
  maxCells: number;
  domainScale: number;
}

export interface PreparedCfdJob {
  request: CfdRunRequest;
  package: CfdCasePackage;
  hydro: CfdHydroState;
  geometryHash: string;
  protocolHash: string;
}

const MAX_TRIANGLES = 500_000;
const MAX_SOURCE_BYTES = 160 * 1024 * 1024;

function boundedNumber(value: unknown, label: string, min: number, max: number, includeMin = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (includeMin ? value < min : value <= min) || value > max) {
    throw new Error(`${label} must be a finite number ${includeMin ? 'from' : 'greater than'} ${min} ${includeMin ? 'to' : 'and at most'} ${max}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function vector(value: unknown, label: string, min: number, max: number, strictlyPositive = false): HydroPoint {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} requires three measured components.`);
  return value.map((v, i) => boundedNumber(v, `${label} ${['X', 'Y', 'Z'][i]}`, min, max, !strictlyPositive)) as HydroPoint;
}

function cleanName(value: unknown): string {
  if (value == null) return 'Hull CFD case';
  if (typeof value !== 'string') throw new Error('The design name must be text.');
  return value.replace(/[^\p{L}\p{N} ._()\-]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim() || 'Hull CFD case';
}

function checkedTriangles(value: unknown): Float32Array {
  if (!(Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array)) throw new Error('Provide the placed STL triangle coordinates in millimetres.');
  if (!value.length || value.length % 9 !== 0 || value.length > MAX_TRIANGLES * 9) throw new Error('CFD accepts 1–500,000 complete triangular faces. Export the STL at a coarser resolution.');
  const result = new Float32Array(value.length);
  let estimatedBytes = 2;
  for (let i = 0; i < value.length; i++) {
    const coordinate = boundedNumber(value[i], 'STL coordinate (mm)', -1_000_000, 1_000_000);
    result[i] = coordinate;
    estimatedBytes += String(coordinate).length + 1;
  }
  if (estimatedBytes > MAX_SOURCE_BYTES) throw new Error('The STL coordinate payload exceeds the 160 MB request limit. Export the STL at a coarser resolution.');
  return result;
}

/** Point loads are entered independently; hull mass is the remainder of total loaded mass. */
function checkedCgEstimate(value:unknown,totalMassKg:number):CfdCgEstimateSpec {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose an explicit CAD mass-distribution assumption before estimating CG.');
  const raw=value as Record<string,unknown>,distribution=raw.distribution as CfdCgEstimateSpec['distribution'];
  if(!['material','solid','shell'].includes(distribution))throw new Error('Choose material, uniform solid or uniform shell mass distribution.');
  const source=raw.payloads===undefined?[]:raw.payloads;
  if(!Array.isArray(source)||source.length>32)throw new Error('Provide at most 32 separate ballast or cargo components.');
  const payloads:CfdCgEstimateSpec['payloads']=[];
  for(let i=0;i<source.length;i++){
    const row=source[i];
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error(`Payload ${i+1} must contain its mass and location.`);
    const p=row as Record<string,unknown>,massKg=boundedNumber(p.massKg,`Payload ${i+1} mass (kg)`,0,5);
    // Empty zero-mass rows in the two optional UI components contribute nothing.
    if(massKg===0)continue;
    payloads.push({name:p.name===undefined?`Payload ${i+1}`:cleanName(p.name),massKg,positionM:vector(p.positionM,`Payload ${i+1} position (m)`,-1,1)});
  }
  const payloadMass=payloads.reduce((sum,p)=>sum+p.massKg,0);
  if(!(totalMassKg-payloadMass>0))throw new Error('Ballast and cargo masses must leave a positive hull mass within the entered total loaded mass.');
  return {distribution,payloads};
}

/** Stable JSON for physical protocol snapshots. Numerical mesh/time controls are excluded separately. */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A protocol hash cannot contain a non-finite number.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
  }
  throw new Error('Unsupported value in protocol snapshot.');
}

function float64Bytes(values: Float64Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, Object.is(values[i], -0) ? 0 : values[i], true);
  return bytes;
}

async function sha256(parts: Uint8Array[]): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 requires Web Crypto. Run the local CFD service with Node.js 22 or newer, or use a secure browser context.');
  const size = parts.reduce((n, part) => n + part.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', joined.buffer);
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
}

/** Validate an untrusted JSON request, then prepare an actual-geometry solver case. No solver is launched here. */
/** Experiment-only wave-maker overrides; undefined unless explicitly given for a wave test. */
function checkedWaveGeneration(v: unknown, mode: CfdRunMode): CfdRunRequest['waveGeneration'] {
  if (v === undefined || v === null || mode === 'calm') return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('waveGeneration must be an object.');
  const o = v as Record<string, unknown>, out: NonNullable<CfdRunRequest['waveGeneration']> = {};
  if (o.wavelengths !== undefined) out.wavelengths = boundedNumber(o.wavelengths, 'Wave-maker zone (wavelengths)', .5, 4, true);
  if (o.strength !== undefined) out.strength = boundedNumber(o.strength, 'Wave-maker strength', 0, 50, false);
  if (o.gainScale !== undefined) out.gainScale = boundedNumber(o.gainScale, 'Wave-maker gain scale', .5, 1.5, true);
  return Object.keys(out).length ? out : undefined;
}
export async function prepareCfdJob(body: unknown, caseId: string): Promise<PreparedCfdJob> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('A CFD request object is required.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(caseId)) throw new Error('Case ID must contain only letters, numbers, underscores and hyphens.');
  const raw = body as Record<string, unknown>;
  const auto=raw.automation as Record<string,unknown>|undefined;
  const automatic=!!auto&&auto.schema===1&&auto.protocol===AUTOMATIC_PROTOCOL;
  if(raw.automation!==undefined&&!automatic)throw new Error('Unsupported automatic test protocol.');
  const cgSource=(raw.cgSource===undefined?'measured':raw.cgSource) as CfdCgSource;
  if(!['measured','cad-estimate'].includes(cgSource))throw new Error('Choose measured CG or a CAD-based CG estimate.');
  if(automatic&&(cgSource!=='cad-estimate'||raw.measurementsConfirmed!==false))throw new Error('Automatic tests must retain CAD-estimated CG and unmeasured protocol-mass provenance.');
  if (!automatic&&raw.measurementsConfirmed !== true) throw new Error(cgSource==='measured'
    ? 'Confirm that total mass and three-dimensional CG are measured values. Geometry volume centroid is not mass CG.'
    : 'Confirm the entered measured total loaded mass. A CAD estimate does not measure hull, ballast or cargo weight.');
  if(cgSource==='cad-estimate'&&raw.assumptionsConfirmed!==true)throw new Error('Confirm the CAD mass-distribution assumptions. The calculated CG is an estimate, not a measurement.');
  const geometryMode = raw.geometryMode as CfdEnvelopeMode;
  if (!['closed-envelope', 'open-surface', 'printed-shell'].includes(geometryMode)) throw new Error('Choose closed-envelope, open-surface or printed-shell geometry deliberately.');
  const mode = raw.mode as CfdRunMode;
  if (!['calm', 'head-waves', 'beam-waves'].includes(mode)) throw new Error('Choose calm, head-waves or beam-waves testing.');
  const massKg = boundedNumber(raw.massKg, 'Measured total mass (kg)', 0, 5, false);
  if(automatic&&![.15,.25,.35].some(v=>Math.abs(v-massKg)<1e-12))throw new Error('Automatic standard loads are 150, 250 and 350 g.');
  const massSource=automatic?'protocol-default':'measured';
  let cgM:HydroPoint;
  const cgEstimate=cgSource==='cad-estimate'?checkedCgEstimate(raw.cgEstimate,massKg):undefined;
  const cgAssumptions:string[]=[],cgWarnings:string[]=[];
  let estimatedMassProperties:ReturnType<typeof estimateMassProperties>|undefined;
  const speedMps = boundedNumber(raw.speedMps, 'Speed (m/s)', 0, 5);
  if (mode !== 'calm' && speedMps !== 0) throw new Error('Wave cases currently require zero forward speed. The pinned native Stokes-I boundary has no verified mean-current coupling.');
  const mesh = (raw.mesh ?? 'coarse') as MeshLevel;
  if (!['coarse', 'medium', 'fine'].includes(mesh)) throw new Error('Choose coarse, medium or fine mesh.');
  const fidelity=(raw.fidelity??'standard') as 'standard'|'quick';
  if(!['standard','quick'].includes(fidelity))throw new Error('Choose standard or quick fidelity.');
  const maxCells = boundedNumber(raw.maxCells ?? 750_000, 'Maximum cells', 10_000, 20_000_000);
  if (!Number.isInteger(maxCells)) throw new Error('Maximum cells must be a whole number.');
  const domainScale = boundedNumber(raw.domainScale ?? 1, 'Domain scale', 1, 4);
  const maxCo = boundedNumber(raw.maxCo ?? 0.25, 'Courant limit', 0.01, fidelity==='quick'?1:0.5);
  const durationS = raw.durationS === undefined ? undefined : boundedNumber(raw.durationS, 'Run duration (s)', 0.01, 600);
  const timeStepS = raw.timeStepS === undefined ? undefined : boundedNumber(raw.timeStepS, 'Initial time step (s)', 1e-7, 0.01);
  const maxDeltaTS=raw.maxDeltaTS===undefined?undefined:boundedNumber(raw.maxDeltaTS,'Maximum time step (s)',1e-7,.01);
  const minimumWallThicknessM = geometryMode === 'printed-shell'
    ? boundedNumber(raw.minimumWallThicknessM, 'Measured minimum printed wall thickness (m)', 0, 0.05, false) : undefined;
  const waveHeightM = mode === 'calm' ? undefined : boundedNumber(raw.waveHeightM, 'Crest-to-trough wave height (m)', 0, 0.1, false);
  const wavePeriodS = mode === 'calm' ? undefined : boundedNumber(raw.wavePeriodS, 'Wave period (s)', 0.1, 5);
  let inertiaKgM2: HydroPoint | undefined;
  const inertiaSource=mode==='beam-waves'?(raw.inertiaSource??'measured') as 'measured'|'cad-estimate':undefined;
  if(inertiaSource&&!['measured','cad-estimate'].includes(inertiaSource))throw new Error('Choose measured or CAD-estimated inertia.');
  if(inertiaSource==='cad-estimate'&&cgSource!=='cad-estimate')throw new Error('CAD inertia requires the same stated CAD CG and mass distribution.');
  if (mode === 'beam-waves') {
    if(inertiaSource==='measured'){
      if (raw.inertiaMeasured !== true) throw new Error('Beam-wave motion requires measured or explicitly CAD-estimated moments of inertia.');
      inertiaKgM2 = vector(raw.inertiaKgM2, 'Principal inertia (kg m²)', 0, 1, true);
      const largest = Math.max(...inertiaKgM2), sum = inertiaKgM2.reduce((a, b) => a + b, 0);
      if (2 * largest > sum + Math.max(1e-14, largest * 1e-8)) throw new Error('Principal moments of inertia violate the physical triangle inequalities. Check units and measured values.');
    }
  }
  const triangles = checkedTriangles(raw.trianglesMm);
  const hull = prepareCfdHull(triangles, geometryMode);
  if(automatic){
    if(mode==='head-waves'||Math.abs(speedMps-(mode==='calm'?.3:0))>1e-12)throw new Error('The automatic protocol uses 0.30 m/s calm towing and zero-speed beam waves.');
    if(cgEstimate?.distribution!==(geometryMode==='printed-shell'?'material':'shell'))throw new Error('Automatic standard loads follow the uniform CAD distribution plus the standard ballast. Use advanced settings for a different physical protocol.');
    // The server recomputes the standard ballast; supplied payloads cannot change the competition load rule.
    cgEstimate.payloads=[standardBallast(hull,massKg)];
    if(mode==='beam-waves'){
      const scale=hull.bounds.lengthM/.22;
      if(inertiaSource!=='cad-estimate'||!AUTOMATIC_WAVE_PRESETS.some(w=>Math.abs(w.height*scale-waveHeightM!)<1e-10&&Math.abs(w.period*Math.sqrt(scale)-wavePeriodS!)<1e-10))throw new Error('The automatic protocol requires its length-scaled regular waves and CAD inertia.');
    }
  }
  if(cgSource==='cad-estimate'&&cgEstimate){
    const payloadMassKg=cgEstimate.payloads.reduce((sum,p)=>sum+p.massKg,0);
    estimatedMassProperties=estimateMassProperties({trianglesMm:triangles,geometryMode,distribution:cgEstimate.distribution,hullMassKg:massKg-payloadMassKg,payloads:cgEstimate.payloads,preparedHull:hull});
    cgM=[...estimatedMassProperties.cgM] as HydroPoint;
    if(!cgM.every(Number.isFinite))throw new Error('The CAD mass-distribution calculation did not produce a finite CG.');
    if(Math.abs(estimatedMassProperties.massKg-massKg)>Math.max(1e-10,massKg*1e-9))throw new Error('CAD component masses do not match the entered total loaded mass.');
    cgAssumptions.push(...estimatedMassProperties.assumptions);
    cgWarnings.push('Centre of gravity was estimated from CAD and the stated mass-distribution assumptions; it was not measured.',...estimatedMassProperties.warnings);
    if(raw.cgM!==undefined){
      const supplied=vector(raw.cgM,'Preview CAD CG (m)',-2,2);
      if(Math.hypot(...supplied.map((v,i)=>v-cgM[i]))>1e-6)cgWarnings.push('The supplied preview CG differed from the server recomputation and was replaced by the recomputed CAD estimate.');
    }
  }else cgM=vector(raw.cgM,'Measured CG (m)',-2,2);
  // This matches the pinned solver's transportProperties; no silent rho mismatch.
  const modelCgM=[...cgM] as HydroPoint;
  const pose:FloatingEquilibrium|undefined=automatic?solveFloatingEquilibrium(hull,{massKg,cgM,densityKgM3:998,gravityMps2:9.81}):undefined;
  const solverHull=pose?.hull??hull;
  cgM=pose?.cgM??cgM;
  const hydro = pose?.hydro??computeHydrostatics(hull, { massKg, cgM, densityKgM3: 998, gravityMps2: 9.81, requireStable: mode === 'beam-waves' });
  if (!automatic&&mode === 'beam-waves' && (hydro.flags.includes('unbalanced-upright-roll') || hydro.flags.includes('unbalanced-upright-pitch'))) {
    throw new Error('The specified CG does not balance the upright hull. Solve or measure the equilibrium list/trim before a free-motion wave run; a CAD CG estimate does not solve floating equilibrium.');
  }
  const floatingPose=pose?{rollRad:pose.rollRad,pitchRad:pose.pitchRad,rotation:pose.rotation,translationM:pose.translationM,residualM:pose.residualM}:undefined;
  let inertiaTensorKgM2:Matrix3|undefined;
  if(inertiaSource==='cad-estimate'){
    if(!estimatedMassProperties)throw new Error('CAD inertia could not be computed from the selected mass distribution.');
    const tensor=estimatedMassProperties.inertiaTensorKgM2,R=pose?.rotation??[[1,0,0],[0,1,0],[0,0,1]];
    inertiaTensorKgM2=R.map(row=>R.map(col=>row.reduce((s,x,i)=>s+x*col.reduce((t,y,j)=>t+tensor[i][j]*y,0),0))) as Matrix3;
    inertiaKgM2=[inertiaTensorKgM2[0][0],inertiaTensorKgM2[1][1],inertiaTensorKgM2[2][2]];
  }
  const request: CfdRunRequest = {
    name: cleanName(raw.name), trianglesMm: Array.from(triangles), geometryMode, mode,
    massKg, cgM, cgSource, cgEstimate, cgAssumptions, assumptionsConfirmed:cgSource==='cad-estimate', measurementsConfirmed: !automatic,massSource,automation:automatic?{schema:1,protocol:'standard-220-v1'}:undefined,modelCgM,floatingPose,speedMps, minimumWallThicknessM,
    waveHeightM, wavePeriodS, inertiaMeasured: mode === 'beam-waves'&&inertiaSource==='measured', inertiaKgM2,inertiaSource,inertiaTensorKgM2,
    mesh, fidelity, durationS, timeStepS,maxDeltaTS, maxCo, maxCells, domainScale,
    waveGeneration: checkedWaveGeneration(raw.waveGeneration, mode),
  };
  const encoder = new TextEncoder();
  const geometryHash = await sha256([
    encoder.encode(canonical({ schema: 1, geometryMode, solverKind: hull.solverGeometryKind, solverVirtualCap: hull.virtualCap, displacementVirtualCap: hull.displacementVirtualCap, solverVertices: hull.solverTrianglesM.length, envelopeVertices: hull.trianglesM.length })),
    float64Bytes(hull.solverTrianglesM), float64Bytes(hull.trianglesM),
  ]);
  const physicalProtocol = {
    schema: 1, mode, massKg,massSource, cgM,modelCgM,floatingPose, cgSource, cgEstimate, cgAssumptions, assumptionsConfirmed:cgSource==='cad-estimate', measurementsConfirmed: !automatic,
    inertiaKgM2,inertiaTensorKgM2,inertiaSource, inertiaMeasured: request.inertiaMeasured, speedMps,
    wave: mode === 'calm' ? { kind: 'calm' } : { kind: mode, heightM: waveHeightM, periodS: wavePeriodS },
    physics: { rhoWaterKgM3: 998, rhoAirKgM3: 1.2, nuWaterM2S: 1.004e-6, nuAirM2S: 1.5e-5, gravityMps2: 9.81, sigmaNpm: 0.072, flow: 'laminar', contactAngleDeg: 90 },
    domain: { scale: domainScale, upstreamLengths: 2, downstreamLengths: 5, sideLengths: 3, belowKeelLengths: 3 },
    minimumWallThicknessM,
    ...(request.waveGeneration ? { waveGeneration: request.waveGeneration } : {}),
  };
  let protocolHash = await sha256([encoder.encode(canonical(physicalProtocol))]);
  const sealPrinted = automatic && hull.solverGeometryKind === 'printed-material';
  let pkg = generateOpenFoamCase({
    // Automatic tests seal an open printed hull at its rim (virtual lid) for CFD: the flow only touches the outside while
    // the hull floats dry, and resolving both faces of thin printed walls cost millions of cells. Mass and CG still use
    // the real walls. Rim immersion is flagged per run from the measured motion.
    caseId, trianglesMm: (sealPrinted ? solverHull.trianglesM : solverHull.solverTrianglesM).map(v => v * 1000),geometryIsPosed:automatic,
    dryEnvelopeTrianglesMm: !sealPrinted && hull.solverGeometryKind === 'printed-material' ? solverHull.trianglesM.map(v => v * 1000) : undefined,
    sourceHash: geometryHash, protocolKey: protocolHash,
    load: { massKg,massSource,massMeasured:!automatic,modelCgM, draftM: hydro.draftM, cgM, cgMeasured:cgSource==='measured', cgSource, cgAssumptions, cgAssumptionsConfirmed:cgSource==='cad-estimate' },
    speedMps, geometryKind: sealPrinted ? 'sealed-envelope' : hull.solverGeometryKind, minimumWallThicknessM: sealPrinted ? undefined : minimumWallThicknessM,
    mesh, fidelity, durationS, timeStepS,maxDeltaTS, maxCo, maxCells, domainScale,
  });
  const preset=automatic&&mode==='beam-waves'?AUTOMATIC_WAVE_PRESETS.find(w=>{const scale=hull.bounds.lengthM/.22;return Math.abs(w.height*scale-waveHeightM!)<1e-10&&Math.abs(w.period*Math.sqrt(scale)-wavePeriodS!)<1e-10;}):undefined;
  const wg=request.waveGeneration;
  const generationGain=(preset?waveGenerationGain(preset,fidelity,mesh):1)*(wg?.gainScale??1);
  if (mode !== 'calm') pkg = extendCaseWithWaves(pkg, { kind: mode, generationGain, generationWavelengths: wg?.wavelengths, generationStrength: wg?.strength, heightM: waveHeightM!, periodS: wavePeriodS!, massKg, cgM, inertiaKgM2,inertiaTensorKgM2,inertiaSource,inertiaAssumptions:estimatedMassProperties?.assumptions,rollAxis:pose?pose.rotation.map(row=>row[0]) as HydroPoint:undefined,inertiaMeasured: request.inertiaMeasured });
  // Different observation windows or boundaries must never compare as one protocol.
  const recordedProtocol = {...physicalProtocol,observation:{durationS:pkg.manifest.numerics.durationS,averaging:pkg.manifest.condition.kind==='calm'?'after-warmup':'final-half-after-warmup'},fidelity,exactDomain:{minM:pkg.manifest.domain.minM,maxM:pkg.manifest.domain.maxM}};
  protocolHash = await sha256([encoder.encode(canonical(recordedProtocol))]);
  pkg.manifest.protocolKey = protocolHash;
  request.durationS = pkg.manifest.numerics.durationS;
  request.timeStepS = pkg.manifest.numerics.initialDeltaTS;
  pkg.manifest.notes = [...new Set([...pkg.manifest.notes, ...hull.notes, ...hydro.warnings, ...cgWarnings])];
  if(automatic)pkg.manifest.notes.push('Automatic standard comparison: total loads are imposed protocol defaults, not measured ship weights. All mass follows the declared CAD distribution. No unlisted ballast or cargo placement is inferred.');
  if(pose){pkg.manifest.notes.push('Initial dry floating roll/trim was solved from the stated CAD mass distribution; the original model remains unchanged. This is a hydrostatic initial pose, not a verified free-motion response.');pkg.files['floating-pose.json']=JSON.stringify(floatingPose,null,2)+'\n';}
  if(estimatedMassProperties)pkg.files['cg-estimate.json']=JSON.stringify({...estimatedMassProperties,modelCgM,solverPlacedCgM:cgM,floatingPose,totalLoadedMassConfirmed:!automatic,massSource,assumptionsConfirmed:true,recomputedByService:true},null,2)+'\n';
  pkg.files['hydrostatics.json'] = JSON.stringify(hydro, null, 2) + '\n';
  const { trianglesMm: omitted, ...summary } = request;
  void omitted;
  pkg.files['request.json'] = JSON.stringify({ ...summary, geometryHash, protocolHash, physicalProtocol:recordedProtocol }, null, 2) + '\n';
  pkg.files['manifest.json'] = JSON.stringify(pkg.manifest, null, 2) + '\n';
  return { request, package: pkg, hydro, geometryHash, protocolHash };
}
