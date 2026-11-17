/** CAD-derived mass estimates. Geometry cannot establish a real loaded mass distribution. */
import { prepareCfdHull, type CfdEnvelopeMode, type CfdHull, type CfdPoint } from './geometry';

export type MassDistribution = 'solid' | 'shell' | 'material';
export type Matrix3 = [CfdPoint, CfdPoint, CfdPoint];
export type MassTensor = Matrix3;
export interface PointMassPayload {
  name?: string;
  massKg: number;
  /** Position in the placed model frame: X from stern, Y port, Z above keel, in metres. */
  positionM: CfdPoint;
}
export interface CadMassPropertiesInput {
  trianglesMm: Float32Array;
  geometryMode: CfdEnvelopeMode;
  distribution: MassDistribution;
  /** All non-payload mass represented by the selected CAD distribution. */
  hullMassKg: number;
  payloads?: PointMassPayload[];
  /** Internal reuse only: the caller's preflight result for these exact triangles/mode. */
  preparedHull?: CfdHull;
}
export interface CadMassProperties {
  source: 'cad-estimate';
  distribution: MassDistribution;
  method: 'uniform-solid-volume' | 'uniform-printed-material-volume' | 'uniform-thickness-surface';
  massKg: number;
  hullMassKg: number;
  payloadMassKg: number;
  hullCgM: CfdPoint;
  cgM: CfdPoint;
  /** Body-frame inertia about the combined CG; products of inertia are retained. */
  inertiaTensorKgM2: MassTensor;
  /** Ixx, Iyy, Izz in model axes. These are not automatically principal moments. */
  diagonalInertiaKgM2: CfdPoint;
  /** Sorted eigenvalues, not an X/Y/Z assignment. */
  principalMomentsKgM2: CfdPoint;
  /** Dimensionless proper rotation: columns are principal axes in the placed model frame. */
  principalOrientation: Matrix3;
  inertiaReconstructionRelativeError:number;
  principalAxesAligned: boolean;
  principalAxesRelativeTolerance: number;
  offDiagonalRelative: number;
  /** Actual represented material/solid volume, never the dry cap volume for a printed shell. */
  materialVolumeM3: number | null;
  surfaceAreaM2: number;
  payloads: PointMassPayload[];
  assumptions: string[];
  warnings: string[];
}

const ALIGNMENT_TOLERANCE = 1e-3;
const sub = (a:CfdPoint,b:CfdPoint):CfdPoint => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a:CfdPoint,b:CfdPoint):CfdPoint => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a:CfdPoint,b:CfdPoint) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const point = (t:ArrayLike<number>,i:number):CfdPoint => [t[i],t[i+1],t[i+2]];
const zeroTensor = ():MassTensor => [[0,0,0],[0,0,0],[0,0,0]];

/** Neumaier summation limits cancellation in thin printed-wall volume moments. */
class Sum {
  private value=0;
  private correction=0;
  add(v:number) {
    const next=this.value+v;
    this.correction+=Math.abs(this.value)>=Math.abs(v)?(this.value-next)+v:(v-next)+this.value;
    this.value=next;
  }
  get total() { return this.value+this.correction; }
}

/** Keep physical open-surface triangles, never mass from the generated sealing deck. */
function originalOpenSurface(input:Float32Array,hull:CfdHull):Float64Array {
  const span=Math.max(hull.bounds.lengthM,hull.bounds.beamM,hull.bounds.depthM),tol=span*1e-7;
  const faces:{vertices:CfdPoint[];parity:number;key:string}[]=[];
  for(let i=0;i<input.length;i+=9) {
    const ps=[0,3,6].map(k=>[input[i+k]/1000,input[i+k+1]/1000,input[i+k+2]/1000] as CfdPoint);
    if(Math.hypot(...cross(sub(ps[1],ps[0]),sub(ps[2],ps[0])))<=tol*tol)continue;
    const keys=ps.map(p=>p.map((v,k)=>Math.round((v-hull.bounds.minM[k])/tol)).join(','));
    const parity=(Number(keys[0]>keys[1])+Number(keys[0]>keys[2])+Number(keys[1]>keys[2]))%2;
    faces.push({vertices:ps,parity,key:[...keys].sort().join('|')});
  }
  const copies=new Map<string,number[]>();
  faces.forEach((f,i)=>copies.set(f.key,[...(copies.get(f.key)||[]),i]));
  const cancelled=new Set<number>();
  for(const ids of copies.values()) {
    if(ids.length===2&&faces[ids[0]].parity!==faces[ids[1]].parity){cancelled.add(ids[0]);cancelled.add(ids[1]);}
    else if(ids.length>1)throw new Error('Repeated physical shell facets make a uniform-wall mass estimate ambiguous. Repair the CAD surface.');
  }
  return Float64Array.from(faces.flatMap((f,i)=>cancelled.has(i)?[]:f.vertices.flat()));
}

