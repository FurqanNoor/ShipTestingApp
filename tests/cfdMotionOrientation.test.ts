import {describe,expect,it} from 'vitest';
import {parseMotionData,type MotionOrientation,type Vec3} from '../src/cfd/results';

const rad=(deg:number)=>deg*Math.PI/180;
const identity:MotionOrientation=[[1,0,0],[0,1,0],[0,0,1]];
const rx=(a:number):MotionOrientation=>[[1,0,0],[0,Math.cos(a),-Math.sin(a)],[0,Math.sin(a),Math.cos(a)]];
const ry=(a:number):MotionOrientation=>[[Math.cos(a),0,Math.sin(a)],[0,1,0],[-Math.sin(a),0,Math.cos(a)]];
const rz=(a:number):MotionOrientation=>[[Math.cos(a),-Math.sin(a),0],[Math.sin(a),Math.cos(a),0],[0,0,1]];
const mul=(a:MotionOrientation,b:MotionOrientation):MotionOrientation=>a.map(row=>[0,1,2].map(j=>row.reduce((s,v,k)=>s+v*b[k][j],0))) as MotionOrientation;
// Independent elementary-matrix composition of OpenFOAM's quaternion::XYZ sequence.
const q=([x,y,z]:Vec3)=>mul(mul(rx(rad(x)),ry(rad(y))),rz(rad(z)));
const header=(units='degrees')=>`# Motion State\n# Angle Units : ${units}\n# Time centreOfRotation centreOfMass rotation velocity omega\n`;
const row=(time:number,angles:Vec3,z=.02)=>`${time} (0 0 ${z}) (0 0 ${z}) (${angles.join(' ')}) (1 2 3) (4 5 6)\n`;

