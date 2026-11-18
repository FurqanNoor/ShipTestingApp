/** Reproducible, unattended comparison protocol. CAD assumptions are never measurements. */
import {prepareCfdHull,type CfdEnvelopeMode,type CfdHull,type CfdPoint} from './geometry';
import type {MassDistribution} from './massProperties';

export const AUTOMATIC_PROTOCOL='standard-220-v1' as const;
/** Detailed CAD exports are commonly 100k-500k triangles. */
export const MAX_CAD_TRIANGLES=500_000;
/**
 * gain: wave-maker amplitude gain per grid, from 2D empty-tank calibration of the generated wave cases (achieved/target
 * height at the hull gauges without gain: quick low 0.69, medium 0.74, high 0.79; Full coarse grid 0.91, 0.935, 0.94). Each run still measures the wave it got.
 */
// quick gains recalibrated 2026-11-19 on 3D hull runs with incident/reflected separation (the 2D empty-tank values
// 1/.74 and 1/.79 gave incident waves 12-17% high in 3D): medium 1/.861, high 1/.910, with GEN_STRENGTH 12.
export const AUTOMATIC_WAVE_PRESETS=[{id:'medium',label:'Medium',height:.0073,period:.45,gain:{quick:1/.861,standard:1/.935}},{id:'high',label:'High',height:.012,period:.6,gain:{quick:1/.910,standard:1/.94}}] as const;
/**
 * Wave-maker gain for a grid. Medium and fine grids refine the coarse one by sqrt(2) each; the generated wave's
 * numerical damping is second order in cell size, so the coarse height deficit (1 - g) halves per level.
 */
export function waveGenerationGain(preset:(typeof AUTOMATIC_WAVE_PRESETS)[number],fidelity:'quick'|'standard',mesh:'coarse'|'medium'|'fine'='coarse'):number{
  const deficit=1-1/preset.gain[fidelity];
  return 1/(1-deficit/(mesh==='coarse'?1:mesh==='medium'?2:4));
}
export interface AutomaticPlanInput {name?:string;trianglesMm:number[]|Float32Array}
/** Competition load rule: half of each test mass is compact ballast placed low on the centreline. */
export const BALLAST_FRACTION=.5,BALLAST_HEIGHT_FRACTION=.1;
export interface StandardBallast {name:string;massKg:number;positionM:[number,number,number]}
/**
 * Standard ballast for every hull: BALLAST_FRACTION of the test mass as a compact weight on the centreline (y=0),
 * lengthwise at the centroid of the hull's displacement envelope (so the hull floats near level), with its centre
 * BALLAST_HEIGHT_FRACTION of the hull depth above the lowest hull surface at that station (just above the inside
 * bottom). If no hull surface lies under that point (e.g. between catamaran hulls), the lowest point of the hull is used.
 * The remaining mass follows the uniform CAD distribution (hull skin including deck, or printed material).
 */
export function standardBallast(hull:CfdHull,massKg:number):StandardBallast{
  const t=hull.trianglesM,[cx]=hull.centroidM,depth=hull.bounds.maxM[2]-hull.bounds.minM[2];
  let zLow=Infinity;
  for(let i=0;i<t.length;i+=9){
    // Vertical line x=cx, y=0 against the triangle (2D barycentric test in x-y, then interpolate z).
    const ax=t[i],ay=t[i+1],bx=t[i+3],by=t[i+4],qx=t[i+6],qy=t[i+7];
    const det=(by-qy)*(ax-qx)+(qx-bx)*(ay-qy);if(Math.abs(det)<1e-18)continue;
    const l1=((by-qy)*(cx-qx)+(qx-bx)*(0-qy))/det,l2=((qy-ay)*(cx-qx)+(ax-qx)*(0-qy))/det,l3=1-l1-l2;
    if(l1<-1e-12||l2<-1e-12||l3<-1e-12)continue;
    zLow=Math.min(zLow,l1*t[i+2]+l2*t[i+5]+l3*t[i+8]);
  }
  if(!Number.isFinite(zLow))zLow=hull.bounds.minM[2];
  return {name:'Standard ballast (50% of test load)',massKg:BALLAST_FRACTION*massKg,positionM:[cx,0,zLow+BALLAST_HEIGHT_FRACTION*depth]};
}

