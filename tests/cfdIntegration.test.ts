import {describe,it,expect} from 'vitest';
import {boxHull} from '../src/engine/example';
import {prepareCfdJob} from '../src/cfd/request';
import {generateOpenFoamCase} from '../src/cfd/case';
import {extendCaseWithWaves,regularWaveLength} from '../src/cfd/waves';

const input=()=>({name:'Box',trianglesMm:Array.from(boxHull(200,60,40)),geometryMode:'closed-envelope',mode:'calm',massKg:.23952,cgM:[.1,0,.015],measurementsConfirmed:true,speedMps:.3,mesh:'coarse',durationS:5,timeStepS:.0005});
const base=()=>generateOpenFoamCase({caseId:'wave-base',trianglesMm:boxHull(200,60,40),sourceHash:'a'.repeat(64),protocolKey:'test',load:{massKg:.23952,draftM:.02,cgM:[.1,0,.015],cgMeasured:true},speedMps:0,maxCells:5000000});
describe('Measured input to versioned CFD case',()=>{
  it('uses exact mesh hydrostatics and separately snapshots measured input',async()=>{
    const p=await prepareCfdJob(input(),'box-a');expect(p.hydro.draftM).toBeCloseTo(.02,9);expect(p.package.manifest.load.cgMeasured).toBe(true);expect(p.geometryHash).toMatch(/^[a-f0-9]{64}$/);expect(p.package.manifest.protocolKey).toBe(p.protocolHash);
  });
  it('gives different jobs on the same physical mesh the same provenance hashes',async()=>{
    const a=await prepareCfdJob(input(),'a'),b=await prepareCfdJob(input(),'b');expect(a.geometryHash).toBe(b.geometryHash);expect(a.protocolHash).toBe(b.protocolHash);
  });
  it('allows numerical mesh/time refinement while retaining identical physical protocol',async()=>{
    const a=await prepareCfdJob(input(),'a'),b=await prepareCfdJob({...input(),mesh:'medium',timeStepS:.00025},'b');expect(a.protocolHash).toBe(b.protocolHash);expect(a.geometryHash).toBe(b.geometryHash);expect(a.package.manifest.mesh.finestCellM).toBeGreaterThan(b.package.manifest.mesh.finestCellM);
  });
  it('does not confuse different CG, load, speed or observation window with one protocol',async()=>{
    const a=await prepareCfdJob(input(),'a');for(const patch of [{cgM:[.1,0,.016]},{massKg:.25},{speedMps:.4},{durationS:10}]){const b=await prepareCfdJob({...input(),...patch},'b');expect(b.protocolHash).not.toBe(a.protocolHash);}
  });
  it('rejects unconfirmed mass and CG rather than using the preview volume centroid',async()=>{await expect(prepareCfdJob({...input(),measurementsConfirmed:false},'a')).rejects.toThrow(/measured/);});
  it('rejects overloading before meshing or invoking Docker',async()=>{await expect(prepareCfdJob({...input(),massKg:1},'a')).rejects.toThrow(/load|capacity|support/i);});
  it('blocks unverified towing current plus native regular waves',async()=>{await expect(prepareCfdJob({...input(),mode:'head-waves',waveHeightM:.01,wavePeriodS:1},'a')).rejects.toThrow(/zero forward speed/);});
  it('requires independent physical inertia for free roll',async()=>{await expect(prepareCfdJob({...input(),mode:'beam-waves',speedMps:0,waveHeightM:.01,wavePeriodS:1},'a')).rejects.toThrow(/inertia/);});
});
describe('Wave propagation and motion configuration',()=>{
  it('solves finite-depth dispersion rather than silently assuming infinitely deep water',()=>{
    const T=1,h=.05,L=regularWaveLength(T,h),k=2*Math.PI/L;expect(9.81*k*Math.tanh(k*h)).toBeCloseTo((2*Math.PI/T)**2,10);expect(L).toBeLessThan(9.81*T*T/(2*Math.PI));
  });
  it('refines the whole graded wave band, including the inlet',()=>{
    const p=extendCaseWithWaves(base(),{kind:'head-waves',heightM:.01,periodS:1});expect(p.manifest.waves.boundaryHeightCells).toBeGreaterThanOrEqual(6);expect(p.manifest.waves.boundaryWavelengthCells).toBeGreaterThanOrEqual(30);expect(String(p.files['system/blockMeshDict']).match(/hex /g)?.length).toBe(3);expect(p.manifest.waves.waveResolutionVerified).toBe(false);
  });
  it('refines propagation cells between coarse and medium',()=>{
    const a=extendCaseWithWaves(base(),{kind:'head-waves',heightM:.01,periodS:1});const b=base();b.manifest.mesh.level='medium';const m=extendCaseWithWaves(b,{kind:'head-waves',heightM:.01,periodS:1});expect(m.manifest.waves.boundaryHeightCells).toBeGreaterThan(a.manifest.waves.boundaryHeightCells);expect(m.manifest.waves.boundaryWavelengthCells).toBeGreaterThan(a.manifest.waves.boundaryWavelengthCells);
  });
  it('refuses a cell budget that cannot resolve global waves',()=>{
    const b=base();b.manifest.mesh.maxCells=10000;expect(()=>extendCaseWithWaves(b,{kind:'head-waves',heightM:.01,periodS:1})).toThrow(/requires/);
  });
  it('writes measured-inertia heave/roll constraints and unit-labelled state output',()=>{
    const p=extendCaseWithWaves(base(),{kind:'beam-waves',heightM:.01,periodS:1,inertiaMeasured:true,inertiaKgM2:[.0001,.0008,.00085]});expect(p.manifest.mode).toBe('free-motion');expect(p.manifest.motion?.degreesOfFreedom).toEqual(['heave-Z','roll-X']);expect(String(p.files['constant/dynamicMeshDict'])).toContain('mass 0.23952');expect(String(p.files['system/controlDict'])).toContain('angleFormat radians');expect(String(p.files['0/U'])).toContain('movingWallVelocity');
  });
});

