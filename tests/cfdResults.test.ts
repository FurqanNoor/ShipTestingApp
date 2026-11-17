import { describe,expect,it } from 'vitest';
import { compareRefinements,parseForceData,parseMotionData,summarizeForces,type ForceSeries,type RefinementRun } from '../src/cfd/results';

// Format fixtures follow the verified OpenCFD v2312 writer. They are parser
// fixtures, never claimed to be measured or validated CFD calculations.
const header='# Force\n# CofR : (0 0 0)\n# Time total_x total_y total_z pressure_x pressure_y pressure_z viscous_x viscous_y viscous_z\n';
const data=(rows:string[])=>header+rows.join('\n');
const steady=(n=41)=>data(Array.from({length:n},(_,i)=>`${i*.1} -0.03 0 0.5 -0.02 0 0.4 -0.01 0 0.1`));
const simple=(times:number[],drags:number[]):ForceSeries=>({source:'OpenFOAM',format:'openfoam-v2312-force.dat',sourceFile:'force.dat',warnings:[],samples:times.map((t,i)=>({timeS:t,totalN:[-drags[i],0,4],pressureN:[-drags[i],0,4],viscousN:[0,0,0],porousN:[0,0,0]}))});
const motionHeader='# Motion State\n# Angle Units : degrees\n# Time centreOfRotation centreOfMass rotation velocity omega\n';
const motion=motionHeader+'0 (0 0 0) (0 0 0.03) (1 2 3) (0 0 0) (4 5 6)\n0.1 (0 0 0) (0 0 0.034) (-2 5 8) (0 0 0.01) (7 8 9)';
const ref=(label:string,cells:number,force:number,timeStepS=.002):RefinementRun=>({label,cellCount:cells,meanDragN:force,geometryHash:'a'.repeat(64),protocolHash:'b'.repeat(64),timeStepS});

describe('OpenFOAM dimensional force output',()=>{
  it('reads v2312 total, pressure and viscous without double-counting total',()=>{
    const r=parseForceData(steady());
    expect(r.samples).toHaveLength(41);expect(r.samples[0].totalN).toEqual([-.03,0,.5]);
    expect(r.samples[0].pressureN).toEqual([-.02,0,.4]);expect(r.samples[0].porousN).toEqual([0,0,0]);
    expect(r.format).toBe('openfoam-v2312-force.dat');
  });
  it('supports the dimensional vector notation as well as flattened columns',()=>{
    const a=parseForceData(data(['0 (-.03 0 .5) (-.02 0 .4) (-.01 0 .1)']));
    expect(a.samples[0].totalN).toEqual([-.03,0,.5]);
  });
  it('includes a porous contribution when present',()=>{
    const a=parseForceData(header.trim()+' porous_x porous_y porous_z\n0 -.04 0 .5 -.02 0 .4 -.01 0 .1 -.01 0 0');
    expect(a.samples[0].porousN[0]).toBe(-.01);expect(a.samples[0].totalN[0]).toBe(-.04);
  });
  it('reads legacy combined nested force and moment contributions',()=>{
    const a=parseForceData('# Time forces(pressure viscous porous) moments(pressure viscous porous)\n0 ((-.02 0 .4) (-.01 0 .1) (0 0 0)) ((.01 .02 .03) (.01 0 0) (0 0 0))');
    expect(a.samples[0].totalN[0]).toBeCloseTo(-.03,12);expect(a.samples[0].momentNm).toEqual([.02,.02,.03]);
  });
  it('reads a legacy file without porous zones',()=>{
    const a=parseForceData('# Time forces(pressure viscous) moments(pressure viscous)\n0 ((-.02 0 .4) (-.01 0 .1)) ((0 0 0) (0 0 0))');
    expect(a.samples[0].porousN).toEqual([0,0,0]);
  });
  it('allows an explicit runner format when the header is absent',()=>{
    expect(parseForceData('0 -.03 0 .5 -.02 0 .4 -.01 0 .1',{format:'openfoam-v2312'}).samples).toHaveLength(1);
    expect(()=>parseForceData('0 -.03 0 .5 -.02 0 .4 -.01 0 .1')).toThrow(/header/);
  });
  it('rejects empty or header-only output instead of manufacturing a result',()=>{
    expect(()=>parseForceData('')).toThrow(/empty/);expect(()=>parseForceData(header)).toThrow(/no result/);
  });
  it('rejects dimensionless force coefficients and separate moment output',()=>{
    expect(()=>parseForceData('# forceCoeffs\n# Time Cd Cl\n0 1 2')).toThrow(/dimensionless/);
    expect(()=>parseForceData(header.replace('# Force','# Moment')+'0 -.03 0 .5 -.02 0 .4 -.01 0 .1')).toThrow(/moments/);
  });
  it('rejects NaN, infinity and an overflowed exponent',()=>{
    for(const n of ['nan','NaN','Inf','1e999'])expect(()=>parseForceData(data([`0 ${n} 0 .5 -.02 0 .4 -.01 0 .1`]))).toThrow();
  });
  it('rejects corrupt or mixed force contributions',()=>{
    expect(()=>parseForceData(data(['0 -.05 0 .5 -.02 0 .4 -.01 0 .1']))).toThrow(/does not equal/);
    expect(()=>parseForceData(data(['0 -.03 0 .5 -.02 0 .4 -.01 0 .1','1 -.03 0 .5 -.02 0 .4 -.01 0 .1 0 0 0']))).toThrow(/columns change/);
  });
  it('rejects malformed parentheses, columns and arbitrary trailing text',()=>{
    expect(()=>parseForceData(data(['0 ((-.03 0 .5) (-.02 0 .4) (-.01 0 .1)']))).toThrow(/parentheses/);
    expect(()=>parseForceData(data(['0 -.03 0 .5 -.02 0 .4 -.01 0']))).toThrow(/components/);
    expect(()=>parseForceData(data(['0 -.03 0 .5 -.02 0 .4 -.01 0 .1 result']))).toThrow(/Unsupported/);
  });
  it('rejects duplicate/reversed times from a restart rather than overwriting data',()=>{
    const row='-.03 0 .5 -.02 0 .4 -.01 0 .1';
    expect(()=>parseForceData(data([`0 ${row}`,`0 ${row}`]))).toThrow(/increase strictly/);
    expect(()=>parseForceData(data([`1 ${row}`,`0 ${row}`]))).toThrow(/increase strictly/);
  });
});