export interface AutomaticRequest {
  name:string;trianglesMm:number[];geometryMode:CfdEnvelopeMode;
  mode:'calm'|'beam-waves';massKg:number;speedMps:number;
  cgSource:'cad-estimate';cgEstimate:{distribution:MassDistribution;payloads:StandardBallast[]};
  /** Standard imposed test masses are not measurements of a physical ship. */
  measurementsConfirmed:false;assumptionsConfirmed:true;
  automation:{schema:1;protocol:typeof AUTOMATIC_PROTOCOL};
  inertiaSource?:'cad-estimate';
  minimumWallThicknessM?:number;waveHeightM?:number;wavePeriodS?:number;
  mesh:'coarse';fidelity?:'standard'|'quick';maxCells:number;maxCo:number;domainScale:number;durationS:number;
}
export interface AutomaticCondition {
  id:string;label:string;massKg:number;mode:'calm'|'beam-waves';
  waveHeightM?:number;wavePeriodS?:number;request:AutomaticRequest;
}
export interface AutomaticPlan {
  schema:1;protocol:typeof AUTOMATIC_PROTOCOL;name:string;
  geometryMode:CfdEnvelopeMode;distribution:MassDistribution;
  minimumWallThicknessM?:number;geometryNotes:string[];assumptions:string[];
  defaults:{loadsKg:[number,number,number];speedMps:number;maxCells:number;mesh:'coarse'};
  conditions:AutomaticCondition[];
}

const sub=(a:CfdPoint,b:CfdPoint):CfdPoint=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a:CfdPoint,b:CfdPoint)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:CfdPoint,b:CfdPoint):CfdPoint=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
interface Facet {a:CfdPoint;b:CfdPoint;c:CfdPoint;normal:CfdPoint;centre:CfdPoint;area:number}

