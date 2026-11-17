import {mkdir,writeFile,cp} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {generateOpenFoamCase} from '../../src/cfd/case';
import {extendCaseWithWaves} from '../../src/cfd/waves';
import {boxHull} from '../../src/engine/example';
const project=process.cwd();
const out=resolve(project,'cfd-runs/automatic-inertia-native-001');
const axis:[number,number,number]=[Math.cos(.35),0,-Math.sin(.35)];
const tensor:[[number,number,number],[number,number,number],[number,number,number]]=[[.0001,.00003,.00002],[.00003,.0008,.00004],[.00002,.00004,.00085]];
const base=generateOpenFoamCase({caseId:'automatic-inertia-native-001',trianglesMm:boxHull(200,60,40),sourceHash:'c'.repeat(64),protocolKey:'native-constraint-startup-only',load:{massKg:.23952,draftM:.02,cgM:[.1,.005,.015],cgMeasured:true},speedMps:0,mesh:'coarse',durationS:.01,timeStepS:.0002,maxCells:5000000});
const generated=extendCaseWithWaves(base,{kind:'beam-waves',heightM:.01,periodS:1,inertiaSource:'cad-estimate',inertiaMeasured:false,inertiaTensorKgM2:tensor,inertiaAssumptions:['Prescribed synthetic full mass inertia tensor, used solely to test native reduced-DOF constraint/orientation handling.'],rollAxis:axis});
await mkdir(out,{recursive:false});
for(const[name,data] of Object.entries(generated.files)){const dest=resolve(out,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
await cp(resolve(project,'cfd-runs/smoke-calm-001/constant/polyMesh'),resolve(out,'constant/polyMesh'),{recursive:true});
const control=String(generated.files['system/controlDict']).replace(/endTime\s+[^;]+;/,'endTime 0.0004;').replace(/maxDeltaT\s+[^;]+;/,'maxDeltaT 0.0002;').replace(/writeInterval\s+[^;]+;/,'writeInterval 0.0002;');
await writeFile(resolve(out,'system/controlDict'),control);
await writeFile(resolve(out,'SMOKE-ONLY.txt'),'Native OpenCFD v2312 dictionary/orientation/constrained-axis startup check ONLY. Synthetic off-centre CG deliberately creates a known roll torque; supplied mass tensor is synthetic, not measured. Reuses the old 131396-cell calm mesh and runs 0.0004s, before wave travel/startup. The generated production global wave mesh and requested duration are deliberately not run. This does not validate wave response, drag, real inertia, flooding, numerical convergence or ranking accuracy.\n');
console.log(out);
