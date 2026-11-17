import {describe,it,expect} from 'vitest';
import {diagonalizeInertia,estimateMassProperties,type Matrix3,type MassTensor} from '../src/cfd/massProperties';
import {boxHull} from '../src/engine/example';
import {generateOpenFoamCase} from '../src/cfd/case';
import {constrainedRollInertia,extendCaseWithWaves,type WaveCaseSettings} from '../src/cfd/waves';

const I:Matrix3=[[1,0,0],[0,1,0],[0,0,1]];
const determinant=(q:Matrix3)=>q[0][0]*(q[1][1]*q[2][2]-q[1][2]*q[2][1])-q[0][1]*(q[1][0]*q[2][2]-q[1][2]*q[2][0])+q[0][2]*(q[1][0]*q[2][1]-q[1][1]*q[2][0]);
const reconstruct=(moments:number[],q:Matrix3):MassTensor=>q.map((row,i)=>row.map((_,j)=>moments.reduce((sum,m,k)=>sum+q[i][k]*m*q[j][k],0))) as MassTensor;
const rotateY=(angle:number):Matrix3=>[[Math.cos(angle),0,Math.sin(angle)],[0,1,0],[-Math.sin(angle),0,Math.cos(angle)]];
const base=()=>generateOpenFoamCase({caseId:'principal-frame',trianglesMm:boxHull(200,60,40),sourceHash:'a'.repeat(64),protocolKey:'test',load:{massKg:.23952,draftM:.02,cgM:[.1,0,.015],cgMeasured:true},speedMps:0,maxCells:5000000});
const estimated=():WaveCaseSettings=>({kind:'beam-waves',heightM:.01,periodS:1,inertiaSource:'cad-estimate',inertiaMeasured:false,inertiaKgM2:[.0001,.0005,.00055],inertiaOrientation:rotateY(.4),rollAxis:[Math.cos(.2),0,-Math.sin(.2)],inertiaAssumptions:['Uniform wall material; no unlisted masses.']});

describe('CAD principal inertia retains the complete physical tensor',()=>{
  it('reconstructs a rotated anisotropic tensor, including products of inertia',()=>{
    const original=reconstruct([.0001,.0005,.00055],rotateY(.4)),p=diagonalizeInertia(original),rebuilt=reconstruct(p.momentsKgM2,p.orientation);
    expect(Math.abs(original[0][2])).toBeGreaterThan(.0001);
    [.0001,.0005,.00055].forEach((value,i)=>expect(p.momentsKgM2[i]).toBeCloseTo(value,14));
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)expect(rebuilt[i][j]).toBeCloseTo(original[i][j],14);
    expect(p.reconstructionRelativeError).toBeLessThan(1e-12);expect(determinant(p.orientation)).toBeCloseTo(1,12);
  });
  it('pairs sorted moments with the correct columns even when their model-axis order changes',()=>{
    const original:MassTensor=[[.0005,0,0],[0,.00055,0],[0,0,.0001]],p=diagonalizeInertia(original);
    expect(p.momentsKgM2).toEqual([.0001,.0005,.00055]);
    expect(reconstruct(p.momentsKgM2,p.orientation)).toEqual(original);
    expect(determinant(p.orientation)).toBe(1);
  });
  it('has a stable proper frame for repeated and isotropic principal moments',()=>{
    const tensor:MassTensor=[[.0003,0,0],[0,.0003,0],[0,0,.0003]],a=diagonalizeInertia(tensor),b=diagonalizeInertia(tensor);
    expect(a.orientation).toEqual(I);expect(a).toEqual(b);
  });
  it('maintains reconstruction for very small and large dimensional mass moments',()=>{
    for(const scale of [1e-12,1e6]){
      const original=reconstruct([.0001*scale,.0005*scale,.00055*scale],rotateY(.4)),p=diagonalizeInertia(original);
      expect(p.reconstructionRelativeError).toBeLessThan(1e-12);
    }
  });
  it('retains the exact tensor of a real CAD distribution plus an off-centre point load',()=>{
    const r=estimateMassProperties({trianglesMm:boxHull(200,60,40),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.2,payloads:[{name:'Cargo',massKg:.1,positionM:[.15,.02,.08]}]});
    const reconstructed=reconstruct(r.principalMomentsKgM2,r.principalOrientation);
    expect(r.principalAxesAligned).toBe(false);expect(r.inertiaReconstructionRelativeError).toBeLessThan(1e-12);
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)expect(reconstructed[i][j]).toBeCloseTo(r.inertiaTensorKgM2[i][j],13);
  });
  it('rejects asymmetric, indefinite or impossible tensors without a diagonal fallback',()=>{
    expect(()=>diagonalizeInertia([[1,.2,0],[.1,1,0],[0,0,1]])).toThrow(/symmetric/);
    expect(()=>diagonalizeInertia([[-1,0,0],[0,1,0],[0,0,1]])).toThrow(/positive/);
    expect(()=>diagonalizeInertia([[1,0,0],[0,1,0],[0,0,3]])).toThrow(/triangle/);
  });
  it('uses the exact effective axial inertia for the single permitted rotation',()=>{
    const tensor=reconstruct([.0001,.0005,.00055],rotateY(.4)),axis=estimated().rollAxis!,p=constrainedRollInertia(tensor,axis);
    const effective=axis.reduce((sum,v,i)=>sum+v*tensor[i].reduce((s,t,j)=>s+t*axis[j],0),0);
    expect(p.effectiveRollInertiaKgM2).toBeCloseTo(effective,15);expect(p.effectiveRollInertiaKgM2).not.toBeCloseTo(.0001,6);
    for(let i=0;i<3;i++)expect(p.orientation[i][0]).toBeCloseTo(axis[i],14);
    // Constrained kinetic energy is 1/2 * (a^T I a) * rollRate^2, including products.
    const rate=1.7,omega=axis.map(v=>v*rate),fullEnergy=omega.reduce((sum,v,i)=>sum+.5*v*tensor[i].reduce((s,t,j)=>s+t*omega[j],0),0);
    expect(.5*p.diagonal[0]*rate**2).toBeCloseTo(fullEnergy,15);
  });
  it('keeps the chosen rotation frame proper when its longitudinal axis is vertical',()=>{
    const p=constrainedRollInertia([[.0001,0,0],[0,.0005,0],[0,0,.00055]],[0,0,1]);
    expect(p.effectiveRollInertiaKgM2).toBe(.00055);expect(determinant(p.orientation)).toBeCloseTo(1,14);
  });
});