interface IntegratedDistribution {
  measure:number;
  cgM:CfdPoint;
  inertiaPerKg:MassTensor;
  surfaceAreaM2:number;
}

/** Exact triangle/tetrahedron moments, integrated about a nearby reference origin. */
function integrate(triangles:Float64Array,solid:boolean,origin:CfdPoint):IntegratedDistribution {
  // measure, first moments xyz, raw second moments xx yy zz xy xz yz.
  const sums=Array.from({length:10},()=>new Sum()),area=new Sum();
  const pairs:[[number,number],[number,number],[number,number],[number,number],[number,number],[number,number]]=[[0,0],[1,1],[2,2],[0,1],[0,2],[1,2]];
  for(let i=0;i<triangles.length;i+=9) {
    const a=sub(point(triangles,i),origin),b=sub(point(triangles,i+3),origin),c=sub(point(triangles,i+6),origin);
    const triangleArea=Math.hypot(...cross(sub(b,a),sub(c,a)))/2;
    area.add(triangleArea);
    const measure=solid?dot(a,cross(b,c))/6:triangleArea;
    const total:CfdPoint=[a[0]+b[0]+c[0],a[1]+b[1]+c[1],a[2]+b[2]+c[2]];
    sums[0].add(measure);
    for(let k=0;k<3;k++)sums[k+1].add(measure*total[k]/(solid?4:3));
    pairs.forEach(([u,v],k)=>sums[k+4].add(measure*(total[u]*total[v]+a[u]*a[v]+b[u]*b[v]+c[u]*c[v])/(solid?20:12)));
  }
  const measure=sums[0].total;
  if(!(measure>0)||!Number.isFinite(measure))throw new Error('The selected CAD mass distribution has no positive finite measure. Repair its geometry and orientation.');
  const localCg=sums.slice(1,4).map(s=>s.total/measure) as CfdPoint;
  const covariance=zeroTensor();
  pairs.forEach(([u,v],k)=>{const value=sums[k+4].total/measure-localCg[u]*localCg[v];covariance[u][v]=value;covariance[v][u]=value;});
  const trace=covariance[0][0]+covariance[1][1]+covariance[2][2],inertiaPerKg=zeroTensor();
  for(let u=0;u<3;u++)for(let v=0;v<3;v++)inertiaPerKg[u][v]=(u===v?trace:0)-covariance[u][v];
  if(inertiaPerKg.some(row=>row.some(v=>!Number.isFinite(v))))throw new Error('The CAD mass moments are not finite. Check scale and topology.');
  return {measure,cgM:localCg.map((v,k)=>v+origin[k]) as CfdPoint,inertiaPerKg,surfaceAreaM2:area.total};
}