/** The least observed normal thickness is a resolution hint, not a certified global minimum. */
export function inferPrintedWallResolution(hull:CfdHull):{minimumWallThicknessM:number;sampledMinimumM:number;sampleCount:number;hitCount:number;notes:string[]} {
  if(hull.mode!=='printed-shell')throw new Error('Wall resolution inference requires actual printed-material geometry.');
  const triangles=hull.solverTrianglesM,facets:Facet[]=[];
  for(let i=0;i<triangles.length;i+=9){
    const a:CfdPoint=[triangles[i],triangles[i+1],triangles[i+2]],b:CfdPoint=[triangles[i+3],triangles[i+4],triangles[i+5]],c:CfdPoint=[triangles[i+6],triangles[i+7],triangles[i+8]];
    const n=cross(sub(b,a),sub(c,a)),length=Math.hypot(...n);if(!(length>0))continue;
    facets.push({a,b,c,normal:n.map(v=>v/length) as CfdPoint,centre:a.map((v,k)=>(v+b[k]+c[k])/3) as CfdPoint,area:length/2});
  }
  const sampleIds=new Set<number>(),count=Math.min(256,facets.length);
  // Area-stratified samples avoid facet-count bias from arbitrary CAD tessellation.
  const totalArea=facets.reduce((sum,f)=>sum+f.area,0);let cursor=0,cumulative=facets[0]?.area??0;
  for(let i=0;i<count;i++){
    const target=totalArea*(i+.5)/count;
    while(cursor<facets.length-1&&cumulative<target)cumulative+=facets[++cursor].area;
    sampleIds.add(cursor);
  }
  // Include the largest individual faces and first/last facets to retain flat wall pairs.
  facets.map((f,i)=>({area:f.area,i})).sort((a,b)=>b.area-a.area).slice(0,24).forEach(p=>sampleIds.add(p.i));
  if(facets.length){sampleIds.add(0);sampleIds.add(facets.length-1);}
  const span=Math.max(hull.bounds.lengthM,hull.bounds.beamM,hull.bounds.depthM),eps=span*1e-8;
  const distances:number[]=[];
  for(const id of sampleIds){
    const source=facets[id],direction=source.normal.map(v=>-v) as CfdPoint;
    let nearest=Infinity;
    for(let j=0;j<facets.length;j++){
      if(j===id)continue;const f=facets[j];
      // Same wall's opposite side must face back toward the ray, approximately parallel.
      if(dot(source.normal,f.normal)>-.7)continue;
      const edge1=sub(f.b,f.a),edge2=sub(f.c,f.a),p=cross(direction,edge2),det=dot(edge1,p);
      if(Math.abs(det)<1e-16)continue;
      const inv=1/det,tvec=sub(source.centre,f.a),u=dot(tvec,p)*inv;
      if(u< -1e-9||u>1+1e-9)continue;
      const q=cross(tvec,edge1),v=dot(direction,q)*inv;
      if(v< -1e-9||u+v>1+1e-9)continue;
      const distance=dot(edge2,q)*inv;
      if(distance>eps*10&&distance<nearest)nearest=distance;
    }
    if(Number.isFinite(nearest))distances.push(nearest);
  }
  if(distances.length<3)throw new Error('The CAD walls do not provide enough opposing-surface thickness samples. Export a clean closed printed solid or use expert settings with a verified minimum wall thickness.');
  const sampledMinimumM=Math.min(...distances),minimumWallThicknessM=sampledMinimumM*.8;
  if(!(minimumWallThicknessM>span*1e-6))throw new Error('The inferred wall scale is too small or ambiguous for automatic meshing. Repair near-coincident CAD surfaces or enter a verified wall thickness in expert settings.');
  return {minimumWallThicknessM,sampledMinimumM,sampleCount:sampleIds.size,hitCount:distances.length,notes:[
    `Printed-wall resolution length is 80% of the least observed inward-normal opposing-surface distance (${(sampledMinimumM*1000).toPrecision(4)} mm, ${distances.length}/${sampleIds.size} sample hits).`,
    'Sampled wall thickness is not a certified minimum: thin features between samples can be missed. Inspect actual wall cells and refine the mesh; no achieved wall resolution is implied.',
  ]};
}

function detectGeometry(triangles:Float32Array):CfdHull {
  const errors:string[]=[];
  // A closed printed wall solid can also be closed as a material envelope; preserve its cavity first.
  for(const mode of ['printed-shell','open-surface','closed-envelope'] as const){
    try{return prepareCfdHull(triangles,mode);}catch(error){errors.push(`${mode}: ${(error as Error).message}`);}
  }
  throw new Error('Automatic hull preparation failed. Check STL units, axes and closure; supported open hulls need a continuous horizontal top rim. '+errors.join(' '));
}

