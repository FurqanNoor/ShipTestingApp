import {describe,it,expect} from 'vitest';
import {boxHull} from '../src/engine/example';
import {createAutomaticPlan,inferPrintedWallResolution,AUTOMATIC_PROTOCOL} from '../src/cfd/automatic';
import {prepareCfdHull} from '../src/cfd/geometry';

const openBox=()=>{const t=boxHull(200,60,40);return new Float32Array([...t.slice(0,18),...t.slice(36)]);};
function basin(L=200,B=60,D=40,t=2):Float32Array {
  const outer=[[0,-B/2],[L,-B/2],[L,B/2],[0,B/2]],inner=[[t,-B/2+t],[L-t,-B/2+t],[L-t,B/2-t],[t,B/2-t]],faces:number[]=[];
  const ring=(ps:number[][],z:number)=>ps.map(p=>[p[0],p[1],z]),ob=ring(outer,0),ot=ring(outer,D),ib=ring(inner,t),it=ring(inner,D);
  const q=(a:number[],b:number[],c:number[],d:number[])=>faces.push(...a,...b,...c,...a,...c,...d);
  q(ob[3],ob[2],ob[1],ob[0]);q(ib[0],ib[1],ib[2],ib[3]);
  for(let i=0;i<4;i++){const j=(i+1)%4;q(ob[i],ob[j],ot[j],ot[i]);q(ib[i],it[i],it[j],ib[j]);q(ot[i],ot[j],it[j],it[i]);}
  return new Float32Array(faces);
}