/** Full symmetric eigensystem, preserving the orientation required by a diagonal-inertia solver. */
export function diagonalizeInertia(input:MassTensor):{momentsKgM2:CfdPoint;orientation:Matrix3;reconstructionRelativeError:number} {
  if(!Array.isArray(input)||input.length!==3||input.some(row=>!Array.isArray(row)||row.length!==3||row.some(v=>!Number.isFinite(v))))throw new Error('A finite 3 × 3 inertia tensor is required.');
  const inputScale=Math.max(...input.flat().map(Math.abs),Number.MIN_VALUE);
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(Math.abs(input[i][j]-input[j][i])>inputScale*1e-10)throw new Error('The mass inertia tensor must be symmetric.');
  const a=input.map(row=>[...row]);
  const axes:Matrix3=[[1,0,0],[0,1,0],[0,0,1]];
  for(let iteration=0;iteration<40;iteration++) {
    let p=0,q=1;
    for(const [u,v]of [[0,2],[1,2]])if(Math.abs(a[u][v])>Math.abs(a[p][q])){p=u;q=v;}
    const scale=Math.max(...a.map((row,i)=>Math.abs(row[i])),Number.MIN_VALUE);
    if(Math.abs(a[p][q])<=scale*1e-14)break;
    const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),s=Math.sin(angle),c=Math.cos(angle);
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;
    a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;
    for(let k=0;k<3;k++)if(k!==p&&k!==q) {
      const akp=a[k][p],akq=a[k][q];a[k][p]=a[p][k]=c*akp-s*akq;a[k][q]=a[q][k]=s*akp+c*akq;
    }
    for(let k=0;k<3;k++){const vkp=axes[k][p],vkq=axes[k][q];axes[k][p]=c*vkp-s*vkq;axes[k][q]=s*vkp+c*vkq;}
  }
  const order=[0,1,2].sort((i,j)=>a[i][i]-a[j][j]);
  const eigenvalues=order.map(i=>a[i][i]);
  const tolerance=Math.max(...eigenvalues.map(Math.abs),Number.MIN_VALUE)*1e-10;
  if(eigenvalues.some(v=>!Number.isFinite(v)||v< -tolerance))throw new Error('The CAD inertia is not physically positive. Check the surface geometry.');
  const momentsKgM2=eigenvalues.map(v=>Math.max(0,v)) as CfdPoint;
  if(momentsKgM2[2]>momentsKgM2[0]+momentsKgM2[1]+tolerance)throw new Error('The CAD inertia violates the rigid-body triangle inequality.');
  const orientation=axes.map(row=>order.map(i=>row[i])) as Matrix3;
  // Deterministic column signs, then make the principal frame right-handed.
  for(let col=0;col<3;col++){
    let dominant=0;for(let row=1;row<3;row++)if(Math.abs(orientation[row][col])>Math.abs(orientation[dominant][col]))dominant=row;
    if(orientation[dominant][col]<0)for(let row=0;row<3;row++)orientation[row][col]*=-1;
  }
  const determinant=dot(orientation[0],cross(orientation[1],orientation[2]));
  if(determinant<0)for(let row=0;row<3;row++)orientation[row][2]*=-1;
  let error=0;
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)error=Math.max(error,Math.abs(input[i][j]-momentsKgM2.reduce((sum,value,k)=>sum+orientation[i][k]*value*orientation[j][k],0)));
  const reconstructionRelativeError=error/inputScale;
  if(!Number.isFinite(reconstructionRelativeError)||reconstructionRelativeError>1e-9)throw new Error('Principal inertia reconstruction failed; no approximate diagonal was substituted.');
  return {momentsKgM2,orientation,reconstructionRelativeError};
}

function payloadsChecked(payloads:PointMassPayload[]|undefined):PointMassPayload[] {
  if(payloads===undefined)return [];
  if(!Array.isArray(payloads)||payloads.length>100)throw new Error('Use at most 100 ballast/cargo mass entries.');
  const result:PointMassPayload[]=[];
  for(const entry of payloads) {
    if(!entry||typeof entry!=='object'||!Number.isFinite(entry.massKg)||entry.massKg<0)throw new Error('Each ballast/cargo mass must be finite and non-negative.');
    if(entry.massKg===0)continue;
    if(!Array.isArray(entry.positionM)||entry.positionM.length!==3||entry.positionM.some(v=>!Number.isFinite(v)||Math.abs(v)>2))throw new Error('Each positive ballast/cargo mass needs a finite X/Y/Z position within ±2 metres in model axes.');
    result.push({name:typeof entry.name==='string'?entry.name.slice(0,80):'Payload',massKg:entry.massKg,positionM:[...entry.positionM]});
  }
  return result;
}

