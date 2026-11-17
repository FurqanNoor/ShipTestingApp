import {describe,expect,it} from 'vitest';
import {boxHull} from '../src/engine/example';
import {prepareCfdHull} from '../src/cfd/geometry';
import {estimateMassProperties} from '../src/cfd/massProperties';

const box=()=>boxHull(200,60,40);
function openBox() {
  const t=box();return new Float32Array([...t.slice(0,18),...t.slice(36)]);
}
function basin() {
  const L=200,B=60,D=40,t=2;
  const p=(x:number,y:number,z:number)=>[x,y,z],faces:number[]=[];
  const q=(a:number[],b:number[],c:number[],d:number[])=>faces.push(...a,...b,...c,...a,...c,...d);
  const outer=[[0,-B/2],[L,-B/2],[L,B/2],[0,B/2]],inner=[[t,-B/2+t],[L-t,-B/2+t],[L-t,B/2-t],[t,B/2-t]];
  const ob=outer.map(([x,y])=>p(x,y,0)),ot=outer.map(([x,y])=>p(x,y,D)),ib=inner.map(([x,y])=>p(x,y,t)),it=inner.map(([x,y])=>p(x,y,D));
  q(ob[3],ob[2],ob[1],ob[0]);q(ib[0],ib[1],ib[2],ib[3]);
  for(let i=0;i<4;i++){const j=(i+1)%4;q(ob[i],ob[j],ot[j],ot[i]);q(ib[i],it[i],it[j],ib[j]);q(ot[i],ot[j],it[j],it[i]);}
  return new Float32Array(faces);
}
const solid=(trianglesMm=box(),hullMassKg=.24)=>estimateMassProperties({trianglesMm,geometryMode:'closed-envelope',distribution:'solid',hullMassKg});
function tetrahedron(a=120,b=90,c=60) {
  const p=[[0,0,0],[a,0,0],[0,b,0],[0,0,c]],f=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]];
  return new Float32Array(f.flatMap(ids=>ids.flatMap(i=>p[i])));
}

