/**
 * Automatic STL clean-up before CFD. Teams upload whatever their CAD tool exports, so this step:
 *  - welds coincident vertices, drops degenerate triangles and exact duplicate triangles,
 *  - splits the surface into bodies,
 *  - when several closed bodies are present (multi-part exports: hull + deckhouse + rails ...), merges them into one
 *    solid with an exact boolean union (manifold-3d); sealed internal pockets (inside-out shells inside another
 *    body) are filled, since they cannot take on water.
 * Single clean solids and open hull surfaces are passed through unchanged; their own checks run later.
 * Returns the triangles (mm) to use and human-readable notes of what was changed.
 */
let wasmPromise=null;
async function manifoldModule(){
  if(!wasmPromise)wasmPromise=import('manifold-3d').then(async m=>{const w=await m.default();w.setup();return w;});
  return wasmPromise;
}

function weld(trianglesMm){
  const n=trianglesMm.length/9;
  let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<trianglesMm.length;i+=3)for(let d=0;d<3;d++){lo[d]=Math.min(lo[d],trianglesMm[i+d]);hi[d]=Math.max(hi[d],trianglesMm[i+d]);}
  const span=Math.max(...hi.map((v,d)=>v-lo[d])),tol=Math.max(span*1e-7,1e-6);
  const points=[],index=new Map(),faces=[];
  const key=(x,y,z)=>`${Math.round(x/tol)},${Math.round(y/tol)},${Math.round(z/tol)}`;
  const id=(x,y,z)=>{const k=key(x,y,z);let v=index.get(k);if(v===undefined){v=points.length/3;points.push(x,y,z);index.set(k,v);}return v;};
  let degenerate=0;
  for(let i=0;i<n;i++){
    const o=9*i,f=[id(trianglesMm[o],trianglesMm[o+1],trianglesMm[o+2]),id(trianglesMm[o+3],trianglesMm[o+4],trianglesMm[o+5]),id(trianglesMm[o+6],trianglesMm[o+7],trianglesMm[o+8])];
    if(f[0]===f[1]||f[1]===f[2]||f[0]===f[2]){degenerate++;continue;}
    const [a,b,c]=f.map(v=>[points[3*v],points[3*v+1],points[3*v+2]]);
    const e1=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],e2=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const cr=[e1[1]*e2[2]-e1[2]*e2[1],e1[2]*e2[0]-e1[0]*e2[2],e1[0]*e2[1]-e1[1]*e2[0]];
    if(Math.hypot(...cr)<=tol*tol){degenerate++;continue;}
    faces.push(f);
  }
  // Exact duplicates: same winding -> keep one; opposite winding pairs -> zero-volume sheet, drop both.
  const byKey=new Map();faces.forEach((f,i)=>{const k=[...f].sort((x,y)=>x-y).join(',');const l=byKey.get(k);if(l)l.push(i);else byKey.set(k,[i]);});
  const drop=new Set();let duplicates=0;
  const parity=f=>(Number(f[0]>f[1])+Number(f[0]>f[2])+Number(f[1]>f[2]))%2;
  for(const list of byKey.values()){
    if(list.length<2)continue;
    const even=list.filter(i=>parity(faces[i])===0),odd=list.filter(i=>parity(faces[i])===1);
    const cancel=Math.min(even.length,odd.length);
    for(let k=0;k<cancel;k++){drop.add(even[k]);drop.add(odd[k]);}
    for(const rest of [even.slice(cancel),odd.slice(cancel)])for(const i of rest.slice(1))drop.add(i);
    duplicates+=list.length-(Math.max(even.length,odd.length)-cancel?1:0);
  }
  // For multi-body merging keep coincident opposite faces (the boolean union resolves them exactly; deleting them
  // can open a pinhole between parts); drop only true copies with the same winding.
  const sameCopies=new Set();
  for(const list of byKey.values()){if(list.length<2)continue;const seen=new Map();for(const i of list){const k=parity(faces[i]);if(seen.has(k))sameCopies.add(i);else seen.set(k,i);}}
  return {points,faces:faces.filter((_,i)=>!drop.has(i)),facesForMerge:faces.filter((_,i)=>!sameCopies.has(i)),degenerate,duplicates:drop.size,tol};
}

