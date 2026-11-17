import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {prepareCfdJob} from '../server/generated/core.mjs';
const out=resolve(process.argv[2]||'cfd-runs/smoke-calm-001');
const p=[[0,-30,0],[200,-30,0],[200,30,0],[0,30,0],[0,-30,40],[200,-30,40],[200,30,40],[0,30,40]];
const quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
const tris=quads.flatMap(([a,b,c,d])=>[...p[a],...p[b],...p[c],...p[a],...p[c],...p[d]]);
const prepared=await prepareCfdJob({name:'Analytical box — solver smoke only',trianglesMm:tris,geometryMode:'closed-envelope',mode:'calm',massKg:.23952,cgM:[.1,0,.015],measurementsConfirmed:true,speedMps:.3,mesh:'coarse',durationS:.01,timeStepS:.0002,maxCells:750000},'smoke-calm-001');
await mkdir(out,{recursive:false});
for(const [name,data]of Object.entries(prepared.package.files)){const dest=resolve(out,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
await writeFile(resolve(out,'prepared-summary.json'),JSON.stringify({hydro:prepared.hydro,geometryHash:prepared.geometryHash,protocolHash:prepared.protocolHash},null,2));
console.log(out);
