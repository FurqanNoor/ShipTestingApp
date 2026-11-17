import {describe,expect,it} from 'vitest';
import {generateOpenFoamCase,type CfdCaseInput,foamNumber} from '../src/cfd/case';
import {boxHull} from '../src/engine/example';
import {parseSTL} from '../src/engine/stl';

const base=():CfdCaseInput=>({caseId:'test-box',trianglesMm:boxHull(200,60,40),sourceHash:'a'.repeat(64),protocolKey:'shared-test-v1',load:{massKg:.23952,draftM:.02,cgM:[.1,0,.02],cgMeasured:true},speedMps:.3,durationS:1});
const text=(files:Record<string,string|Uint8Array>,name:string)=>String(files[name]);
function cup(L=200,B=60,D=40,t=10) {
  const outer=[[0,-B/2],[L,-B/2],[L,B/2],[0,B/2]],inner=[[t,-B/2+t],[L-t,-B/2+t],[L-t,B/2-t],[t,B/2-t]];
  const ring=(ps:number[][],z:number)=>ps.map(p=>[p[0],p[1],z]);
  const ob=ring(outer,0),ot=ring(outer,D),ib=ring(inner,t),it=ring(inner,D),out:number[]=[];
  const q=(a:number[],b:number[],c:number[],d:number[])=>out.push(...a,...b,...c,...a,...c,...d);
  q(ob[3],ob[2],ob[1],ob[0]);q(ib[0],ib[1],ib[2],ib[3]);
  for(let j=0;j<4;j++){const k=(j+1)%4;q(ob[j],ob[k],ot[k],ot[j]);q(ib[j],it[j],it[k],ib[k]);q(ot[j],ot[k],it[k],it[j]);}
  return new Float32Array(out);
}

