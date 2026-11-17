/**
 * CFD geometry preflight for the uploaded workbench. No column raster is used.
 * App coordinates are X forward from stern, Y port, Z up from keel; input mm.
 */
export type CfdPoint = [number, number, number];
export type CfdEnvelopeMode = 'closed-envelope'|'open-surface'|'printed-shell';
export interface CfdBounds {
  minM:CfdPoint;
  maxM:CfdPoint;
  lengthM:number;
  beamM:number;
  depthM:number;
}
export interface CfdHull {
  /** Closed exterior displacement envelope, used only for dry hydro initialization. */
  trianglesM:Float64Array;
  /** Actual CFD solid: printed walls/interior preserved for printed-shell mode. */
  solverTrianglesM:Float64Array;
  solverGeometryKind:'printed-material'|'sealed-envelope';
  /** True only if the solver mesh itself has an artificial sealing deck. */
  virtualCap:boolean;
  displacementVirtualCap:boolean;
  volumeM3:number;
  centroidM:CfdPoint;
  bounds:CfdBounds;
  rimVerticesM:CfdPoint[];
  notes:string[];
  triangleCount:number;
  solverTriangleCount:number;
  mode:CfdEnvelopeMode;
}

type Face=[number,number,number];
interface Topology {points:CfdPoint[];faces:Face[];tolerance:number;removedDegenerate:number;removedCoincident:number;pairedNonManifoldEdges?:number}
export interface EdgeUse {face:number;from:number;to:number}
const minus=(a:CfdPoint,b:CfdPoint):CfdPoint=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:CfdPoint,b:CfdPoint):CfdPoint=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:CfdPoint,b:CfdPoint)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
// Numeric keys (vertex ids stay far below 2^26, so the product is exact): much faster than string keys on dense CAD.
const edgeKey=(a:number,b:number)=>a<b?a*67108864+b:b*67108864+a;

function boundsOf(points:CfdPoint[]):CfdBounds {
  const minM:CfdPoint=[Infinity,Infinity,Infinity],maxM:CfdPoint=[-Infinity,-Infinity,-Infinity];
  for(const p of points)for(let d=0;d<3;d++){minM[d]=Math.min(minM[d],p[d]);maxM[d]=Math.max(maxM[d],p[d]);}
  return {minM,maxM,lengthM:maxM[0]-minM[0],beamM:maxM[1]-minM[1],depthM:maxM[2]-minM[2]};
}
function edgesOf(t:Topology):Map<number|string,EdgeUse[]> {
  const edges=new Map<number|string,EdgeUse[]>();
  for(let i=0;i<t.faces.length;i++)for(let k=0;k<3;k++){
    const from=t.faces[i][k],to=t.faces[i][(k+1)%3],key=edgeKey(from,to),uses=edges.get(key);
    const use={face:i,from,to};if(uses)uses.push(use);else edges.set(key,[use]);
  }
  return edges;
}
/**
 * Multi-body CAD exports often have bodies touching along an edge, so that edge is shared by 4 (or 6...) faces.
 * When the surface is consistently oriented there (equal numbers of uses in each direction), pair each use with an
 * opposite one: the result is a closed oriented surface with well-defined volume. Unbalanced edges are still rejected.
 */
