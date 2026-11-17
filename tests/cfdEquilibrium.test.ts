import {describe,it,expect} from 'vitest';
import {boxHull} from '../src/engine/example';
import {prepareCfdHull} from '../src/cfd/geometry';
import {solveFloatingEquilibrium} from '../src/cfd/equilibrium';
import {sampleHydrostaticPlane} from '../src/cfd/hydro';

const box=()=>prepareCfdHull(boxHull(200,60,40),'closed-envelope');

describe('Automatic dry floating roll and trim',()=>{
  it('retains the analytical upright box at its specified load and CG',()=>{
    const r=solveFloatingEquilibrium(box(),{massKg:.23952,cgM:[.1,0,.01]});
    expect(r.rollRad).toBe(0);expect(r.pitchRad).toBe(0);expect(r.iterations).toBe(0);expect(r.residualM).toBeLessThan(1e-12);
    expect(r.hydro.draftM).toBeCloseTo(.02,12);expect(r.hydro.gmM).toBeCloseTo(.015,12);expect(r.hydro.freeFloatingAllowed).toBe(true);
  });
  it('balances an off-centre loaded box without inventing a different CG',()=>{
    const hull=box(),cg:[number,number,number]=[.102,.001,.01],before=hull.trianglesM.slice();
    const r=solveFloatingEquilibrium(hull,{massKg:.23952,cgM:cg});
    expect(r.rollRad).toBeLessThan(0);expect(r.pitchRad).toBeGreaterThan(0);expect(r.residualM).toBeLessThan(1e-6);
    // Small-angle metacentric predictions are independent analytical checks.
    expect(r.rollRad).toBeCloseTo(-.001/.015,2);
    expect(r.pitchRad).toBeCloseTo(.002/(.2**2/(12*.02)),3);
    for(let i=0;i<3;i++)expect(r.cgM[i]).toBeCloseTo(r.rotation[i].reduce((sum,v,j)=>sum+v*cg[j],0)+r.translationM[i],12);
    expect(r.hydro.flags).not.toContain('unbalanced-upright-roll');expect(r.hydro.flags).not.toContain('unbalanced-upright-pitch');
    expect(Array.from(hull.trianglesM)).toEqual(Array.from(before));expect(r.hull.volumeM3).toBe(hull.volumeM3);
  });
  it('uses a rigid CAD transform that preserves volume, distance and its exact solver surface',()=>{
    const hull=box(),r=solveFloatingEquilibrium(hull,{massKg:.23952,cgM:[.103,.0005,.01]});
    const volume=sampleHydrostaticPlane(r.hull.trianglesM,r.hull.bounds.maxM[2]+.01).volumeM3;
    expect(volume).toBeCloseTo(hull.volumeM3,13);
    const before=Math.hypot(...[0,1,2].map(k=>hull.solverTrianglesM[k]-hull.solverTrianglesM[k+3]));
    const after=Math.hypot(...[0,1,2].map(k=>r.hull.solverTrianglesM[k]-r.hull.solverTrianglesM[k+3]));
    expect(after).toBeCloseTo(before,13);expect(r.hull.bounds.minM[0]).toBeCloseTo(0,14);expect(r.hull.bounds.minM[2]).toBeCloseTo(0,14);
    expect(r.hull.bounds.minM[1]+r.hull.bounds.maxM[1]).toBeCloseTo(0,14);
  });
  it('keeps the original physical open rim and solves a dry heeled start',()=>{
    const t=boxHull(200,60,40),skin=new Float32Array([...t.slice(0,18),...t.slice(36)]),hull=prepareCfdHull(skin,'open-surface');
    const r=solveFloatingEquilibrium(hull,{massKg:.18,cgM:[.102,.0005,.009]});
    expect(r.hydro.freeboardM).toBeGreaterThan(0);expect(r.hull.rimVerticesM).toHaveLength(hull.rimVerticesM.length);expect(r.hull.virtualCap).toBe(true);
    expect(Math.min(...r.hull.rimVerticesM.map(p=>p[2]))).toBeCloseTo(r.hydro.lowestRimM!,12);
    expect(r.hydro.draftM).toBeLessThan(r.hydro.lowestRimM!);expect(r.residualM).toBeLessThan(1e-6);
  });
  it('rejects overload, unstable equilibrium and a CG outside its permitted dry angle range',()=>{
    expect(()=>solveFloatingEquilibrium(box(),{massKg:1,cgM:[.1,0,.01]})).toThrow(/displacement/);
    expect(()=>solveFloatingEquilibrium(box(),{massKg:.23952,cgM:[.1,0,.09]})).toThrow(/non-positive/);
    expect(()=>solveFloatingEquilibrium(box(),{massKg:.23952,cgM:[.1,.025,.01]})).toThrow(/equilibrium/);
  });
  it('rejects malformed inputs instead of modifying its mass or geometry',()=>{
    expect(()=>solveFloatingEquilibrium(box(),{massKg:.2,cgM:[NaN,0,0]})).toThrow(/finite/);
    expect(()=>solveFloatingEquilibrium(box(),{massKg:.2,cgM:[.1,0,.01],maxIterations:100})).toThrow(/iterations/);
    expect(()=>solveFloatingEquilibrium(box(),{massKg:.2,cgM:[.1,0,.01],maxAngleRad:Math.PI/2})).toThrow(/angle/);
  });
});