/**
 * Close small holes (missing triangles): boundary loops whose perimeter is below HOLE_FRACTION of (length+beam+depth)
 * are filled with a fan from the loop centroid, oriented to match the surrounding faces. Large openings (the top of an
 * open hull) are left for the open-hull geometry modes.
 */
export const HOLE_FRACTION=.12;
function fillSmallHoles(points,faces){
  const next=new Map(),count=new Map(),uk=(a,b)=>a<b?`${a},${b}`:`${b},${a}`;
  for(const f of faces)for(let k=0;k<3;k++){const key=uk(f[k],f[(k+1)%3]);count.set(key,(count.get(key)||0)+1);}
  for(const f of faces)for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3];if(count.get(uk(a,b))===1){const l=next.get(a);if(l)l.push(b);else next.set(a,[b]);}}
  if(!next.size)return {faces,filled:0,large:0};
  let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<points.length;i+=3)for(let d=0;d<3;d++){lo[d]=Math.min(lo[d],points[i+d]);hi[d]=Math.max(hi[d],points[i+d]);}
  const limit=HOLE_FRACTION*hi.reduce((t,v,d)=>t+v-lo[d],0);
  const used=new Set(),out=[...faces];let filled=0,large=0;
  const P=v=>[points[3*v],points[3*v+1],points[3*v+2]];
  for(const start of next.keys()){
    for(const first of next.get(start)){
      const k0=`${start},${first}`;if(used.has(k0))continue;
      const loop=[start];let a=start,b=first,ok=true;
      while(true){
        used.add(`${a},${b}`);
        if(b===start)break;
        loop.push(b);
        const cands=(next.get(b)||[]).filter(c=>!used.has(`${b},${c}`));
        if(!cands.length||loop.length>100000){ok=false;break;}
        a=b;b=cands[0];
      }
      if(!ok||loop.length<3)continue;
      let per=0;for(let i=0;i<loop.length;i++){const p=P(loop[i]),q=P(loop[(i+1)%loop.length]);per+=Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2]);}
      if(per>limit){large++;continue;}
      const c=[0,1,2].map(d=>loop.reduce((t,v)=>t+points[3*v+d],0)/loop.length),ci=points.length/3;points.push(...c);
      for(let i=0;i<loop.length;i++){const u=loop[i],w=loop[(i+1)%loop.length];out.push([ci,w,u]);}
      filled++;
    }
  }
  return {faces:out,filled,large};
}

/** Bodies: faces connected through edges, pairing each directed edge with an opposite use (multi-body touching edges). */
function bodies(faces){
  const uses=new Map();
  faces.forEach((f,i)=>{for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;const l=uses.get(key);const u={face:i,fwd:a<b};if(l)l.push(u);else uses.set(key,[u]);}});
  const parent=faces.map((_,i)=>i);
  const find=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
  let open=0,unbalanced=0;
  for(const l of uses.values()){
    const fw=l.filter(u=>u.fwd),rv=l.filter(u=>!u.fwd);
    if(l.length===1)open++;else if(fw.length!==rv.length&&l.length>2)unbalanced++;
    for(let k=0;k<Math.min(fw.length,rv.length);k++)parent[find(fw[k].face)]=find(rv[k].face);
    if(fw.length!==rv.length&&l.length===2)parent[find(l[0].face)]=find(l[1].face);
  }
  const groups=new Map();faces.forEach((_,i)=>{const r=find(i);const g=groups.get(r);if(g)g.push(i);else groups.set(r,[i]);});
  return {groups:[...groups.values()],open,unbalanced};
}

function signedVolume(points,faces,group){
  let v=0;
  for(const i of group){
    const [a,b,c]=faces[i].map(j=>[points[3*j],points[3*j+1],points[3*j+2]]);
    v+=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
  }
  return v;
}

/**
 * Open printed hull with a sloping rim (sheer line): find the lowest rim point as the highest level at which a
 * horizontal slice still shows the cavity fully enclosed by wall (a hole in the cross-section), then trim the model
 * there. Water would come over the rim at that height anyway; the open-hull logic then sees a flat rim.
 */