describe('Dimensional force averages and quality diagnostics',()=>{
  it('uses signed drag=-Fx, dimensional vertical force and the final half by default',()=>{
    const a=summarizeForces(parseForceData(steady()));
    expect(a.meanDragN).toBeCloseTo(.03,12);expect(a.meanPressureDragN).toBeCloseTo(.02,12);expect(a.meanViscousDragN).toBeCloseTo(.01,12);
    expect(a.meanVerticalForceN).toBeCloseTo(.5,12);expect(a.averagingStartTimeS).toBe(2);expect(a.averagingEndTimeS).toBe(4);expect(a.sampleCount).toBe(21);
    expect(a.validation).toBe('unverified');expect(a.meanStandardErrorN).toBeNull();
  });
  it('integrates irregular output intervals by time instead of a biased sample mean',()=>{
    const a=summarizeForces(simple([0,1,3],[1,3,3]),{discardFraction:0,minSamples:2});
    expect(a.meanDragN).toBeCloseTo(8/3,12);expect(a.dragStandardDeviationN).toBeCloseTo(Math.sqrt(1/3),12);
    expect(a.forceSampleIntervalS).toEqual({minimum:1,maximum:2,mean:1.5});
  });
  it('interpolates explicit time-window boundaries without extrapolation',()=>{
    const a=summarizeForces(simple([0,1,1.5,3],[1,3,3,3]),{startTimeS:.5,endTimeS:2,minSamples:2});
    expect(a.meanDragN).toBeCloseTo(17/6,12);expect(a.interpolatedBoundaryCount).toBe(2);expect(a.sampleCount).toBe(2);
    expect(()=>summarizeForces(simple([0,1,3],[1,3,3]),{startTimeS:-1,minSamples:2})).toThrow(/within/);
  });
  it('withholds statistics when too few original output samples exist',()=>{
    expect(()=>summarizeForces(parseForceData(steady(10)))).toThrow(/at least20/);
    expect(()=>summarizeForces(parseForceData(data(['0 -.03 0 .5 -.02 0 .4 -.01 0 .1'])))).toThrow(/two force/);
  });
  it('does not change negative drag to an absolute value',()=>{
    const a=summarizeForces(simple([0,1],[-2,-2]),{discardFraction:0,minSamples:2});
    expect(a.meanDragN).toBe(-2);expect(a.warnings.join(' ')).toMatch(/negative/);
  });
  it('reports undefined relative drift near zero instead of dividing by zero',()=>{
    const a=summarizeForces(simple([0,1],[0,0]),{discardFraction:0,minSamples:2});
    expect(a.meanDragN).toBe(0);expect(a.splitHalfRelativeDrift).toBeNull();expect(a.driftWithinTolerance).toBeNull();
  });
  it('flags force drift without claiming physical or discretization convergence',()=>{
    const a=summarizeForces(simple([0,5,10],[0,5,10]),{discardFraction:0,minSamples:2});
    expect(a.firstHalfMeanDragN).toBeCloseTo(2.5,12);expect(a.secondHalfMeanDragN).toBeCloseTo(7.5,12);expect(a.splitHalfRelativeDrift).toBeCloseTo(1,12);
    expect(a.driftWithinTolerance).toBe(false);expect(a.validation).toBe('unverified');
  });
  it('validates averaging parameters and structured histories',()=>{
    const s=simple([0,1],[1,2]);
    for(const options of [{discardFraction:1},{minSamples:1},{startTimeS:1,endTimeS:1},{driftTolerance:0}])expect(()=>summarizeForces(s,options)).toThrow();
    s.samples[1].timeS=0;expect(()=>summarizeForces(s,{minSamples:2})).toThrow(/invalid/);
  });
});