describe('CAD estimates preserve physical distribution assumptions',()=>{
  it('uniform solid box CG and full central inertia match analytical values',()=>{
    const r=solid();[.1,0,.02].forEach((v,i)=>expect(r.cgM[i]).toBeCloseTo(v,14));
    expect(r.diagonalInertiaKgM2[0]).toBeCloseTo(.24*(.06**2+.04**2)/12,14);
    expect(r.diagonalInertiaKgM2[1]).toBeCloseTo(.24*(.2**2+.04**2)/12,14);
    expect(r.diagonalInertiaKgM2[2]).toBeCloseTo(.24*(.2**2+.06**2)/12,14);
    expect(r.inertiaTensorKgM2[0][1]).toBeCloseTo(0,15);expect(r.principalAxesAligned).toBe(true);
    expect(r.materialVolumeM3).toBeCloseTo(.00048,14);expect(r.source).toBe('cad-estimate');
  });
  it('closed thin-shell inertia differs from the solid using exact face-area weighting',()=>{
    const r=estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'shell',hullMassKg:.24});
    const L=.2,B=.06,D=.04,area=2*(L*B+L*D+B*D);
    const ixx=.24/area*(2*L*B*(B*B/12+D*D/4)+2*L*D*(B*B/4+D*D/12)+2*B*D*(B*B/12+D*D/12));
    expect(r.diagonalInertiaKgM2[0]).toBeCloseTo(ixx,14);expect(r.diagonalInertiaKgM2[0]).toBeGreaterThan(solid().diagonalInertiaKgM2[0]);expect(r.materialVolumeM3).toBeNull();
  });
  it('uses printed wall material, not the virtually capped dry volume',()=>{
    const r=estimateMassProperties({trianglesMm:basin(),geometryMode:'printed-shell',distribution:'material',hullMassKg:.05});
    const outside=.2*.06*.04,inside=.196*.056*.038,expectedZ=(outside*.02-inside*.021)/(outside-inside);
    expect(r.materialVolumeM3).toBeCloseTo(outside-inside,14);expect(r.cgM[2]).toBeCloseTo(expectedZ,12);
    expect(r.cgM[2]).toBeLessThan(.014);expect(r.cgM[0]).toBeCloseTo(.1,14);expect(r.cgM[1]).toBeCloseTo(0,14);
    const ixx=.05/(outside-inside)*(outside*((.06**2+.04**2)/12+(.02-expectedZ)**2)-inside*((.056**2+.038**2)/12+(.021-expectedZ)**2));
    expect(r.diagonalInertiaKgM2[0]).toBeCloseTo(ixx,13);
  });
  it('never adds virtual deck mass to an open exterior skin',()=>{
    const r=estimateMassProperties({trianglesMm:openBox(),geometryMode:'open-surface',distribution:'shell',hullMassKg:.05});
    const sides=2*(.2+.06)*.04,area=.2*.06+sides;
    expect(r.surfaceAreaM2).toBeCloseTo(area,14);expect(r.cgM[2]).toBeCloseTo(sides*.02/area,14);expect(r.cgM[2]).not.toBeCloseTo(.02,4);
  });
  it('does not count opposite internal interface copies as physical shell mass',()=>{
    const raw=openBox(),a=[30,0,10],b=[70,0,10],c=[50,10,20];
    const withInterface=new Float32Array([...raw,...a,...b,...c,...a,...c,...b]);
    const plain=estimateMassProperties({trianglesMm:raw,geometryMode:'open-surface',distribution:'shell',hullMassKg:.05});
    const cleaned=estimateMassProperties({trianglesMm:withInterface,geometryMode:'open-surface',distribution:'shell',hullMassKg:.05});
    expect(cleaned.surfaceAreaM2).toBeCloseTo(plain.surfaceAreaM2,14);for(let i=0;i<3;i++)expect(cleaned.cgM[i]).toBeCloseTo(plain.cgM[i],14);
  });
  it('distinguishes axes from sorted principal moments on a nontrivial tetrahedron',()=>{
    const a=.12,b=.09,c=.06,m=.3,r=solid(tetrahedron(),m);
    expect(r.cgM[0]).toBeCloseTo(a/4,13);expect(r.cgM[1]).toBeCloseTo(b/4,13);expect(r.cgM[2]).toBeCloseTo(c/4,13);
    expect(r.inertiaTensorKgM2[0][0]).toBeCloseTo(3*m*(b*b+c*c)/80,14);
    expect(r.inertiaTensorKgM2[0][1]).toBeCloseTo(m*a*b/80,14);expect(r.inertiaTensorKgM2[1][2]).toBeCloseTo(m*b*c/80,14);
    expect(r.principalAxesAligned).toBe(false);expect(r.warnings.join(' ')).toMatch(/off-diagonal/);
  });
  it('finds the analytic regular tetrahedron eigenvalues without assigning them to body axes',()=>{
    const m=.3,a=.1,r=solid(tetrahedron(100,100,100),m);
    expect(r.principalMomentsKgM2[0]).toBeCloseTo(m*a*a/16,14);expect(r.principalMomentsKgM2[1]).toBeCloseTo(m*a*a/16,14);expect(r.principalMomentsKgM2[2]).toBeCloseTo(m*a*a/10,14);
  });
  it('applies the parallel-axis theorem and weighted CG to a known point payload',()=>{
    const r=estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.2,payloads:[{name:'Cargo',massKg:.1,positionM:[.1,0,.08]}]});
    const z=(.2*.02+.1*.08)/.3,ixx=.2*(.06**2+.04**2)/12+.2*(.02-z)**2+.1*(.08-z)**2;
    expect(r.massKg).toBeCloseTo(.3,14);expect(r.cgM[2]).toBeCloseTo(z,14);expect(r.diagonalInertiaKgM2[0]).toBeCloseTo(ixx,14);expect(r.payloadMassKg).toBe(.1);
  });
  it('retains products of inertia from a cargo mass away from a symmetry plane',()=>{
    const r=estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.2,payloads:[{massKg:.1,positionM:[.15,.02,.08]}]});
    const expectedX=(.2*.1+.1*.15)/.3,expectedY=.1*.02/.3,expectedZ=(.2*.02+.1*.08)/.3;
    expect(r.cgM[0]).toBeCloseTo(expectedX,14);expect(r.cgM[1]).toBeCloseTo(expectedY,14);expect(r.cgM[2]).toBeCloseTo(expectedZ,14);
    const ixy=-(.2*(.1-expectedX)*(0-expectedY)+.1*(.15-expectedX)*(.02-expectedY));expect(r.inertiaTensorKgM2[0][1]).toBeCloseTo(ixy,14);expect(r.principalAxesAligned).toBe(false);
  });
  it('is invariant to translation apart from the returned CG coordinates',()=>{
    const r=solid(),shift:[number,number,number]=[1000,-500,1000],translated=box().map((v,i)=>v+shift[i%3]),t=solid(translated);
    for(let i=0;i<3;i++){expect(t.cgM[i]-r.cgM[i]).toBeCloseTo(shift[i]/1000,12);for(let j=0;j<3;j++)expect(t.inertiaTensorKgM2[i][j]).toBeCloseTo(r.inertiaTensorKgM2[i][j],12);}
  });
  it('scales geometric mass properties correctly at constant density',()=>{
    const r=solid(),s=solid(box().map(v=>v*.5),.24*.5**3);
    for(let i=0;i<3;i++){expect(s.cgM[i]).toBeCloseTo(r.cgM[i]*.5,13);for(let j=0;j<3;j++)expect(s.inertiaTensorKgM2[i][j]).toBeCloseTo(r.inertiaTensorKgM2[i][j]*.5**5,14);}
  });
  it('repairs winding before solid integration and does not mutate the source',()=>{
    const t=box(),before=t.slice();for(let i=0;i<t.length;i+=9){const b=t.slice(i+3,i+6);t.copyWithin(i+3,i+6,i+9);t.set(b,i+6);}const reversed=t.slice();const r=solid(t);
    expect(r.cgM[2]).toBeCloseTo(solid(before).cgM[2],14);expect(Array.from(t)).toEqual(Array.from(reversed));
  });
  it('reuses only a matching prepared geometry mode',()=>{
    const hull=prepareCfdHull(box(),'closed-envelope');const r=estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.24,preparedHull:hull});expect(r.cgM[0]).toBeCloseTo(.1,14);
    expect(()=>estimateMassProperties({trianglesMm:openBox(),geometryMode:'open-surface',distribution:'shell',hullMassKg:.24,preparedHull:hull})).toThrow(/does not match/);
  });
  it('refuses to treat an open cap or dry printed envelope as real solid mass',()=>{
    expect(()=>estimateMassProperties({trianglesMm:openBox(),geometryMode:'open-surface',distribution:'solid',hullMassKg:.1})).toThrow(/virtual cap/);
    expect(()=>estimateMassProperties({trianglesMm:basin(),geometryMode:'printed-shell',distribution:'solid',hullMassKg:.1})).toThrow(/actual printed material/);
  });
  it('rejects impossible mass and nonfinite payload data without a fallback CG',()=>{
    expect(()=>solid(box(),0)).toThrow(/Hull mass/);
    expect(()=>estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.1,payloads:[{massKg:-.1,positionM:[0,0,0]}]})).toThrow(/non-negative/);
    expect(()=>estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.1,payloads:[{massKg:.1,positionM:[NaN,0,0]}]})).toThrow(/finite X/);
  });
  it('ignores empty zero-mass load rows and records intentionally outboard loads',()=>{
    const r=estimateMassProperties({trianglesMm:box(),geometryMode:'closed-envelope',distribution:'solid',hullMassKg:.1,payloads:[{massKg:0,positionM:[NaN,NaN,NaN]},{massKg:.01,positionM:[.1,0,.08]}]});expect(r.payloads).toHaveLength(1);expect(r.warnings.join(' ')).toMatch(/outside the CAD/);
  });
});