describe('Physical CAD motion with a nonidentity principal-body orientation',()=>{
  it('removes a pure principal-axis yaw from a stationary CAD hull',()=>{
    const r=parseMotionData(header()+row(0,[0,0,90]),{initialOrientation:rz(Math.PI/2)});
    expect(r.orientationReference).toBe('relative-to-initial-body-orientation');
    r.samples[0].rotationRad.forEach(v=>expect(v).toBeCloseTo(0,12));
    expect(r.samples[0].recordedOrientationRad[2]).toBeCloseTo(Math.PI/2,12);
  });
  it('removes a mixed XYZ initial principal orientation without inventing heel',()=>{
    const angles:Vec3=[23,-17,61],initial=q(angles),r=parseMotionData(header()+row(0,angles),{initialOrientation:initial});
    r.samples[0].rotationRad.forEach(v=>expect(v).toBeCloseTo(0,12));
    expect(r.initialOrientation).toEqual(initial);expect(r.initialOrientation).not.toBe(initial);
  });
  it('retains a known global roll while cancelling a mixed principal orientation',()=>{
    const initial:Vec3=[23,-17,61];
    // Rx(12°) Q0 = Rx(35°) Ry(-17°) Rz(61°).
    const r=parseMotionData(header()+row(0,initial)+row(1,[35,-17,61],.024),{initialOrientation:q(initial),referenceCentreOfMassM:[0,0,.02]});
    expect(r.samples[1].rollDeg).toBeCloseTo(12,11);expect(r.samples[1].pitchDeg).toBeCloseTo(0,11);expect(r.samples[1].yawDeg).toBeCloseTo(0,11);
    expect(r.samples[1].heaveM).toBeCloseTo(.004,12);
    expect(r.samples[1].velocityMps).toEqual([1,2,3]);expect(r.samples[1].angularVelocityRadS[0]).toBeCloseTo(rad(4),12);
  });
  it('retains negative roll and does not confuse a 90-degree principal yaw with physical yaw',()=>{
    const r=parseMotionData(header()+row(0,[0,0,90])+row(1,[-28,0,90]),{initialOrientation:q([0,0,90])});
    expect(r.samples[1].rollDeg).toBeCloseTo(-28,11);expect(r.samples[1].pitchDeg).toBeCloseTo(0,11);expect(r.samples[1].yawDeg).toBeCloseTo(0,11);
  });
  it('converts declared radian XYZ values using the same relative reference',()=>{
    const initial:Vec3=[-15,12,-34],recorded:Vec3=[-8,12,-34];
    const r=parseMotionData(header('radians')+row(0,recorded.map(rad) as Vec3),{initialOrientation:q(initial)});
    expect(r.samples[0].rollDeg).toBeCloseTo(7,11);expect(r.samples[0].pitchDeg).toBeCloseTo(0,11);expect(r.samples[0].yawDeg).toBeCloseTo(0,11);
    expect(r.samples[0].angularVelocityRadS).toEqual([4,5,6]);
  });
  it('can recover physical pitch relative to a rotated initial body frame',()=>{
    const r=parseMotionData(header()+row(0,[0,14,53]),{initialOrientation:q([0,0,53])});
    expect(r.samples[0].rollDeg).toBeCloseTo(0,11);expect(r.samples[0].pitchDeg).toBeCloseTo(14,11);expect(r.samples[0].yawDeg).toBeCloseTo(0,11);
  });
  it('keeps historical parser behavior without an explicit initial body orientation',()=>{
    const r=parseMotionData(header()+row(0,[23,-17,61]));
    expect(r.orientationReference).toBe('recorded-body-orientation');expect(r).not.toHaveProperty('initialOrientation');
    expect(r.samples[0].rollDeg).toBeCloseTo(23,12);expect(r.samples[0].pitchDeg).toBeCloseTo(-17,12);expect(r.samples[0].yawDeg).toBeCloseTo(61,12);
    expect(r.samples[0].rotationRad).toEqual(r.samples[0].recordedOrientationRad);
  });
  it('does not mutate the supplied matrix while parsing a history',()=>{
    const initial=q([23,-17,61]),copy=initial.map(row=>[...row]);parseMotionData(header()+row(0,[23,-17,61]),{initialOrientation:initial});
    expect(initial).toEqual(copy);
  });
  it('rejects reflected, scaled, skewed and nonfinite body frames',()=>{
    const bad:MotionOrientation[]=[[[1,0,0],[0,1,0],[0,0,-1]],[[2,0,0],[0,1,0],[0,0,1]],[[1,.1,0],[0,1,0],[0,0,1]],[[NaN,0,0],[0,1,0],[0,0,1]]];
    for(const initialOrientation of bad)expect(()=>parseMotionData(header()+row(0,[0,0,0]),{initialOrientation})).toThrow(/orientation/);
  });
  it('accepts the identity frame with ordinary unsingular XYZ motion',()=>{
    const r=parseMotionData(header()+row(0,[12,-23,34]),{initialOrientation:identity});
    expect(r.samples[0].rollDeg).toBeCloseTo(12,11);expect(r.samples[0].pitchDeg).toBeCloseTo(-23,11);expect(r.samples[0].yawDeg).toBeCloseTo(34,11);
  });
  it('measures roll around a longitudinal axis pitched by the floating-equilibrium pose',()=>{
    const trim=rad(24),roll=rad(18),initial=ry(trim),axis:Vec3=[Math.cos(trim),0,-Math.sin(trim)];
    // Recorded body orientation is Ry(trim) Rx(roll). Its intrinsic XYZ angles follow
    // directly from the elementary product, whereas its physical roll axis is Ry(trim) X.
    const recorded:Vec3=[Math.atan2(Math.sin(roll),Math.cos(trim)*Math.cos(roll)),Math.asin(Math.sin(trim)*Math.cos(roll)),Math.atan2(-Math.sin(trim)*Math.sin(roll),Math.cos(trim))].map(v=>v*180/Math.PI) as Vec3;
    const r=parseMotionData(header()+row(0,recorded),{initialOrientation:initial,rollAxis:axis});
    expect(r.samples[0].rollDeg).toBeCloseTo(18,11);expect(r.rollReference).toBe('specified-fixed-axis');axis.forEach((v,i)=>expect(r.rollAxis?.[i]).toBeCloseTo(v,14));
    expect(r.samples[0].rotationRad[0]*180/Math.PI).not.toBeCloseTo(18,3);
    expect(r.warnings.join(' ')).not.toContain('away from');
  });
  it('flags a history whose physical rotation violates the specified roll constraint',()=>{
    const r=parseMotionData(header()+row(0,[0,20,0]),{initialOrientation:identity,rollAxis:[1,0,0]});
    expect(r.warnings.join(' ')).toContain('away from the specified roll axis');
  });
  it('rejects zero, unnormalised and nonfinite roll axes',()=>{
    for(const rollAxis of [[0,0,0],[2,0,0],[NaN,0,1]] as Vec3[])expect(()=>parseMotionData(header()+row(0,[0,0,0]),{rollAxis})).toThrow(/unit vector/);
  });
});
