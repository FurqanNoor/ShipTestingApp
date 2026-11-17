/** Native syntax/coupling smoke only: inherits a small checked mesh, not a resolved wave tank. */
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {prepareCfdJob} from '../server/generated/core.mjs';
const out=resolve('cfd-runs/smoke-beam-001'),from=resolve('cfd-runs/smoke-calm-001');
const p=[[0,-30,0],[200,-30,0],[200,30,0],[0,30,0],[0,-30,40],[200,-30,40],[200,30,40],[0,30,40]],quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
const trianglesMm=quads.flatMap(([a,b,c,d])=>[...p[a],...p[b],...p[c],...p[a],...p[c],...p[d]]);
const prepared=await prepareCfdJob({name:'Beam setup — native coupling smoke only',trianglesMm,geometryMode:'closed-envelope',mode:'beam-waves',massKg:.23952,cgM:[.1,0,.015],measurementsConfirmed:true,speedMps:0,inertiaMeasured:true,inertiaKgM2:[.0001,.0008,.00085],waveHeightM:.01,wavePeriodS:1,mesh:'coarse',maxCells:5000000,timeStepS:.0002},'smoke-beam-001');
await mkdir(out,{recursive:false});
for(const [name,data]of Object.entries(prepared.package.files)){const dest=resolve(out,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
await cp(resolve(from,'constant/polyMesh'),resolve(out,'constant/polyMesh'),{recursive:true});
await cp(resolve(from,'log.checkMesh'),resolve(out,'log.checkMesh'));await cp(resolve(from,'log.checkMeshDetailed'),resolve(out,'log.checkMeshDetailed'));
const control=String(prepared.package.files['system/controlDict']).replace(/endTime\s+[^;]+;/,'endTime 0.0004;').replace(/maxDeltaT\s+[^;]+;/,'maxDeltaT 0.0002;').replace(/writeInterval\s+[^;]+;/,'writeInterval 0.0002;');
await writeFile(resolve(out,'system/controlDict'),control);
await writeFile(resolve(out,'SMOKE-ONLY.txt'),'Native wave boundary and six-DoF initialization/coupling check only. Reuses 131396-cell calm mesh and runs 0.0004s, before wave travel/startup. This cannot provide physical wave response, convergence evidence, or ranking data. The generated production wave mesh and requested duration are deliberately not run in this smoke.\n');
console.log(out);