/** Estimate loaded CG from the assumed CAD distribution and explicitly positioned point loads. */
export function estimateMassProperties(input:CadMassPropertiesInput):CadMassProperties {
  if(!Number.isFinite(input.hullMassKg)||input.hullMassKg<=0)throw new Error('Hull mass must be positive after subtracting separately entered ballast and cargo.');
  if(!['solid','shell','material'].includes(input.distribution))throw new Error('Choose a supported CAD mass distribution.');
  if(input.geometryMode==='printed-shell'&&input.distribution!=='material')throw new Error('Printed-shell CG must use the actual printed material volume, not the dry displacement envelope.');
  if(input.geometryMode==='open-surface'&&input.distribution!=='shell')throw new Error('An open exterior surface requires a uniform-thickness shell estimate; a virtual cap must not add mass.');
  if(input.geometryMode!=='printed-shell'&&input.distribution==='material')throw new Error('Actual printed-material distribution requires printed-shell CAD geometry.');
  const hull=input.preparedHull??prepareCfdHull(input.trianglesMm,input.geometryMode);
  if(hull.mode!==input.geometryMode)throw new Error('Prepared geometry does not match the requested mass-estimate geometry mode.');
  const solid=input.distribution!=='shell';
  const physical=solid?hull.solverTrianglesM:input.geometryMode==='open-surface'?originalOpenSurface(input.trianglesMm,hull):hull.solverTrianglesM;
  const origin=hull.bounds.minM.map((v,k)=>(v+hull.bounds.maxM[k])/2) as CfdPoint;
  const integrated=integrate(physical,solid,origin),payloads=payloadsChecked(input.payloads),payloadMassKg=payloads.reduce((sum,p)=>sum+p.massKg,0),massKg=input.hullMassKg+payloadMassKg;
  if(!Number.isFinite(massKg))throw new Error('The combined hull and payload mass is not finite.');
  // Weighted offsets avoid cancellation when a small model has translated CAD coordinates.
  const cgM=integrated.cgM.map((v,k)=>v+payloads.reduce((sum,p)=>sum+p.massKg*(p.positionM[k]-v),0)/massKg) as CfdPoint;
  const tensor=integrated.inertiaPerKg.map(row=>row.map(v=>v*input.hullMassKg)) as MassTensor;
  const addParallelAxis=(mass:number,centre:CfdPoint)=>{
    const r=sub(centre,cgM),r2=dot(r,r);
    for(let u=0;u<3;u++)for(let v=0;v<3;v++)tensor[u][v]+=mass*((u===v?r2:0)-r[u]*r[v]);
  };
  addParallelAxis(input.hullMassKg,integrated.cgM);
  for(const payload of payloads)addParallelAxis(payload.massKg,payload.positionM);
  const diagonal:CfdPoint=[tensor[0][0],tensor[1][1],tensor[2][2]],offDiagonalRelative=Math.max(Math.abs(tensor[0][1]),Math.abs(tensor[0][2]),Math.abs(tensor[1][2]))/Math.max(...diagonal.map(Math.abs),Number.MIN_VALUE);
  const assumptions=[
    input.distribution==='material'?'Uniform density throughout the CAD solid describing the actual printed walls. Interior air and the virtual displacement cap have no mass.':input.distribution==='solid'?'The entire enclosed CAD solid is uniformly filled with material. This is not an assumption of a hollow boat.':'Constant wall thickness and uniform material density over the physical CAD surface. Thickness magnitude cancels from the estimated CG.',
    'The supplied hull mass normalizes this assumed distribution; STL alone does not determine real density, infill, ballast, electronics or cargo.',
    'All unlisted mass is included in the selected hull distribution.',
    'Ballast and cargo entries are point masses at their specified coordinates; their own dimensions, intrinsic inertia and fluid-displacing surfaces are not modeled.',
  ];
  const warnings=['CAD-derived CG and inertia are estimates, not measurements of the loaded physical ship. Check or measure them before using final team placements.'];
  if(input.distribution==='shell'&&input.geometryMode==='closed-envelope')warnings.push('Every exported exterior facet, including any CAD deck, is treated as an equal-thickness physical wall. Confirm that those surfaces correspond to the real material.');
  if(input.geometryMode==='open-surface')warnings.push('The hydrostatic/CFD virtual sealing deck is excluded from the mass estimate. The shell estimate assumes only the original open CAD surface has material.');
  if(payloads.some(p=>p.positionM.some((v,k)=>v<hull.bounds.minM[k]||v>hull.bounds.maxM[k])))warnings.push('At least one ballast/cargo centre lies outside the CAD bounding box. Confirm that its model-axis coordinates and support are intentional.');
  if(offDiagonalRelative>ALIGNMENT_TOLERANCE)warnings.push('The estimated inertia has significant off-diagonal products. The principal orientation must accompany its moments for CFD; do not substitute the diagonal or sorted moments as model-axis Ixx/Iyy/Izz.');
  const principal=diagonalizeInertia(tensor);
  return {
    source:'cad-estimate',distribution:input.distribution,
    method:input.distribution==='material'?'uniform-printed-material-volume':input.distribution==='solid'?'uniform-solid-volume':'uniform-thickness-surface',
    massKg,hullMassKg:input.hullMassKg,payloadMassKg,hullCgM:integrated.cgM,cgM,
    inertiaTensorKgM2:tensor,diagonalInertiaKgM2:diagonal,principalMomentsKgM2:principal.momentsKgM2,principalOrientation:principal.orientation,inertiaReconstructionRelativeError:principal.reconstructionRelativeError,principalAxesAligned:offDiagonalRelative<=ALIGNMENT_TOLERANCE,principalAxesRelativeTolerance:ALIGNMENT_TOLERANCE,offDiagonalRelative,
    materialVolumeM3:solid?integrated.measure:null,surfaceAreaM2:integrated.surfaceAreaM2,payloads,assumptions,warnings,
  };
}