export function pairNonManifoldEdges(edges:Map<number|string,EdgeUse[]>):{edges:Map<number|string,EdgeUse[]>;paired:number}{
  let paired=0;const out=new Map<number|string,EdgeUse[]>();
  for(const [key,uses] of edges){
    if(uses.length<=2){out.set(key,uses);continue;}
    const fwd=uses.filter(u=>u.from<u.to),rev=uses.filter(u=>u.from>u.to);
    if(uses.length%2||fwd.length!==rev.length){out.set(key,uses);continue;}
    paired++;fwd.forEach((u,i)=>out.set(`${key}#${i}`,[u,rev[i]]));
  }
  return {edges:out,paired};
}
function connected(t:Topology,edges=edgesOf(t)):number[][] {
  const adjacent=t.faces.map(()=>[] as number[]);
  for(const uses of edges.values()){
    if(uses.length>2)throw new Error('The STL has non-manifold edges. Export one clean hull surface without duplicate faces or internal assemblies.');
    if(uses.length===2){adjacent[uses[0].face].push(uses[1].face);adjacent[uses[1].face].push(uses[0].face);}
  }
  const seen=new Uint8Array(t.faces.length),groups:number[][]=[];
  for(let i=0;i<t.faces.length;i++)if(!seen[i]){
    const group=[i];seen[i]=1;
    for(let j=0;j<group.length;j++)for(const n of adjacent[group[j]])if(!seen[n]){seen[n]=1;group.push(n);}
    groups.push(group);
  }
  return groups;
}
// Planning tries up to three geometry modes on the same triangles; weld them once. Topologies are treated as read-only.
const topologyCache=new WeakMap<Float32Array,Topology>();
function makeTopology(input:Float32Array):Topology {
  const cached=topologyCache.get(input);if(cached)return cached;
  const built=buildTopology(input);topologyCache.set(input,built);return built;
}
function buildTopology(input:Float32Array):Topology {
  if(!input.length||input.length%9!==0||input.length/9>500000)throw new Error('Use a complete triangular STL with at most 500,000 faces.');
  const sourcePoints:CfdPoint[]=[];
  for(let i=0;i<input.length;i+=3){
    const p:CfdPoint=[input[i]/1000,input[i+1]/1000,input[i+2]/1000];
    if(p.some(v=>!Number.isFinite(v)))throw new Error('The STL contains non-finite coordinates.');
    sourcePoints.push(p);
  }
  const b=boundsOf(sourcePoints),spans=[b.lengthM,b.beamM,b.depthM];
  if(spans.some(v=>!(v>0)))throw new Error('The hull must have positive length, beam and depth.');
  // Build-volume limit for competition entries: 250 x 250 x 250 mm.
  if(b.lengthM>0.2500005||b.beamM>0.2500005||b.depthM>0.2500005)throw new Error('The oriented hull exceeds the 250 × 250 × 250 mm build volume. Correct STL units or resize the CAD model before CFD.');
  const tolerance=Math.max(...spans)*1e-7;
  const points:CfdPoint[]=[],buckets=new Map<string,number[]>(),exact=new Map<string,number>(),faces:Face[]=[];
  // Exact repeats (the normal case: every STL vertex is listed once per face) hit the first map. New points search
  // only the 8 cells (2 × tolerance wide) on their own side of each cell boundary, which covers every point within tolerance.
  function index(p:CfdPoint,i:number):number {
    const exactKey=input[i]+','+input[i+1]+','+input[i+2],known=exact.get(exactKey);
    if(known!==undefined)return known;
    const cell=2*tolerance,f0=p[0]/cell,f1=p[1]/cell,f2=p[2]/cell,c0=Math.floor(f0),c1=Math.floor(f1),c2=Math.floor(f2);
    const s0=f0-c0<.5?-1:1,s1=f1-c1<.5?-1:1,s2=f2-c2<.5?-1:1;
    for(const x of [0,s0])for(const y of [0,s1])for(const z of [0,s2]){
      const list=buckets.get((c0+x)+','+(c1+y)+','+(c2+z));
      if(list)for(const id of list){const q=points[id];if(Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2])<=tolerance){exact.set(exactKey,id);return id;}}
    }
    const id=points.length,key=c0+','+c1+','+c2;points.push(p);exact.set(exactKey,id);
    const list=buckets.get(key);if(list)list.push(id);else buckets.set(key,[id]);return id;
  }
  let removedDegenerate=0;
  for(let i=0;i<sourcePoints.length;i+=3){
    const f:Face=[index(sourcePoints[i],3*i),index(sourcePoints[i+1],3*i+3),index(sourcePoints[i+2],3*i+6)];
    if(new Set(f).size<3||Math.hypot(...cross(minus(points[f[1]],points[f[0]]),minus(points[f[2]],points[f[0]])))<=tolerance*tolerance){removedDegenerate++;continue;}
    faces.push(f);
  }
  // Opposite copies of the exact same triangular interface carry zero solid volume.
  // They occur in the supplied ferry's pinched bow; cancel pairs explicitly, never
  // discard a lone same-winding duplicate or infer intersections between other faces.
  const copies=new Map<string,number[]>(),cancelled=new Set<number>();
  const parity=(f:Face)=>(Number(f[0]>f[1])+Number(f[0]>f[2])+Number(f[1]>f[2]))%2;
  faces.forEach((f,i)=>{const key=[...f].sort((a,b)=>a-b).join(',');copies.set(key,[...(copies.get(key)||[]),i]);});
  for(const uses of copies.values())if(uses.length===2&&parity(faces[uses[0]])!==parity(faces[uses[1]])){cancelled.add(uses[0]);cancelled.add(uses[1]);}
  const exteriorFaces=faces.filter((_,i)=>!cancelled.has(i));
  if(exteriorFaces.length<4)throw new Error('The STL has too few non-degenerate exterior faces to enclose a hull.');
  return {points,faces:exteriorFaces,tolerance,removedDegenerate,removedCoincident:cancelled.size};
}