export const CAVITY_AREA_FRACTION=.3;
function slopedRimLevel(m){
  const bb=m.boundingBox(),z0=bb.min[2],z1=bb.max[2],depth=z1-z0;if(!(depth>0))return null;
  // An open hull's cavity is most of the cross-section; small enclosed recesses (funnels, sockets) do not count.
  const hasHole=z=>{let pos=0,neg=0;for(const poly of m.slice(z).toPolygons()){let a=0;for(let i=0;i<poly.length;i++){const [x1,y1]=poly[i],[x2,y2]=poly[(i+1)%poly.length];a+=x1*y2-x2*y1;}a/=2;if(a>0)pos+=a;else neg-=a;}return pos>0&&neg>=CAVITY_AREA_FRACTION*pos;};
  const step=depth/50;let above=z1-1e-6*depth,below=null;
  for(let z=z1-step*.5;z>z0;z-=step){if(hasHole(z)){below=z;break;}above=z;}
  if(below===null)return null; // no enclosed cavity: a closed solid
  for(let i=0;i<14;i++){const mid=(above+below)/2;if(hasHole(mid))below=mid;else above=mid;}
  // Flat rim (cavity enclosed up to the top): nothing to trim.
  return above>=z1-Math.max(step*.6,1e-3*depth)?null:below;
}
// Boolean results can contain vertices a few nanometres apart; collapsing edges shorter than 1 µm (keeping the solid
// manifold) stops them from becoming sliver triangles or folded edges once the STL is written in single precision.
const SNAP_MM=1e-3;
/**
 * Snap to a 1 µm grid so that distinct vertices are either identical or at least 1 µm apart (the solver's own
 * topology check welds at about 0.02 µm). Collapsed slivers are dropped and coincident opposite faces cancel.
 * The snapped surface is used only if every edge stays closed and consistently oriented.
 */
export function snapTriangles(tris,grid=SNAP_MM){
  const q=v=>Math.round(v/grid),out=[],faces=new Map(),edges=new Map();
  for(let o=0;o<tris.length;o+=9){
    const k=[0,1,2].map(j=>q(tris[o+3*j])+','+q(tris[o+3*j+1])+','+q(tris[o+3*j+2]));
    if(k[0]===k[1]||k[1]===k[2]||k[0]===k[2])continue;
    const p=[0,1,2].map(j=>[0,1,2].map(d=>q(tris[o+3*j+d])*grid));
    const u=p[1].map((v,d)=>v-p[0][d]),w=p[2].map((v,d)=>v-p[0][d]);
    if(Math.hypot(u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0])<=grid*grid*1e-3)continue;
    const sorted=[...k].sort().join('|'),rot=k.indexOf([...k].sort()[0]),even=k[(rot+1)%3]<k[(rot+2)%3];
    const list=faces.get(sorted)??faces.set(sorted,[]).get(sorted),opposite=list.findIndex(f=>f.even!==even);
    if(opposite>=0)list.splice(opposite,1);else list.push({even,k,p});
  }
  for(const list of faces.values())for(const f of list){
    out.push(...f.p.flat());
    for(let j=0;j<3;j++){const a=f.k[j],b=f.k[(j+1)%3],key=a<b?a+'|'+b:b+'|'+a,e=edges.get(key)??edges.set(key,{c:0,o:0}).get(key);e.c++;e.o+=a<b?1:-1;}
  }
  for(const e of edges.values())if(e.c%2||e.o!==0)return null;
  return out;
}
function meshTriangles(m){const raw=rawTriangles(m.simplify(SNAP_MM));return snapTriangles(raw)??raw;}
function rawTriangles(s){const out=s.getMesh(),vp=out.vertProperties,np=out.numProp,tv=out.triVerts,r=new Array(tv.length*3);for(let i=0;i<tv.length;i++)for(let d=0;d<3;d++)r[3*i+d]=vp[np*tv[i]+d];return r;}
/** Clip an open surface to z <= level (single-skin open hull with a sloping rim). */
function clipSurface(points,faces,level){
  const out=[];
  for(const f of faces){
    const poly=f.map(v=>[points[3*v],points[3*v+1],points[3*v+2]]),kept=[];
    for(let i=0;i<3;i++){
      const a=poly[i],b=poly[(i+1)%3],ia=a[2]<=level,ib=b[2]<=level;
      if(ia)kept.push(a);
      if(ia!==ib){const t=(level-a[2])/(b[2]-a[2]);kept.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]),level]);}
    }
    for(let i=1;i+1<kept.length;i++)out.push(...kept[0],...kept[i],...kept[i+1]);
  }
  return out;
}
function rimLoops(faces){
  const count=new Map(),uk=(a,b)=>a<b?`${a},${b}`:`${b},${a}`;
  for(const f of faces)for(let k=0;k<3;k++){const key=uk(f[k],f[(k+1)%3]);count.set(key,(count.get(key)||0)+1);}
  const next=new Map();for(const f of faces)for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3];if(count.get(uk(a,b))===1)next.set(a,b);}
  const seen=new Set(),loops=[];
  for(const s of next.keys()){if(seen.has(s))continue;const loop=[];let v=s;while(v!==undefined&&!seen.has(v)){seen.add(v);loop.push(v);v=next.get(v);}if(loop.length>2)loops.push(loop);}
  return loops;
}