describe('Unattended standard comparison planning',()=>{
  it('prepares all twelve physical conditions without asking for manual values',()=>{
    const p=createAutomaticPlan({name:'Team hull',trianglesMm:boxHull(220,80,45)});
    expect(p.conditions).toHaveLength(12);expect(new Set(p.conditions.map(c=>c.id)).size).toBe(12);
    expect(p.defaults.loadsKg).toEqual([.15,.25,.35]);expect(p.conditions.filter(c=>c.mode==='calm')).toHaveLength(3);
    expect(p.conditions.filter(c=>c.mode==='beam-waves')).toHaveLength(9);
    for(const c of p.conditions){expect(c.request.measurementsConfirmed).toBe(false);expect(c.request.automation).toEqual({schema:1,protocol:AUTOMATIC_PROTOCOL});expect(c.request.cgSource).toBe('cad-estimate');expect(c.request.cgEstimate.payloads).toHaveLength(1);expect(c.request.cgEstimate.payloads[0].massKg).toBeCloseTo(c.massKg/2,12);expect(c.request.cgEstimate.payloads[0].positionM[1]).toBe(0);}
    expect(p.assumptions.join(' ')).toContain('not measured');
  });
  it('identifies actual printed walls before treating the watertight material as an exterior hull',()=>{
    const p=createAutomaticPlan({trianglesMm:basin()});
    expect(p.geometryMode).toBe('printed-shell');expect(p.distribution).toBe('material');
    expect(p.minimumWallThicknessM).toBeCloseTo(.0016,10);
    expect(p.conditions.every(c=>c.request.minimumWallThicknessM===p.minimumWallThicknessM)).toBe(true);
  });
  it('uses physical open surface geometry without inventing wall thickness or virtual-deck mass',()=>{
    const p=createAutomaticPlan({trianglesMm:openBox()});
    expect(p.geometryMode).toBe('open-surface');expect(p.distribution).toBe('shell');expect(p).not.toHaveProperty('minimumWallThicknessM');
    expect(p.geometryNotes.join(' ')).toContain('cannot reproduce flooding');
  });
  it('labels the interpretation of a plain closed STL as an assumption, not proof of its construction',()=>{
    const p=createAutomaticPlan({trianglesMm:boxHull(200,60,40)});
    expect(p.geometryMode).toBe('closed-envelope');expect(p.distribution).toBe('shell');
    expect(p.geometryNotes.join(' ')).toContain('Hidden construction cannot be inferred');
  });
  it('preserves physical wave scaling and separates calm towing from zero-current roll tests',()=>{
    const full=createAutomaticPlan({trianglesMm:boxHull(220,80,45)}),half=createAutomaticPlan({trianglesMm:boxHull(110,40,22.5)});
    full.conditions.forEach((c,i)=>{
      if(c.mode==='calm'){expect(c.request.speedMps).toBe(.3);expect(c.request.durationS).toBeGreaterThanOrEqual(10);expect(c.request).not.toHaveProperty('inertiaSource');}
      else{expect(c.request.speedMps).toBe(0);expect(c.request.inertiaSource).toBe('cad-estimate');expect(half.conditions[i].waveHeightM).toBeCloseTo(c.waveHeightM!*.5,12);expect(half.conditions[i].wavePeriodS).toBeCloseTo(c.wavePeriodS!*Math.sqrt(.5),12);expect(c.request.durationS).toBeCloseTo(60*c.wavePeriodS!,12);}
    });
  });
  it('uses exactly the same wave conditions for all three weights',()=>{
    const p=createAutomaticPlan({trianglesMm:boxHull(220,80,45)}),rows=p.conditions.filter(c=>c.mode==='beam-waves');
    expect(rows.slice(0,3).map(c=>[c.waveHeightM,c.wavePeriodS])).toEqual(rows.slice(3,6).map(c=>[c.waveHeightM,c.wavePeriodS]));
    expect(rows.slice(3,6).map(c=>[c.waveHeightM,c.wavePeriodS])).toEqual(rows.slice(6,9).map(c=>[c.waveHeightM,c.wavePeriodS]));
  });
  it('does not remove or change prescribed masses for a small hull that will be overloaded',()=>{
    const p=createAutomaticPlan({trianglesMm:boxHull(50,20,10)});expect(p.conditions).toHaveLength(12);expect(p.defaults.loadsKg).toEqual([.15,.25,.35]);
  });
  it('does not mutate or resize the submitted geometry',()=>{
    const raw=basin(),before=raw.slice(),p=createAutomaticPlan({trianglesMm:raw});
    expect(Array.from(raw)).toEqual(Array.from(before));raw[0]=999;expect(p.conditions[0].request.trianglesMm[0]).toBe(before[0]);
  });
  it('rejects invalid and oversized CAD without a generic substitute hull',()=>{
    expect(()=>createAutomaticPlan({trianglesMm:boxHull(251,60,40)})).toThrow(/250/);
    expect(()=>createAutomaticPlan({trianglesMm:[0,0,0]})).toThrow(/complete CAD triangles/);
    const invalid=boxHull(200,60,40);invalid[0]=NaN;expect(()=>createAutomaticPlan({trianglesMm:invalid})).toThrow(/finite/);
    expect(()=>createAutomaticPlan({trianglesMm:boxHull(200,60,40).slice(9)})).toThrow(/preparation failed/);
  });
  it('rejects an unsupported sloping open rim rather than silently flattening or sealing it',()=>{
    const t=openBox();for(let i=0;i<t.length;i+=3)if(t[i+2]===40)t[i+2]+=t[i]/20;
    expect(()=>createAutomaticPlan({trianglesMm:t})).toThrow(/horizontal/);
  });
});

describe('CAD wall-resolution inference',()=>{
  it('recovers a known 2 mm wall distance with an explicit sampling margin and limitation',()=>{
    const r=inferPrintedWallResolution(prepareCfdHull(basin(),'printed-shell'));
    expect(r.sampledMinimumM).toBeCloseTo(.002,12);expect(r.minimumWallThicknessM).toBeCloseTo(.0016,12);expect(r.hitCount).toBeGreaterThanOrEqual(3);
    expect(r.notes.join(' ')).toContain('not a certified minimum');
  });
  it('scales the inferred resolution length with the physical CAD, independent of winding',()=>{
    const t=basin(100,30,20,1);for(let i=0;i<t.length;i+=9){const b=t.slice(i+3,i+6);t.copyWithin(i+3,i+6,i+9);t.set(b,i+6);}
    const r=inferPrintedWallResolution(prepareCfdHull(t,'printed-shell'));expect(r.minimumWallThicknessM).toBeCloseTo(.0008,12);
  });
  it('never infers a material wall thickness from a zero-thickness displacement skin',()=>{
    expect(()=>inferPrintedWallResolution(prepareCfdHull(openBox(),'open-surface'))).toThrow(/actual printed-material/);
  });
});
