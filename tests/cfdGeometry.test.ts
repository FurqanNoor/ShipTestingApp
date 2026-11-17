import { describe,expect,it } from 'vitest';
import { boxHull,exampleHull } from '../src/engine/example';
import { prepareCfdHull } from '../src/cfd/geometry';

function concatenate(...parts:Float32Array[]) {
  const out=new Float32Array(parts.reduce((sum,p)=>sum+p.length,0));let offset=0;
  for(const p of parts){out.set(p,offset);offset+=p.length;}return out;
}
function translate(t:Float32Array,dx=0,dy=0,dz=0) {return t.map((v,i)=>v+[dx,dy,dz][i%3]);}
function removeDeck(t:Float32Array){return concatenate(t.slice(0,18),t.slice(36));}
function reverse(t:Float32Array) {
  const out=t.slice();for(let i=0;i<t.length;i+=9)for(let k=0;k<3;k++){out[i+3+k]=t[i+6+k];out[i+6+k]=t[i+3+k];}return out;
}
function printedBasin() {
  const outside=reverse(removeDeck(boxHull(200,60,40)));
  const inside=removeDeck(translate(boxHull(196,56,38),2,0,2));
  const corners=[[0,-30,40],[200,-30,40],[200,30,40],[0,30,40]];
  const inset=[[2,-28,40],[198,-28,40],[198,28,40],[2,28,40]],rim:number[]=[];
  for(let k=0;k<4;k++){const j=(k+1)%4;rim.push(...corners[k],...corners[j],...inset[j],...corners[k],...inset[j],...inset[k]);}
  return concatenate(outside,inside,new Float32Array(rim));
}
function signedVolume(t:Float64Array) {
  let v=0;
  for(let i=0;i<t.length;i+=9)v+=(t[i]*(t[i+4]*t[i+8]-t[i+5]*t[i+7])+t[i+1]*(t[i+5]*t[i+6]-t[i+3]*t[i+8])+t[i+2]*(t[i+3]*t[i+7]-t[i+4]*t[i+6]))/6;
  return v;
}
function openPolygonExtrusion(loop:[number,number][],height:number) {
  const faces:number[]=[];
  // Interior-centre fan retains every subdivided boundary edge, without T-junctions.
  const center=[loop.reduce((s,p)=>s+p[0],0)/loop.length,loop.reduce((s,p)=>s+p[1],0)/loop.length];
  for(let k=0;k<loop.length;k++){const j=(k+1)%loop.length;faces.push(center[0],center[1],0,loop[j][0],loop[j][1],0,loop[k][0],loop[k][1],0);}
  for(let k=0;k<loop.length;k++){
    const a=loop[k],b=loop[(k+1)%loop.length];
    faces.push(a[0],a[1],0,b[0],b[1],0,b[0],b[1],height,a[0],a[1],0,b[0],b[1],height,a[0],a[1],height);
  }
  return new Float32Array(faces);
}