/** Nine identical physical conditions (3 masses x calm, medium and high waves) for every design up to 250 x 250 x 250 mm. */
export function createAutomaticPlan(input:AutomaticPlanInput):AutomaticPlan {
  if(!input||!(Array.isArray(input.trianglesMm)||input.trianglesMm instanceof Float32Array)||!input.trianglesMm.length||input.trianglesMm.length%9||input.trianglesMm.length>MAX_CAD_TRIANGLES*9)throw new Error(`Provide 1–${MAX_CAD_TRIANGLES.toLocaleString('en-GB')} complete CAD triangles for automatic testing. Export the STL at a coarser resolution.`);
  if(Array.from(input.trianglesMm).some(v=>!Number.isFinite(v)||Math.abs(v)>1e6))throw new Error('CAD coordinates must be finite millimetres within the supported range.');
  const triangles=new Float32Array(input.trianglesMm),hull=detectGeometry(triangles),name=typeof input.name==='string'?input.name.slice(0,80):'Hull automatic tests';
  const geometryMode=hull.mode,distribution:MassDistribution=geometryMode==='printed-shell'?'material':'shell';
  const inferred=geometryMode==='printed-shell'?inferPrintedWallResolution(hull):undefined;
  const geometryNotes=[...hull.notes,...(inferred?.notes??[])];
  if(geometryMode==='closed-envelope')geometryNotes.push('No supported printed cavity or open rim was identified. Automatic testing assumes this closed STL is the complete exterior and its facets represent a uniform physical shell. Hidden construction cannot be inferred from topology.');
  const assumptions=[
    '150 g, 250 g and 350 g are imposed total test masses, not measured masses inferred from the STL.',
    'Load rule (same for every hull): half of each test mass is a compact ballast weight on the centreline, lengthwise at the hull\'s volume centre, centred 10% of the hull depth above the lowest hull surface there; the other half is spread uniformly over the hull (skin including deck, or printed material).',
    'The spread half follows the same uniform CAD material or shell distribution for every design. Real infill, equipment or cargo positions are not inferred from the STL.',
    'CG and full inertia are CAD estimates for that declared distribution. Different real mass placement can change rolling response and stability.',
    'Calm towing uses 0.30 m/s in fresh water; regular beam waves use zero forward speed.',
    'Regular wave height scales with hull length and period with its square root relative to 220 mm. The protocol is a model-scale comparison, not an irregular sea or an experimentally calibrated load.',
    'Automatic settings and numerical checks do not establish physical accuracy or validated competition placements.',
  ];
  const defaults={loadsKg:[.15,.25,.35] as [number,number,number],speedMps:.3,maxCells:5_000_000,mesh:'coarse' as const};
  const lengthRatio=hull.bounds.lengthM/.22,periodRatio=Math.sqrt(lengthRatio);
  const waves=AUTOMATIC_WAVE_PRESETS;
  const shared={name,trianglesMm:Array.from(triangles),geometryMode,cgSource:'cad-estimate' as const,measurementsConfirmed:false as const,assumptionsConfirmed:true as const,automation:{schema:1 as const,protocol:AUTOMATIC_PROTOCOL},mesh:defaults.mesh,maxCells:defaults.maxCells,maxCo:.3,domainScale:1,...(inferred?{minimumWallThicknessM:inferred.minimumWallThicknessM}:{})};
  const conditions:AutomaticCondition[]=[];
  for(const massKg of defaults.loadsKg){
    const grams=Math.round(massKg*1000),cgEstimate={distribution,payloads:[standardBallast(hull,massKg)]};
    const calm:AutomaticRequest={...shared,cgEstimate,name:`${name} · ${grams} g · calm`,mode:'calm',massKg,speedMps:defaults.speedMps,durationS:Math.max(10,20*hull.bounds.lengthM/defaults.speedMps)};
    conditions.push({id:`${grams}g-calm`,label:`${grams} g · Calm water`,massKg,mode:'calm',request:calm});
    for(const w of waves){
      const waveHeightM=w.height*lengthRatio,wavePeriodS=w.period*periodRatio;
      const request:AutomaticRequest={...shared,cgEstimate,name:`${name} · ${grams} g · ${w.label} waves`,mode:'beam-waves',massKg,speedMps:0,waveHeightM,wavePeriodS,inertiaSource:'cad-estimate',durationS:30*wavePeriodS};
      conditions.push({id:`${grams}g-${w.id}`,label:`${grams} g · ${w.label} beam waves`,massKg,mode:'beam-waves',waveHeightM,wavePeriodS,request});
    }
  }
  return {schema:1,protocol:AUTOMATIC_PROTOCOL,name,geometryMode,distribution,...(inferred?{minimumWallThicknessM:inferred.minimumWallThicknessM}:{}),geometryNotes,assumptions,defaults,conditions};
}
