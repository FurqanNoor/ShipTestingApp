import {describe,it,expect} from 'vitest';
import {boxHull} from '../src/engine/example';
import {prepareCfdJob} from '../src/cfd/request';

const base=()=>({name:'CG reference box',trianglesMm:Array.from(boxHull(200,60,40)),geometryMode:'closed-envelope',mode:'calm',massKg:.23952,cgM:[.1,0,.02],measurementsConfirmed:true,speedMps:.3,mesh:'coarse',durationS:5,timeStepS:.0005});
const cad=()=>({...base(),cgSource:'cad-estimate',cgEstimate:{distribution:'solid',payloads:[] as unknown[]},assumptionsConfirmed:true});

/** A single watertight wall-material basin, not a union of overlapping solids. */
function basin(L=200,B=60,D=40,t=2):number[] {
  const outer=[[0,-B/2],[L,-B/2],[L,B/2],[0,B/2]],inner=[[t,-B/2+t],[L-t,-B/2+t],[L-t,B/2-t],[t,B/2-t]];
  const ring=(ps:number[][],z:number)=>ps.map(p=>[p[0],p[1],z]);
  const ob=ring(outer,0),ot=ring(outer,D),ib=ring(inner,t),it=ring(inner,D),faces:number[]=[];
  const q=(a:number[],b:number[],c:number[],d:number[])=>faces.push(...a,...b,...c,...a,...c,...d);
  q(ob[3],ob[2],ob[1],ob[0]);q(ib[0],ib[1],ib[2],ib[3]);
  for(let j=0;j<4;j++){const k=(j+1)%4;q(ob[j],ob[k],ot[k],ot[j]);q(ib[j],it[j],it[k],ib[k]);q(ot[j],ot[k],it[k],it[j]);}
  return faces;
}