describe('Estimated inertia OpenFOAM handoff',()=>{
  it('writes the constrained-roll frame as both native orientations and leaves the physical CAD unrotated',()=>{
    const b=base(),p=extendCaseWithWaves(b,estimated()),dict=String(p.files['constant/dynamicMeshDict']);
    const parse=(entry:string)=>dict.match(new RegExp(`(?:^|\\n)\\s*${entry}\\s+\\(([^)]+)\\);`))![1].trim().split(/\s+/).map(Number);
    const current=parse('orientation'),initial=parse('initialOrientation');
    expect(current).toEqual(initial);current.forEach((v,i)=>expect(v).toBeCloseTo(rotateY(.2).flat()[i],10));
    // sixDoF transforms initial points by Q * initialQ.T; equal proper frames give identity.
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)expect(current.slice(i*3,i*3+3).reduce((sum,v,k)=>sum+v*initial[j*3+k],0)).toBeCloseTo(i===j?1:0,10);
    expect(p.files['constant/triSurface/hull.stl']).toBe(b.files['constant/triSurface/hull.stl']);
    expect(p.manifest.motion?.inertiaMeasured).toBe(false);expect(p.manifest.motion?.inertiaSource).toBe('cad-estimate');
    p.manifest.motion!.initialOrientation.flat().forEach((v,i)=>expect(v).toBeCloseTo(rotateY(.2).flat()[i],12));
    expect(p.manifest.motion?.rollAxis).toEqual(estimated().rollAxis);expect(p.manifest.motion?.inertiaProjection).toContain('a^T I a');
    expect(dict).toContain('axis (1 0 0);');
    expect(String(p.files['README.txt'])).toContain('Inertia source: cad-estimate.');
  });
  it('does not relabel estimated inertia as measured or omit its physical assumptions',()=>{
    expect(()=>extendCaseWithWaves(base(),{...estimated(),inertiaMeasured:true})).toThrow(/must not be labelled measured/);
    expect(()=>extendCaseWithWaves(base(),{...estimated(),inertiaAssumptions:[]})).toThrow(/assumptions/);
    expect(()=>extendCaseWithWaves(base(),{...estimated(),inertiaOrientation:undefined})).toThrow(/orientation/);
  });
  it('accepts the authoritative full CAD tensor without requiring manually entered moments',()=>{
    const tensor=reconstruct([.0001,.0005,.00055],rotateY(.4));
    const p=extendCaseWithWaves(base(),{...estimated(),inertiaTensorKgM2:tensor,inertiaKgM2:undefined,inertiaOrientation:undefined});
    expect(p.manifest.motion?.inertiaTensorKgM2).toEqual(tensor);
    expect(p.manifest.motion?.effectiveRollInertiaKgM2).toBeCloseTo(constrainedRollInertia(tensor,estimated().rollAxis!).effectiveRollInertiaKgM2,15);
    expect(p.manifest.motion?.inertiaMeasured).toBe(false);
  });
  it('rejects a distorted or reflected principal frame',()=>{
    expect(()=>extendCaseWithWaves(base(),{...estimated(),inertiaOrientation:[[2,0,0],[0,1,0],[0,0,1]]})).toThrow(/orthonormal/);
    expect(()=>extendCaseWithWaves(base(),{...estimated(),inertiaOrientation:[[-1,0,0],[0,1,0],[0,0,1]]})).toThrow(/right-handed/);
  });
  it('preserves the measured-input workflow with identity principal axes',()=>{
    const p=extendCaseWithWaves(base(),{kind:'beam-waves',heightM:.01,periodS:1,inertiaMeasured:true,inertiaKgM2:[.0001,.0005,.00055]});
    expect(p.manifest.motion?.initialOrientation).toEqual(I);expect(p.manifest.motion?.inertiaMeasured).toBe(true);expect(p.manifest.motion?.inertiaSource).toBe('measured');
  });
});