describe('CFD mesh geometry preflight derived from the uploaded workbench',()=>{
  it('integrates exact closed-box volume and centroid in metres',()=>{
    const h=prepareCfdHull(boxHull(200,60,40),'closed-envelope');
    expect(h.volumeM3).toBeCloseTo(.2*.06*.04,12);
    expect(h.centroidM[0]).toBeCloseTo(.1,12);expect(h.centroidM[1]).toBeCloseTo(0,12);expect(h.centroidM[2]).toBeCloseTo(.02,12);
    expect(h.bounds.lengthM).toBeCloseTo(.2,12);expect(h.bounds.beamM).toBeCloseTo(.06,12);
    expect(h.virtualCap).toBe(false);expect(h.displacementVirtualCap).toBe(false);
    expect(h.solverTrianglesM).toBe(h.trianglesM);expect(signedVolume(h.trianglesM)).toBeGreaterThan(0);
  });
  it('repairs independently reversed faces to consistent outward orientation',()=>{
    const t=boxHull(200,60,40);for(let i=0;i<t.length;i+=18){const a=t.slice(i+3,i+6);t.copyWithin(i+3,i+6,i+9);t.set(a,i+6);}
    const h=prepareCfdHull(t,'closed-envelope');expect(signedVolume(h.trianglesM)).toBeCloseTo(.00048,12);
  });
  it('reconstructs an open flat-bottom outer skin up to its true rim',()=>{
    const h=prepareCfdHull(removeDeck(boxHull(200,60,40)),'open-surface');
    expect(h.volumeM3).toBeCloseTo(.00048,12);expect(h.rimVerticesM).toHaveLength(4);
    expect(h.virtualCap).toBe(true);expect(h.solverGeometryKind).toBe('sealed-envelope');
    expect(h.notes.join(' ')).toMatch(/cannot reproduce flooding/);
  });
  it('separates dry displacement from actual printed material for flooding CFD',()=>{
    const h=prepareCfdHull(printedBasin(),'printed-shell');
    expect(h.volumeM3).toBeCloseTo(.00048,12);
    expect(signedVolume(h.solverTrianglesM)).toBeCloseTo((200*60*40-196*56*38)*1e-9,12);
    expect(h.solverGeometryKind).toBe('printed-material');expect(h.virtualCap).toBe(false);expect(h.displacementVirtualCap).toBe(true);
    expect(h.solverTriangleCount).toBeGreaterThan(h.triangleCount);
  });
  it('retains original CAD arrays unchanged in every preparation mode',()=>{
    const raw=printedBasin(),before=raw.slice();prepareCfdHull(raw,'printed-shell');expect(Array.from(raw)).toEqual(Array.from(before));
  });
  it('supports disjoint side-by-side closed catamaran pontoons',()=>{
    const t=concatenate(translate(boxHull(200,20,40),0,-30),translate(boxHull(200,20,40),0,30));
    const h=prepareCfdHull(t,'closed-envelope');expect(h.volumeM3).toBeCloseTo(.00032,12);expect(h.centroidM[1]).toBeCloseTo(0,12);
  });
  it('rejects nested disconnected shells instead of adding hidden volume',()=>{
    const t=concatenate(boxHull(200,60,40),translate(boxHull(100,20,10),50,0,10));
    expect(()=>prepareCfdHull(t,'closed-envelope')).toThrow(/overlap or one is nested/);
  });
  it('rejects a closed-mode missing facet rather than silently healing it',()=>{
    expect(()=>prepareCfdHull(boxHull(200,60,40).slice(9),'closed-envelope')).toThrow(/not watertight/);
  });
  it('rejects duplicate non-manifold faces',()=>{
    const t=boxHull(200,60,40);expect(()=>prepareCfdHull(concatenate(t,t.slice(0,9)),'closed-envelope')).toThrow(/not watertight|non-manifold/);
  });
  it('rejects non-finite coordinates and out-of-limit hulls',()=>{
    const t=boxHull(200,60,40);t[0]=NaN;expect(()=>prepareCfdHull(t,'closed-envelope')).toThrow(/non-finite/);
    expect(()=>prepareCfdHull(boxHull(251,60,40),'closed-envelope')).toThrow(/250/);
    expect(()=>prepareCfdHull(boxHull(200,251,40),'closed-envelope')).toThrow(/250/);
  });
  it('rejects a solid block when printed-shell extraction has no inner cavity',()=>{
    expect(()=>prepareCfdHull(boxHull(200,60,40),'printed-shell')).toThrow(/does not separate/);
  });
  it('rejects extra closed cargo rather than silently deleting it',()=>{
    const t=concatenate(printedBasin(),translate(boxHull(10,10,10),80,0,5));
    expect(()=>prepareCfdHull(t,'printed-shell')).toThrow(/overlap or nest|cargo|skin/);
  });
  it('rejects a sloping open rim requiring an explicit CAD envelope',()=>{
    const t=removeDeck(boxHull(200,60,40));for(let i=0;i<t.length;i+=3)if(t[i+2]===40)t[i+2]+=t[i]/20;
    expect(()=>prepareCfdHull(t,'open-surface')).toThrow(/horizontal rim|horizontal/);
  });
  it('caps a finely subdivided rim without losing manifold boundary edges',()=>{
    const loop:[number,number][]=[];
    for(let x=0;x<200;x+=10)loop.push([x,-30]);for(let y=-30;y<30;y+=10)loop.push([200,y]);
    for(let x=200;x>0;x-=10)loop.push([x,30]);for(let y=30;y>-30;y-=10)loop.push([0,y]);
    const h=prepareCfdHull(openPolygonExtrusion(loop,40),'open-surface');
    expect(h.volumeM3).toBeCloseTo(.00048,12);expect(h.rimVerticesM).toHaveLength(loop.length);
  });
  it('accepts the uploaded base example after removing its zero-area tip facets',()=>{
    const h=prepareCfdHull(exampleHull(),'closed-envelope');expect(h.volumeM3).toBeGreaterThan(0);expect(h.bounds.lengthM).toBeCloseTo(.22,10);
    expect(signedVolume(h.trianglesM)).toBeCloseTo(h.volumeM3,12);
  });
});