describe('Verified sixDoFRigidBodyState motion output',()=>{
  it('reads XYZ Euler degrees, angular velocity and actual relative COM heave',()=>{
    const a=parseMotionData(motion);
    expect(a.samples[1].rollDeg).toBeCloseTo(-2,12);expect(a.samples[1].pitchDeg).toBeCloseTo(5,12);expect(a.samples[1].heaveM).toBeCloseTo(.004,12);
    expect(a.samples[0].angularVelocityRadS[0]).toBeCloseTo(4*Math.PI/180,12);expect(a.heaveReference).toBe('first-recorded-centre-of-mass');
  });
  it('converts declared radians and uses an explicit COM reference when provided',()=>{
    const a=parseMotionData(motion.replace('degrees','radians'),{referenceCentreOfMassM:[0,0,.02]});
    expect(a.samples[0].rollDeg).toBeCloseTo(180/Math.PI,12);expect(a.samples[0].heaveM).toBeCloseTo(.01,12);
    expect(a.samples[0].angularVelocityRadS[0]).toBe(4);expect(a.heaveReference).toBe('explicit-centre-of-mass');
  });
  it('rejects ambiguous units, quaternion/log layouts and missing motion channels',()=>{
    expect(()=>parseMotionData(motion.replace('# Angle Units : degrees\n',''))).toThrow(/angle units/);
    expect(()=>parseMotionData('Time =1\nOrientation: (1 0 0 0 1 0 0 0 1)')).toThrow(/header/);
    expect(()=>parseMotionData(motionHeader+'0 (0 0 0) (0 0 0) (0 0 0)')).toThrow(/five motion/);
  });
});

describe('Mesh and time-step refinement diagnostics',()=>{
  it('compares three matching meshes without inventing GCI or validation',()=>{
    const a=compareRefinements([ref('Fine',8000,.108),ref('Coarse',1000,.12),ref('Medium',3000,.11)],{parameter:'mesh'});
    expect(a.orderedRuns.map(r=>r.label)).toEqual(['Coarse','Medium','Fine']);expect(a.finestPairRelativeChange).toBeCloseTo(.002/.108,12);
    expect(a.withinTolerance).toBe(true);expect(a.oscillatory).toBe(false);expect(a.validation).toBe('unverified');expect(a.warnings.join(' ')).toMatch(/not.*GCI/);
  });
  it('compares declared effective integration steps independently of cell count',()=>{
    const a=compareRefinements([ref('Half dt',1000,.105,.001),ref('Base dt',1000,.11,.002)],{parameter:'time-step'});
    expect(a.orderedRuns.map(r=>r.label)).toEqual(['Base dt','Half dt']);expect(a.withinTolerance).toBe(false);
  });
  it('rejects mismatched physical conditions or uploaded geometry hashes',()=>{
    const a=ref('A',1000,.12),b=ref('B',2000,.11);
    expect(()=>compareRefinements([a,{...b,geometryHash:'different'}],{parameter:'mesh'})).toThrow(/identical/);
    expect(()=>compareRefinements([a,{...b,protocolHash:'different'}],{parameter:'mesh'})).toThrow(/identical/);
  });
  it('identifies oscillatory changes and undefined near-zero relative change',()=>{
    expect(compareRefinements([ref('A',1000,.1),ref('B',2000,.12),ref('C',3000,.11)],{parameter:'mesh'}).oscillatory).toBe(true);
    const a=compareRefinements([ref('A',1000,.01),ref('B',2000,0)],{parameter:'mesh'});expect(a.finestPairRelativeChange).toBeNull();expect(a.withinTolerance).toBeNull();
  });
  it('rejects insufficient, nonfinite, duplicate or unspecified refinement controls',()=>{
    const a=ref('A',1000,.12),b=ref('B',1000,.11);
    expect(()=>compareRefinements([a],{parameter:'mesh'})).toThrow(/At least two/);
    expect(()=>compareRefinements([a,b],{parameter:'mesh'})).toThrow(/different/);
    expect(()=>compareRefinements([a,{...b,cellCount:2000,meanDragN:NaN}],{parameter:'mesh'})).toThrow(/finite/);
    expect(()=>compareRefinements([a,{...b,timeStepS:undefined}],{parameter:'time-step'})).toThrow(/explicit positive/);
  });
});