describe('OpenCFD v2312 fixed-hull case',()=> {
  it('preserves actual CAD triangles and converts mm→m with exactly one draft translation',()=> {
    const i=base(),p=generateOpenFoamCase(i),stl=parseSTL(new TextEncoder().encode(text(p.files,'constant/triSurface/hull.stl')).buffer as ArrayBuffer);
    expect(stl.length).toBe(i.trianglesMm.length);
    for(let k=0;k<stl.length;k++)expect(stl[k]).toBeCloseTo(i.trianglesMm[k]*.001-(k%3===2?.02:0),7);
    expect(p.manifest.geometry.translationM).toEqual([0,0,-.02]);
    expect(p.manifest.load.solverCgM).toEqual([.1,0,0]);
  });
  it('builds the inlet upstream of bow and outlet aft for negative-X tow flow',()=> {
    const p=generateOpenFoamCase(base());
    expect(p.manifest.domain.maxM[0]-.2).toBeCloseTo(.4,10);
    expect(-p.manifest.domain.minM[0]).toBeCloseTo(1,10);
    expect(p.manifest.domain.belowKeelClearanceM).toBeCloseTo(.6,10);
    expect(p.manifest.conventions.dragFromForce).toBe('negative Fx');
    expect(text(p.files,'0/U')).toContain('uniform (-0.3 0 0)');
  });
  it('exports the pinned solver distribution, real force data path and all required two-phase fields',()=> {
    const p=generateOpenFoamCase(base());
    expect(p.manifest.solver.image).toBe('opencfd/openfoam-run:2312');
    expect(p.manifest.solver.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(p.manifest.conventions.forceFile).toBe('postProcessing/hullForces/0/force.dat');
    for(const name of ['0/U','0/p_rgh','0/alpha.water','constant/g','constant/transportProperties','constant/turbulenceProperties','system/fvSchemes','system/fvSolution','system/snappyHexMeshDict','system/blockMeshDict','system/setFieldsDict','system/controlDict','Allrun','manifest.json'])expect(p.files[name]).toBeDefined();
    expect(text(p.files,'system/controlDict')).toContain('p p; U U; rho rho;');
    expect(text(p.files,'0/p_rgh')).toContain('[1 -1 -2 0 0 0 0]');
  });
  it('uses a spatial wet/air inlet profile and initial water only below Z=0',()=> {
    const p=generateOpenFoamCase(base());
    const alpha=text(p.files,'0/alpha.water');
    expect(alpha).toContain('type fixedProfile;');
    expect(alpha).toContain('direction (0 0 1); origin 0;');
    expect(alpha).toContain('profile table');
    expect(text(p.files,'system/setFieldsDict')).toContain('fieldValues (volScalarFieldValue alpha.water 1)');
    expect(text(p.files,'constant/turbulenceProperties')).toContain('simulationType laminar;');
    expect(text(p.files,'constant/transportProperties')).toContain('sigma [1 0 -2 0 0 0 0] 0.072');
  });
  it('never reports solver-generated forces before checks, convergence and actual completion',()=> {
    const p=generateOpenFoamCase(base());
    expect(p.manifest.verification.status).toBe('not-run');
    expect(p.manifest.domain.boundaryIndependent).toBe(false);
    expect(p.manifest.mesh.resolutionVerified).toBe(false);
    expect(p.manifest.verification.required.some(x=>x.includes('convergence'))).toBe(true);
    const run=text(p.files,'Allrun');
    expect(run).toContain('surfaceCheck -checkSelfIntersection');
    expect(run.indexOf('run_stage checkMesh')).toBeLessThan(run.indexOf('run_stage interFoam'));
    expect(run).not.toMatch(/\brm\s/);
    expect(run).toContain('No empirical fallback');
  });
  it('refines the hull independently of far-field domain enlargement',()=> {
    const a=generateOpenFoamCase(base()),b=generateOpenFoamCase({...base(),domainScale:1.5});
    expect(b.manifest.domain.upstreamClearanceM/a.manifest.domain.upstreamClearanceM).toBeCloseTo(1.5,12);
    expect(b.manifest.mesh.finestCellM).toBe(a.manifest.mesh.finestCellM);
    expect(b.manifest.mesh.estimatedBaseCells).toBeGreaterThan(a.manifest.mesh.estimatedBaseCells);
    const medium=generateOpenFoamCase({...base(),mesh:'medium'});
    expect(medium.manifest.mesh.finestCellM).toBeCloseTo(a.manifest.mesh.finestCellM/2,12);
    expect(medium.manifest.domain).toEqual(a.manifest.domain);
  });
  it('supports the zero-current base needed for independent wave and decay cases',()=> {
    const p=generateOpenFoamCase({...base(),speedMps:0});
    expect(p.manifest.speedMps).toBe(0);
    expect(text(p.files,'0/U')).toContain('uniform (0 0 0)');
  });
  it('rejects open and non-finite solver surfaces rather than inventing a cap',()=> {
    const i=base();expect(()=>generateOpenFoamCase({...i,trianglesMm:Float32Array.from(Array.from(i.trianglesMm).slice(9))})).toThrow(/watertight/);
    const bad=Float32Array.from(i.trianglesMm);bad[0]=NaN;
    expect(()=>generateOpenFoamCase({...i,trianglesMm:bad})).toThrow(/non-finite/);
  });
  it('requires measured CG, finite mass, positive freeboard and safe bounded identifiers',()=> {
    expect(()=>generateOpenFoamCase({...base(),caseId:'../../bad'})).toThrow(/Case ID/);
    expect(()=>generateOpenFoamCase({...base(),sourceHash:'unhashed'})).toThrow(/SHA-256/);
    expect(()=>generateOpenFoamCase({...base(),load:{...base().load,cgMeasured:false as true}})).toThrow(/Measured centre/);
    expect(()=>generateOpenFoamCase({...base(),load:{...base().load,draftM:.04}})).toThrow(/positive freeboard/);
    expect(()=>generateOpenFoamCase({...base(),load:{...base().load,massKg:0}})).toThrow(/Total test mass/);
  });
  it('fails closed on unsupported waves/free motion in the fixed-hull builder',()=> {
    expect(()=>generateOpenFoamCase({...base(),mode:'free-motion' as 'fixed-resistance'})).toThrow(/fixed hull/);
    expect(()=>generateOpenFoamCase({...base(),condition:{kind:'head-waves' as 'calm'}})).toThrow(/calm water/);
    expect(()=>generateOpenFoamCase({...base(),domainScale:NaN})).toThrow(/Domain scale/);
    expect(()=>generateOpenFoamCase({...base(),maxCo:1})).toThrow(/Courant/);
    expect(()=>foamNumber(Infinity)).toThrow(/finite/);
  });
  it('requires an actual wall thickness and separate dry envelope for open printed hulls',()=> {
    expect(()=>generateOpenFoamCase({...base(),geometryKind:'printed-material'})).toThrow(/wall thickness/);
    expect(()=>generateOpenFoamCase({...base(),geometryKind:'printed-material',minimumWallThicknessM:.01})).toThrow(/dry-displacement envelope/);
  });
  it('refines beyond the minimum wall-resolving grid on every study level',()=>{
    const input={...base(),trianglesMm:cup(200,60,40,2),geometryKind:'printed-material' as const,minimumWallThicknessM:.0016,dryEnvelopeTrianglesMm:boxHull(200,60,40),maxCells:20000000};
    const coarse=generateOpenFoamCase({...input,mesh:'coarse'}),medium=generateOpenFoamCase({...input,mesh:'medium'}),fine=generateOpenFoamCase({...input,mesh:'fine'});
    expect(coarse.manifest.mesh.wallCellsAtFinest).toBeGreaterThanOrEqual(3);
    expect(medium.manifest.mesh.finestCellM).toBe(coarse.manifest.mesh.finestCellM/2);
    expect(fine.manifest.mesh.finestCellM).toBe(medium.manifest.mesh.finestCellM/2);
  });
  it('initialises the physical printed cavity as air without meshing the virtual cap',()=> {
    const p=generateOpenFoamCase({...base(),trianglesMm:cup(),geometryKind:'printed-material',minimumWallThicknessM:.01,dryEnvelopeTrianglesMm:boxHull(200,60,40)});
    expect(p.manifest.geometry.dryCavityInitialised).toBe(true);
    expect(p.manifest.mesh.wallCellsAtFinest).toBeGreaterThanOrEqual(3);
    expect(p.files['constant/triSurface/dryEnvelope.stl']).toBeDefined();
    const set=text(p.files,'system/setFieldsDict');
    expect(set.indexOf('surfaceToCell')).toBeGreaterThan(set.indexOf('boxToCell'));
    expect(set).toContain('includeInside true; includeOutside false; includeCut false;');
    expect(set).toContain('fieldValues (volScalarFieldValue alpha.water 0)');
    expect(text(p.files,'system/snappyHexMeshDict')).not.toContain('dryEnvelope.stl');
  });
  it('rejects a printed wall that cannot be resolved within the declared cell budget',()=> {
    expect(()=>generateOpenFoamCase({...base(),geometryKind:'printed-material',trianglesMm:cup(200,60,40,1),minimumWallThicknessM:.001,dryEnvelopeTrianglesMm:boxHull(200,60,40),maxCells:750000})).toThrow(/cell budget/);
  });
});