describe('CAD CG provenance at the service boundary',()=>{
  it('keeps existing measured-CG requests explicitly measured',async()=>{
    const p=await prepareCfdJob(base(),'measured-cg');
    expect(p.request.cgSource).toBe('measured');expect(p.package.manifest.load.cgMeasured).toBe(true);
    expect(p.request.assumptionsConfirmed).toBe(false);expect(p.package.files['cg-estimate.json']).toBeUndefined();
  });
  it('recomputes the known solid box centroid instead of accepting a stale preview value',async()=>{
    const p=await prepareCfdJob({...cad(),cgM:[0,0,0]},'cad-box');
    expect(p.request.cgM[0]).toBeCloseTo(.1,10);expect(p.request.cgM[1]).toBeCloseTo(0,10);expect(p.request.cgM[2]).toBeCloseTo(.02,10);
    expect(p.package.manifest.notes.some(n=>n.includes('supplied preview CG'))).toBe(true);
  });
  it('accepts omitted CG coordinates in CAD mode and never calls the result measured',async()=>{
    const p=await prepareCfdJob({...cad(),cgM:undefined},'cad-no-client-cg');
    expect(p.package.manifest.load.cgMeasured).toBe(false);expect(p.package.manifest.load.cgSource).toBe('cad-estimate');
    const estimate=JSON.parse(String(p.package.files['cg-estimate.json']));
    expect(estimate.source).toBe('cad-estimate');expect(estimate.recomputedByService).toBe(true);expect(estimate.assumptions.length).toBeGreaterThan(0);
    expect(p.request.cgAssumptions).toEqual(estimate.assumptions);
  });
  it('uses printed wall material CG rather than dry displacement-envelope CG',async()=>{
    const outerV=.2*.06*.04,innerV=.196*.056*.038,materialCgZ=(outerV*.02-innerV*.021)/(outerV-innerV);
    const p=await prepareCfdJob({...cad(),geometryMode:'printed-shell',trianglesMm:basin(),massKg:.08,minimumWallThicknessM:.002,cgEstimate:{distribution:'material'},cgM:undefined,maxCells:5000000},'printed-material-cg');
    expect(p.request.cgM[2]).toBeCloseTo(materialCgZ,9);
    expect(Math.abs(p.request.cgM[2]-.02)).toBeGreaterThan(.005);
    const estimate=JSON.parse(String(p.package.files['cg-estimate.json']));
    expect(estimate.materialVolumeM3).toBeCloseTo(outerV-innerV,11);
    expect(p.package.manifest.geometry.kind).toBe('printed-material');
  });
  it('combines hull and point cargo by their actual mass-weighted positions',async()=>{
    const p=await prepareCfdJob({...cad(),massKg:.3,cgM:undefined,cgEstimate:{distribution:'solid',payloads:[{name:'Cargo',massKg:.1,positionM:[.15,.01,.06]}]}},'loaded-cg');
    expect(p.request.cgM[0]).toBeCloseTo((.2*.1+.1*.15)/.3,10);
    expect(p.request.cgM[1]).toBeCloseTo(.1*.01/.3,10);
    expect(p.request.cgM[2]).toBeCloseTo((.2*.02+.1*.06)/.3,10);
    const estimate=JSON.parse(String(p.package.files['cg-estimate.json']));expect(estimate.hullMassKg).toBeCloseTo(.2,12);expect(estimate.payloadMassKg).toBeCloseTo(.1,12);
  });
  it('rejects payloads that use up or exceed the total loaded mass',async()=>{
    for(const massKg of [.23952,.3])await expect(prepareCfdJob({...cad(),cgEstimate:{distribution:'solid',payloads:[{massKg,positionM:[.1,0,.02]}]}},'bad-components')).rejects.toThrow(/positive hull mass/);
  });
  it('ignores zero-mass optional component rows without inventing their positions',async()=>{
    const p=await prepareCfdJob({...cad(),cgEstimate:{distribution:'solid',payloads:[{name:'Unused cargo',massKg:0}]}},'zero-cargo');
    expect(p.request.cgEstimate?.payloads).toEqual([]);expect(p.request.cgM[2]).toBeCloseTo(.02,10);
  });
  it('rejects nonfinite point-load coordinates and negative component mass',async()=>{
    await expect(prepareCfdJob({...cad(),cgEstimate:{distribution:'solid',payloads:[{massKg:.01,positionM:[NaN,0,.02]}]}},'bad-location')).rejects.toThrow(/finite/);
    await expect(prepareCfdJob({...cad(),cgEstimate:{distribution:'solid',payloads:[{massKg:-.01,positionM:[.1,0,.02]}]}},'bad-component-mass')).rejects.toThrow(/finite/);
  });
  it('still requires confirmation of measured total mass',async()=>{
    await expect(prepareCfdJob({...cad(),measurementsConfirmed:false},'unconfirmed-mass')).rejects.toThrow(/measured total loaded mass/);
  });
  it('requires explicit mass-distribution assumptions to be acknowledged',async()=>{
    await expect(prepareCfdJob({...cad(),assumptionsConfirmed:false},'unconfirmed-cad')).rejects.toThrow(/mass-distribution assumptions/);
    await expect(prepareCfdJob({...cad(),cgEstimate:undefined},'missing-distribution')).rejects.toThrow(/mass-distribution assumption/);
  });
  it('does not silently mix measured and estimated protocols when CG happens to match',async()=>{
    const a=await prepareCfdJob(base(),'measured'),b=await prepareCfdJob(cad(),'cad');
    expect(a.geometryHash).toBe(b.geometryHash);expect(a.protocolHash).not.toBe(b.protocolHash);
    const recorded=JSON.parse(String(b.package.files['request.json']));
    expect(recorded.physicalProtocol.cgSource).toBe('cad-estimate');expect(recorded.physicalProtocol.cgEstimate.distribution).toBe('solid');
  });
  it('retains matching CAD physical provenance across mesh and time-step refinement',async()=>{
    const a=await prepareCfdJob(cad(),'coarse'),b=await prepareCfdJob({...cad(),mesh:'medium',timeStepS:.00025},'medium');
    expect(a.geometryHash).toBe(b.geometryHash);expect(a.protocolHash).toBe(b.protocolHash);
  });
  it('records distribution choice even when symmetric shell and solid centroids coincide',async()=>{
    const a=await prepareCfdJob(cad(),'solid'),b=await prepareCfdJob({...cad(),cgEstimate:{distribution:'shell'}},'shell');
    expect(a.request.cgM[0]).toBeCloseTo(b.request.cgM[0],10);expect(a.request.cgM[2]).toBeCloseTo(b.request.cgM[2],10);expect(a.protocolHash).not.toBe(b.protocolHash);
  });
  it('does not infer or relabel inertia when only CG estimation was requested',async()=>{
    await expect(prepareCfdJob({...cad(),mode:'beam-waves',speedMps:0,waveHeightM:.01,wavePeriodS:1,maxCells:5000000},'missing-inertia')).rejects.toThrow(/inertia/);
  });
});