describe('Calm towing outlet',()=>{
  it('uses a mass-conserving outlet with a wake absorber, and wave cases drop the absorber',()=>{
    const calm=base(),f=(n:string)=>String(calm.files[n]);
    expect(f('0/U')).toMatch(/outlet \{ type outletPhaseMeanVelocity; Umean [0-9.]+; alpha alpha\.water;/);
    expect(f('0/alpha.water')).toMatch(/outlet \{ type variableHeightFlowRate; lowerBound 0; upperBound 1;/);
    expect(f('0/p_rgh')).toMatch(/outlet \{ type zeroGradient; \}/);
    expect(f('system/fvOptions')).toMatch(/calmOutletAbsorber[\s\S]*acousticDampingSource[\s\S]*URef UTow;/);
    expect(f('0/UTow')).toMatch(/internalField uniform \(/);
    expect(f('system/controlDict')).toMatch(/calmTowReference[\s\S]*fields \(UTow\);/);
    const wave=extendCaseWithWaves(base(),{kind:'beam-waves',heightM:.01,periodS:1,inertiaMeasured:true,inertiaKgM2:[.0001,.0008,.00085]});
    expect(wave.files['0/UTow']).toBeUndefined();
    expect(String(wave.files['system/controlDict'])).not.toContain('UTow');
    expect(String(wave.files['system/fvOptions'])).not.toContain('calmOutletAbsorber');
  });
});

describe('Beam-wave morphing zone',()=>{
  it('ends inside the tank, so rolling never moves the end-wall cells',()=>{
    const p=extendCaseWithWaves(base(),{kind:'beam-waves',heightM:.01,periodS:.6,inertiaMeasured:true,inertiaKgM2:[.0001,.0008,.00085]});
    const outer=Number(/outerDistance ([0-9.eE+-]+);/.exec(String(p.files['constant/dynamicMeshDict']))![1]);
    const g=p.manifest.geometry,d=p.manifest.domain;
    const nearestEndWall=Math.min(g.minM[0]-d.minM[0],d.maxM[0]-g.maxM[0]);
    expect(outer).toBeGreaterThan(0);
    expect(outer).toBeLessThan(nearestEndWall);
  });
});