/** Validate a closed orientable manifold, repair face winding, and integrate solid moments. */
function closedSolid(t:Topology) {
  const {edges,paired}=pairNonManifoldEdges(edgesOf(t));t.pairedNonManifoldEdges=paired;
  if([...edges.values()].some(e=>e.length>2))throw new Error('The STL has non-manifold edges with inconsistent orientation (overlapping or inside-out parts). Export one clean hull surface without duplicate faces or internal assemblies.');
  if([...edges.values()].some(e=>e.length!==2))throw new Error('The CFD solid is not watertight. Repair missing faces, or choose the matching open-rim geometry mode.');
  const groups=connected(t,edges),adjacent=t.faces.map(()=>[] as {face:number;same:boolean}[]);
  for(const pair of edges.values()){
    const [a,b]=pair,same=a.from===b.from;
    adjacent[a.face].push({face:b.face,same});adjacent[b.face].push({face:a.face,same});
  }
  const flipped=new Int8Array(t.faces.length).fill(-1),componentBounds:CfdBounds[]=[];
  let volumeM3=0;const firstMoment:CfdPoint=[0,0,0];
  for(const group of groups){
    const queue=[group[0]];flipped[group[0]]=0;
    for(let i=0;i<queue.length;i++)for(const n of adjacent[queue[i]]){
      const next=flipped[queue[i]]^Number(n.same);
      if(flipped[n.face]===-1){flipped[n.face]=next;queue.push(n.face);}
      else if(flipped[n.face]!==next)throw new Error('The hull has a non-orientable surface. Repair the CAD solid before CFD.');
    }
    const componentPoints=group.flatMap(i=>t.faces[i].map(v=>t.points[v]));
    componentBounds.push(boundsOf(componentPoints));
    const origin=t.points[t.faces[group[0]][0]],mom:CfdPoint=[0,0,0];let signedVolume=0;
    for(const i of group){
      const f=t.faces[i],a=t.points[f[0]],b=t.points[f[1]],c=t.points[f[2]];
      const dv=dot(minus(a,origin),cross(minus(b,origin),minus(c,origin)))/6*(flipped[i]?-1:1);
      signedVolume+=dv;
      for(let d=0;d<3;d++)mom[d]+=dv*(origin[d]+a[d]+b[d]+c[d])/4;
    }
    if(Math.abs(signedVolume)<=t.tolerance**3)throw new Error('A closed surface has zero enclosed volume. Check self intersections and duplicate/internal faces.');
    const sign=signedVolume>0?1:-1;
    if(sign<0)for(const i of group)flipped[i]^=1;
    volumeM3+=Math.abs(signedVolume);
    for(let d=0;d<3;d++)firstMoment[d]+=mom[d]*sign;
  }
  // Bodies may touch (multi-body CAD), but must not overlap or nest: that would double-count volume. Where bounding
  // boxes overlap, test whether sample face centroids of one body lie strictly inside the other (ray parity).
  const rayHits=(p:CfdPoint,dir:CfdPoint,faces:number[])=>{
    let hits=0;
    for(const i of faces){
      const f=t.faces[i],a=t.points[f[0]],e1=minus(t.points[f[1]],a),e2=minus(t.points[f[2]],a),q=cross(dir,e2),det=dot(e1,q);
      if(Math.abs(det)<1e-18)continue;
      const inv=1/det,s0=minus(p,a),u=dot(s0,q)*inv;if(u<0||u>1)continue;
      const r=cross(s0,e1),v=dot(dir,r)*inv;if(v<0||u+v>1)continue;
      if(dot(e2,r)*inv>t.tolerance*10)hits++;
    }
    return hits;
  };
  const dirs:CfdPoint[]=[[.5377,.2973,.7889],[-.3121,.8812,.3551],[.7071,-.5,.5]];
  const insideBody=(p:CfdPoint,faces:number[])=>dirs.map(d=>rayHits(p,d,faces)%2).filter(x=>x===1).length>=2;
  for(let i=0;i<componentBounds.length;i++)for(let j=0;j<componentBounds.length;j++){
    if(i===j)continue;
    const a=componentBounds[i],b=componentBounds[j];
    if(![0,1,2].every(d=>Math.min(a.maxM[d],b.maxM[d])-Math.max(a.minM[d],b.minM[d])>t.tolerance))continue;
    const host=groups[i],probe=groups[j],step=Math.max(1,Math.floor(probe.length/32));
    for(let k=0;k<probe.length;k+=step){
      const f=t.faces[probe[k]],c:CfdPoint=[0,1,2].map(d=>(t.points[f[0]][d]+t.points[f[1]][d]+t.points[f[2]][d])/3) as CfdPoint;
      if([0,1,2].some(d=>c[d]<=a.minM[d]||c[d]>=a.maxM[d]))continue;
      if(insideBody(c,host))throw new Error('Separate closed bodies overlap or one is nested inside another. Touching parts are fine, but intersecting or internal bodies would double-count volume: merge them into one solid (boolean union) before exporting.');
    }
  }
  const trianglesM=new Float64Array(t.faces.length*9);
  for(let i=0;i<t.faces.length;i++){
    const f=t.faces[i],order=flipped[i]?[f[0],f[2],f[1]]:f;
    for(let k=0;k<3;k++)trianglesM.set(t.points[order[k]],i*9+k*3);
  }
  return {trianglesM,volumeM3,centroidM:firstMoment.map(v=>v/volumeM3) as CfdPoint};
}