function toManifold(w,points,faces,group,flip){
  const map=new Map(),vert=[],tri=new Uint32Array(group.length*3);
  group.forEach((fi,k)=>{const f=flip?[faces[fi][0],faces[fi][2],faces[fi][1]]:faces[fi];f.forEach((v,j)=>{let m=map.get(v);if(m===undefined){m=vert.length/3;map.set(v,m);vert.push(points[3*v],points[3*v+1],points[3*v+2]);}tri[3*k+j]=m;});});
  const mesh=new w.Mesh({numProp:3,vertProperties:new Float32Array(vert),triVerts:tri});
  mesh.merge();
  return new w.Manifold(mesh);
}

export async function repairHullTriangles(trianglesMm){
  const input=Array.isArray(trianglesMm)?trianglesMm:Array.from(trianglesMm);
  if(!input.length||input.length%9)throw new Error('Provide complete STL triangles.');
  const notes=[];
  const {points,faces,facesForMerge,degenerate,duplicates}=weld(input);
  if(degenerate)notes.push(`Removed ${degenerate.toLocaleString('en-GB')} zero-area triangle${degenerate===1?'':'s'}.`);
  if(duplicates)notes.push(`Removed ${duplicates.toLocaleString('en-GB')} duplicated triangle${duplicates===1?'':'s'}.`);
  const holes=fillSmallHoles(points,faces);
  if(holes.filled){faces.length=0;faces.push(...holes.faces);notes.push(`Closed ${holes.filled} small hole${holes.filled===1?'':'s'} in the surface.`);}
  const {groups,open,unbalanced}=bodies(faces);
  const flat=()=>faces.flatMap(f=>f.flatMap(v=>[points[3*v],points[3*v+1],points[3*v+2]]));
  // Open surfaces (single-skin hulls, open printed hulls) are handled by the CFD geometry modes; nothing to merge.
  const zOf=v=>points[3*v+2];
  if(open>0&&unbalanced===0){
    // Single-skin open hull: trim to the lowest point of its largest opening if that opening is not level.
    const loops=rimLoops(faces).map(l=>({l,len:l.length})).sort((a,b)=>b.len-a.len);
    if(loops.length){
      const rim=loops[0].l,low=Math.min(...rim.map(zOf)),high=Math.max(...rim.map(zOf)),zs=points.filter((_,i)=>i%3===2),depth=Math.max(...zs)-Math.min(...zs);
      if(high-low>1e-3*depth){notes.push(`Open hull with a sloping rim: trimmed at the lowest rim point (${(low-Math.min(...zs)).toFixed(1)} mm above the keel), where water would come over the side.`);return {trianglesMm:clipSurface(points,faces,low),notes,bodies:groups.length,changed:true,openEdges:open};}
    }
  }
  if(open>0||unbalanced>0)return {trianglesMm:degenerate||duplicates||holes.filled?flat():input,notes,bodies:groups.length,changed:!!(degenerate||duplicates||holes.filled),openEdges:open};
  if(groups.length<2){
    // Single closed body: an open printed hull with a sloping rim needs trimming; anything else passes through.
    const w=await manifoldModule();let m;
    try{m=toManifold(w,points,faces,groups[0],signedVolume(points,faces,groups[0])<0);}catch{m=null;}
    const level=m?slopedRimLevel(m):null;
    if(level!==null){notes.push(`Open printed hull with a sloping rim: trimmed at the lowest rim point (${(level-m.boundingBox().min[2]).toFixed(1)} mm above the keel), where water would come over the side.`);return {trianglesMm:meshTriangles(m.trimByPlane([0,0,-1],-level)),notes,bodies:1,changed:true,openEdges:0};}
    return {trianglesMm:degenerate||duplicates||holes.filled?flat():input,notes,bodies:groups.length,changed:!!(degenerate||duplicates||holes.filled),openEdges:open};
  }
  const w=await manifoldModule();
  // Merge path: rebuild bodies from faces that keep coincident opposite pairs.
  const mergeGroups=bodies(facesForMerge).groups,mergeFaces=facesForMerge;
  const parts=mergeGroups.map(g=>({g,vol:signedVolume(points,mergeFaces,g)})).filter(p=>Math.abs(p.vol)>1e-9);
  // Orient every body outward; an inside-out body that sits inside another body is an internal pocket (subtract).
  const solids=[],pockets=[];
  for(const p of parts){
    let m;try{m=toManifold(w,points,mergeFaces,p.g,p.vol<0);}catch(e){throw new Error(`A body in the STL is not a clean closed solid (${e.message??e}). Repair it in your CAD tool and export again.`);}
    if(m.status&&m.status()!=='NoError'&&m.status()!==0)throw new Error(`A body in the STL is not a clean closed solid (${m.status()}). Repair it in your CAD tool and export again.`);
    (p.vol<0?pockets:solids).push({m,vol:Math.abs(p.vol)});
  }
  let union=w.Manifold.union(solids.map(s=>s.m));
  const inside=[];
  for(const p of pockets){
    // Pocket test: if it lies inside the union of the solids, subtract; otherwise it was simply inside-out, add it.
    const overlap=w.Manifold.intersection(union,p.m).volume();
    // A sealed pocket inside the solid cannot take on water: for buoyancy and flow it is solid, so it is filled.
    if(overlap>.5*p.vol)inside.push(p);else union=w.Manifold.union(union,p.m);
  }
  const sumVol=solids.reduce((s,x)=>s+x.vol,0)+pockets.filter(p=>!inside.includes(p)).reduce((s,x)=>s+x.vol,0);
  // Keep only outward shells: enclosed voids (hollow interiors, sealed compartments between parts) are filled, since
  // sealed air is part of the displacement and cannot flood. manifold's decompose() separates shells exactly.
  const pieces=union.decompose(),outer=pieces.filter(p=>p.volume()>0),voidVol=-pieces.filter(p=>p.volume()<0).reduce((t,p)=>t+p.volume(),0);
  const nVoids=pieces.length-outer.length;
  const filled=outer.length===1?outer[0]:w.Manifold.union(outer);
  if(filled.numVert()===0)throw new Error('Merging the STL bodies produced an empty solid. Check the model.');
  const merged=filled.volume()-voidVol;
  notes.push(`Merged ${groups.length} separate bodies into one solid (boolean union)${inside.length?` and filled ${inside.length} sealed internal pocket${inside.length===1?'':'s'}`:''}${nVoids?`; ${nVoids} sealed hollow space${nVoids===1?'':'s'} inside the hull (${(voidVol/1000).toFixed(1)} cm³ of sealed air) count${nVoids===1?'s':''} as displacement`:''}. Double-counted overlap removed: ${(Math.max(0,sumVol-merged)/1000).toFixed(2)} cm³.`);
  const level=slopedRimLevel(filled);
  if(level!==null){notes.push(`Open hull with a sloping rim or top opening: trimmed at the lowest point where the hull opens (${(level-filled.boundingBox().min[2]).toFixed(1)} mm above the keel), where water would come in.`);return {trianglesMm:meshTriangles(filled.trimByPlane([0,0,-1],-level)),notes,bodies:groups.length,changed:true,openEdges:0};}
  const result=meshTriangles(filled);
  return {trianglesMm:result,notes,bodies:groups.length,changed:true,openEdges:0};
}