const areaXY=(ids:number[],points:CfdPoint[])=>ids.reduce((sum,a,i)=>{const b=ids[(i+1)%ids.length];return sum+points[a][0]*points[b][1]-points[b][0]*points[a][1];},0)/2;
const side=(a:CfdPoint,b:CfdPoint,c:CfdPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function onSegment(p:CfdPoint,a:CfdPoint,b:CfdPoint,tol:number) {
  return Math.abs(side(a,b,p))<=tol*Math.hypot(b[0]-a[0],b[1]-a[1])&&p[0]>=Math.min(a[0],b[0])-tol&&p[0]<=Math.max(a[0],b[0])+tol&&p[1]>=Math.min(a[1],b[1])-tol&&p[1]<=Math.max(a[1],b[1])+tol;
}
function insideLoop(p:CfdPoint,ids:number[],points:CfdPoint[],tol:number):boolean {
  let inside=false;
  for(let i=0,j=ids.length-1;i<ids.length;j=i++){
    const a=points[ids[i]],b=points[ids[j]];
    if(onSegment(p,a,b,tol))return false;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function boundaryLoops(t:Topology):number[][] {
  const edges=edgesOf(t),neighbors=new Map<number,number[]>();
  for(const uses of edges.values()){
    if(uses.length>2)throw new Error('The open hull has a non-manifold edge. Repair its CAD surface.');
    if(uses.length===1){const {from:a,to:b}=uses[0];neighbors.set(a,[...(neighbors.get(a)||[]),b]);neighbors.set(b,[...(neighbors.get(b)||[]),a]);}
  }
  if([...neighbors.values()].some(n=>n.length!==2))throw new Error('Open boundaries must be simple unbranched rim loops. Repair holes or junctions in CAD.');
  const used=new Set<number>(),loops:number[][]=[];
  for(const [start,adjacent] of neighbors)for(const next of adjacent){
    if(used.has(edgeKey(start,next)))continue;
    const loop=[start];let a=start,b=next;
    while(b!==start){
      if(loop.length>neighbors.size)throw new Error('The rim boundary does not close cleanly.');
      used.add(edgeKey(a,b));loop.push(b);
      const candidates=neighbors.get(b)!;const c=candidates[0]===a?candidates[1]:candidates[0];a=b;b=c;
    }
    used.add(edgeKey(a,b));loops.push(loop);
  }
  return loops;
}
function triangulateRim(ids:number[],t:Topology):Face[] {
  const points=t.points,tol=t.tolerance;
  if(ids.length<3||ids.length>4000)throw new Error('Automatic rim capping supports simple loops with 3–4,000 vertices. Export the capped displacement envelope from CAD.');
  const maxZ=Math.max(...ids.map(i=>points[i][2])),minZ=Math.min(...ids.map(i=>points[i][2]));
  if(maxZ-minZ>tol*10||Math.abs(areaXY(ids,points))<=tol*tol)throw new Error('The rim must be horizontal and enclose a usable area. Export an explicit capped displacement envelope for this hull.');
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    if(j===i+1||(i===0&&j===ids.length-1))continue;
    const a=points[ids[i]],b=points[ids[(i+1)%ids.length]],c=points[ids[j]],d=points[ids[(j+1)%ids.length]];
    if(Math.max(a[0],b[0])+tol<Math.min(c[0],d[0])||Math.max(c[0],d[0])+tol<Math.min(a[0],b[0])||Math.max(a[1],b[1])+tol<Math.min(c[1],d[1])||Math.max(c[1],d[1])+tol<Math.min(a[1],b[1]))continue;
    if(onSegment(a,c,d,tol)||onSegment(b,c,d,tol)||onSegment(c,a,b,tol)||onSegment(d,a,b,tol)||((side(a,b,c)>0)!==(side(a,b,d)>0)&&(side(c,d,a)>0)!==(side(c,d,b)>0)))throw new Error('The rim crosses or touches itself. Repair the boundary in CAD.');
  }
  const polygon=areaXY(ids,points)>0?[...ids]:[...ids].reverse(),faces:Face[]=[];
  while(polygon.length>3){
    let found=false;
    for(let i=0;i<polygon.length;i++){
      const ia=polygon[(i+polygon.length-1)%polygon.length],ib=polygon[i],ic=polygon[(i+1)%polygon.length];
      const a=points[ia],b=points[ib],c=points[ic];
      if(side(a,b,c)<=tol*tol)continue;
      if(polygon.some(id=>id!==ia&&id!==ib&&id!==ic&&side(a,b,points[id])>=-tol*tol&&side(b,c,points[id])>=-tol*tol&&side(c,a,points[id])>=-tol*tol))continue;
      faces.push([ia,ib,ic]);polygon.splice(i,1);found=true;break;
    }
    if(!found)throw new Error('The rim cannot be capped without dropping boundary vertices. Export a triangulated closed exterior from CAD.');
  }
  faces.push([polygon[0],polygon[1],polygon[2]]);return faces;
}

function cappedExterior(original:Topology,mode:'open-surface'|'printed-shell') {
  const originalGroups=connected(original),faceOrigin=new Int32Array(original.faces.length);
  originalGroups.forEach((group,id)=>group.forEach(i=>faceOrigin[i]=id));
  const overall=boundsOf(original.points),planeTol=original.tolerance*10;
  const kept=original.faces.map((_,i)=>i).filter(i=>mode==='open-surface'||!original.faces[i].every(v=>Math.abs(original.points[v][2]-overall.maxM[2])<=planeTol));
  if(mode==='printed-shell'&&kept.length===original.faces.length)throw new Error('No planar top rim was found in the printed wall solid. Export a capped outer displacement envelope from CAD.');
  const working:Topology={...original,faces:kept.map(i=>original.faces[i])},groups=connected(working),loops=boundaryLoops(working);
  const vertexGroup=new Map<number,number>();groups.forEach((group,id)=>group.forEach(f=>working.faces[f].forEach(v=>vertexGroup.set(v,id))));
  const records=loops.map(ids=>{
    const group=vertexGroup.get(ids[0])!,origin=faceOrigin[kept[groups[group][0]]];
    let top=-Infinity;
    for(const f of groups[group])for(const v of working.faces[f])top=Math.max(top,working.points[v][2]);
    if(ids.some(i=>Math.abs(working.points[i][2]-top)>planeTol))throw new Error('Automatic preparation requires a continuous horizontal rim at the top. Export a capped outer displacement envelope for sloping rims or other openings.');
    return {ids,group,origin,area:Math.abs(areaXY(ids,working.points))};
  });
  if(groups.some((_,id)=>records.filter(r=>r.group===id).length!==1))throw new Error('Each hull skin must have exactly one top rim. Separate cargo, closed appendages, other holes or complex skins cannot be silently removed. Export the complete exterior hull envelope.');
  let exterior=records;
  if(mode==='printed-shell'){
    exterior=records.filter(r=>!records.some(other=>other.origin===r.origin&&other.area>r.area&&r.ids.every(v=>insideLoop(working.points[v],other.ids,working.points,original.tolerance))));
    for(let origin=0;origin<originalGroups.length;origin++){
      const outers=exterior.filter(r=>r.origin===origin),inners=records.filter(r=>r.origin===origin&&!exterior.includes(r));
      if(outers.length!==1||inners.length<1||inners.some(r=>!r.ids.every(v=>insideLoop(working.points[v],outers[0].ids,working.points,original.tolerance))))throw new Error('The printed shell does not separate into one outer hull and its nested cavity. Export the outer displacement envelope explicitly; the original printed solid will remain needed for flooding CFD.');
    }
  }else if(records.some(r=>records.some(other=>other!==r&&other.area>r.area&&r.ids.every(v=>insideLoop(working.points[v],other.ids,working.points,original.tolerance)))))throw new Error('Nested open rims indicate printed walls. Select printed-shell mode so the solver retains the cavity correctly.');
  const accepted=new Set(exterior.map(r=>r.group));
  const faces=groups.flatMap((group,id)=>accepted.has(id)?group.map(f=>working.faces[f]):[]);
  for(const rim of exterior)faces.push(...triangulateRim(rim.ids,working));
  return {topology:{...working,faces},rimVerticesM:exterior.flatMap(r=>r.ids.map(v=>working.points[v]))};
}

/** Produce separately validated displacement and solver surfaces from the oriented CAD. */
export function prepareCfdHull(trisMm:Float32Array,mode:CfdEnvelopeMode):CfdHull {
  if(!['closed-envelope','open-surface','printed-shell'].includes(mode))throw new Error('Choose a supported hull geometry mode.');
  const source=makeTopology(trisMm),notes:string[]=[];
  if(source.removedDegenerate)notes.push(`${source.removedDegenerate} zero-area CAD facets were removed before topology validation.`);
  if(source.removedCoincident)notes.push(`${source.removedCoincident} exactly coincident opposite-facing facets were cancelled as zero-volume internal interfaces before topology validation.`);
  let material:ReturnType<typeof closedSolid>|null=null;
  if(mode==='printed-shell')material=closedSolid(source);
  const prepared=mode==='closed-envelope'?{topology:source,rimVerticesM:[] as CfdPoint[]}:cappedExterior(source,mode);
  const hull=closedSolid(prepared.topology);
  const solverTrianglesM=material?.trianglesM??hull.trianglesM;
  if(mode==='closed-envelope')notes.push('The selected STL is assumed to be the complete closed water-excluding exterior, not merely printed wall material.');
  if(mode==='printed-shell')notes.push('Dry initial hydrostatics use the outer skin capped at the real planar rim. The CFD solver receives the original watertight printed material, retaining its walls and open interior so water ingress is possible.');
  if(mode==='open-surface')notes.push('A virtual sealing deck was added to the CFD solid at the actual rim. This is a sealed-envelope test; it cannot reproduce flooding of a zero-thickness open hull. Use a closed printed-material solid to simulate ingress.');
  notes.push('Face closure and orientation were checked. Full CAD self-intersection certification is outside this browser preflight; the exported surface must also pass OpenFOAM surfaceCheck before meshing.');
  return {...hull,solverTrianglesM,solverGeometryKind:mode==='printed-shell'?'printed-material':'sealed-envelope',virtualCap:mode==='open-surface',displacementVirtualCap:mode!=='closed-envelope',bounds:boundsOf(prepared.topology.points),rimVerticesM:prepared.rimVerticesM,notes,triangleCount:hull.trianglesM.length/9,solverTriangleCount:solverTrianglesM.length/9,mode};
}
