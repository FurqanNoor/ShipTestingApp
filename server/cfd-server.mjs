/** Local-only OpenFOAM service. User data never enters a hosted solver or empirical fallback. */
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,stat,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {zipSync,unzipSync,strToU8} from 'fflate';
import * as core from './generated/core.mjs';
import {readCfdRunResult} from './result-reader.mjs';
import {StudyRunner,numericalRequest,phasesFor} from './study-runner.mjs';
import {predictRun,learn,remainingStudySeconds} from './estimator.mjs';
import {explainFailure} from './failure-hints.mjs';
import {repairHullTriangles} from './geometry-repair.mjs';

const execute=promisify(execFile);
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const RUNS=resolve(ROOT,'cfd-runs');
const STUDIES=resolve(RUNS,'studies');
const IMAGE='opencfd/openfoam-run@sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76';
const PORT=Number(process.env.PORT||5173),HOST='127.0.0.1';
const jobs=new Map(),queue=[];
const jobWaiters=new Map(),studyWrites=new Map();
let active=null,availability=null;
const dockerPrefix=existsSync('/var/run/docker.sock')?['--host=unix:///var/run/docker.sock']:[];
const dockerEnv={...process.env};
if(dockerPrefix.length)for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete dockerEnv[k];
const totalMemoryGb=Math.floor(os.totalmem()/2**30);
const memory=/^\d+[mg]$/i.test(process.env.CFD_MEMORY||'')?process.env.CFD_MEMORY:`${Math.max(3,Math.floor(totalMemoryGb*.7))}g`;
const maxCores=Math.max(1,(os.availableParallelism?.()??os.cpus().length)||1);
// Default: leave one core free for the desktop/browser on machines with more than two cores.
const defaultCores=/^\d+$/.test(process.env.CFD_CPUS||'')?Math.min(maxCores,Math.max(1,Number(process.env.CFD_CPUS))):maxCores>2?maxCores-1:maxCores;
const STAGE_TEXT={surfaceCheck:'Checking hull surface',blockMesh:'Building background mesh',surfaceFeatureExtract:'Extracting hull edges',snappyHexMesh:'Meshing actual hull',checkMesh:'Checking mesh quality',meshDetailedDiagnostics:'Detailed mesh diagnostics',setFields:'Setting initial water level',decomposePar:'Splitting mesh across CPU cores',interFoam:'Solving free-surface flow'};
const clampCores=v=>Number.isInteger(v)&&v>=1?Math.min(v,maxCores):defaultCores;
const maxMs=Math.max(60_000,Math.min(Number(process.env.CFD_TIMEOUT_MS)||7_200_000,86_400_000));
const CALIBRATION=resolve(RUNS,'calibration.json');
let calibration={};
const TERMINAL_STUDY=new Set(['completed','failed','cancelled','interrupted']);
const DONE_CONDITION=new Set(['completed','failed','blocked','cancelled','interrupted','skipped']);

function publicJob(j){return {id:j.id,name:j.name,status:j.status,stage:j.stage,cores:j.cores??null,progress:j.progress?{...j.progress,samples:undefined}:null,logLines:j.lineCount??0,createdAt:j.createdAt,updatedAt:j.updatedAt,logTail:j.log.slice(-100),error:j.error||null,hint:j.hint??null,timing:j.timing??null,result:j.result||null,manifest:j.manifest,request:j.request,studyId:j.studyId??null,conditionId:j.conditionId??null,studyPhase:j.studyPhase??null};}
function settleJob(j){const resolveJob=jobWaiters.get(j.id);if(resolveJob){jobWaiters.delete(j.id);resolveJob(publicJob(j));}}
async function persistStudy(record){
  const previous=studyWrites.get(record.id)??Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const path=resolve(STUDIES,record.id+'.json'),temp=path+'.tmp';await writeFile(temp,JSON.stringify(record,null,2));await rename(temp,path);});
  studyWrites.set(record.id,next);
  try{await next;}finally{if(studyWrites.get(record.id)===next)studyWrites.delete(record.id);}
}
const studyRunner=new StudyRunner({runCase:runStudyCase,cancelCase:async id=>{const j=jobs.get(id);if(j?.studyId)await cancel(j);},persist:persistStudy});
function publicStudy(record){
  if(!record)return null;
  const j=jobs.get(record.activeJobId);
  const eta=queueTimes().get(record.id);if(eta)record.eta=eta;else if(TERMINAL_STUDY.has(record.status))record.eta={remainingS:0,finishAt:null};
  const queuePosition=studyRunner.queuedIds.indexOf(record.id);record.queuePosition=queuePosition>=0?queuePosition+1:null;
  if(j){record.activeJob={id:j.id,status:j.status,stage:j.stage,cores:j.cores??null,progress:j.progress?{...j.progress,samples:undefined}:null,logTail:j.log.slice(-15)};const condition=record.conditions.find(c=>c.id===j.conditionId);if(condition&&condition.status==='running')condition.stage=`${j.studyPhase}: ${j.stage}`;record.stage=`${condition?.label??'Automatic test'} · ${j.studyPhase}: ${j.stage}`;}
  return record;
}

/* ---------- Time estimates ---------- */
const estimateCache=new Map(),studyPredictions=new Map(),repairCache=new Map();
/** Clean up uploaded CAD once per geometry (weld, drop duplicates, merge multi-body exports); cached by content. */
async function repaired(trianglesMm){
  if(!Array.isArray(trianglesMm)||!trianglesMm.length||trianglesMm.length%9)throw new Error('Provide complete STL triangles.');
  const key=geometryKey(trianglesMm);
  if(!repairCache.has(key)){repairCache.set(key,repairHullTriangles(trianglesMm).then(fix=>({...fix,key})).catch(e=>{repairCache.delete(key);throw e;}));if(repairCache.size>50)repairCache.delete(repairCache.keys().next().value);}
  return repairCache.get(key);
}
// Plans are deterministic for the same name and repaired triangles; the estimate and submit calls reuse them.
const planCache=new Map();
const planFor=async(name,trianglesMm)=>{
  const fix=await repaired(trianglesMm),key=`${name}\u0000${fix.key??''}`;
  if(fix.key&&planCache.has(key))return {plan:structuredClone(planCache.get(key)),fix};
  const plan=core.createAutomaticPlan({name,trianglesMm:fix.trianglesMm});
  if(fix.notes.length)plan.geometryNotes=[...fix.notes.map(n=>'Automatic CAD clean-up: '+n),...plan.geometryNotes];
  if(fix.key){planCache.set(key,plan);if(planCache.size>20)planCache.delete(planCache.keys().next().value);}
  return {plan:structuredClone(plan),fix};
};
const geometryKey=tris=>createHash('sha256').update(Buffer.from(new Float64Array(tris).buffer)).digest('hex').slice(0,32);
const slimManifest=m=>({condition:{kind:m.condition?.kind},mesh:{fidelity:m.mesh?.fidelity,estimatedBaseCells:m.mesh?.estimatedBaseCells,finestCellM:m.mesh?.finestCellM},numerics:{durationS:m.numerics?.durationS,maxDeltaTS:m.numerics?.maxDeltaTS}});
/** Prepare (but never run) every solve a condition would make, to preflight it and size its mesh. */
async function prepareEstimates(geomKey,condition,speed){
  const key=`${geomKey}|${condition.id}|${speed}`;
  if(estimateCache.has(key))return estimateCache.get(key);
  const pending=(async()=>{
    const runs=[];let fine=null;
    for(const phase of phasesFor(speed)){
      if(['time-step','domain'].includes(phase)&&!fine)break;
      await new Promise(r=>setImmediate(r)); // keep the service responsive between ~0.3 s preparations
      try{const p=await core.prepareCfdJob(numericalRequest(condition.request,phase,fine?{manifest:fine}:null,speed),'estimate');runs.push({phase,manifest:slimManifest(p.package.manifest)});if(phase==='fine')fine=p.package.manifest;}
      catch(e){const error=String(e?.message??e);runs.push({phase,error,hint:explainFailure(error)});break;}
    }
    return {runs};
  })();
  estimateCache.set(key,pending);if(estimateCache.size>3000)estimateCache.delete(estimateCache.keys().next().value);
  return pending;
}
const predictS=(manifest,cores)=>predictRun(manifest,{cores,calibration});
function summariseCondition(condition,entry,cores){
  const first=entry.runs[0],blocked=!!first?.error;
  const runs=entry.runs.map(r=>r.error?{phase:r.phase,error:r.error,hint:r.hint}:{phase:r.phase,cells:predictS(r.manifest,cores).cells,predictedS:predictS(r.manifest,cores).totalS,simulatedS:r.manifest.numerics.durationS});
  return {id:condition.id,label:condition.label,mode:condition.mode,blocked,error:blocked?first.error:null,hint:blocked?first.hint:null,
    laterPhaseError:!blocked&&entry.runs.find(r=>r.error)?.error||null,predictedS:runs.reduce((t,r)=>t+(r.predictedS??0),0),runs};
}
/** Remaining time for one study, from calibrated predictions plus the live solver rate of the active run. */
function studyRemaining(record){
  if(TERMINAL_STUDY.has(record.status))return {remainingS:0};
  const pred=studyPredictions.get(record.id);if(!pred)return null;
  const cores=record.options?.cores??defaultCores,pending=[],finished=[];let activeRun=null;
  for(const c of record.conditions){
    const entry=pred.get(c.id);if(!entry)return null;
    for(const r of entry.runs){
      if(r.error)break;
      const predicted=predictS(r.manifest,cores).totalS,run=c.runs.find(x=>x.phase===r.phase),j=run?.jobId?jobs.get(run.jobId):null;
      if(j&&run.jobId===record.activeJobId){
        const solving=j.progress?.step==='interFoam'&&Number.isFinite(j.progress?.etaS);
        activeRun={predictedS:predicted,liveEtaS:solving?j.progress.etaS:null,elapsedS:j.timing?.startedAt?(Date.now()-j.timing.startedAt)/1000:0};
      }else if(j?.status==='completed'&&j.timing?.finishedAt)finished.push({predictedS:predicted,actualS:(j.timing.finishedAt-j.timing.startedAt)/1000});
      else if(!run&&!DONE_CONDITION.has(c.status))pending.push({predictedS:predicted});
    }
  }
  const r=remainingStudySeconds({pending,active:activeRun,finished});
  return {remainingS:r.totalS,activeRunS:r.activeS,basedOnFinishedRuns:r.basedOnFinishedRuns};
}
/** Remaining and finish times for the running study and every queued study, in queue order. */
function queueTimes(){
  const out=new Map(),now=Date.now();let offset=0,known=true;
  for(const id of [studyRunner.activeId,...studyRunner.queuedIds].filter(Boolean)){
    const record=studyRunner.records.get(id);if(!record)continue;
    const r=studyRemaining(record);
    if(!r||!known){known=false;out.set(id,{remainingS:r?.remainingS??null,startsInS:id===studyRunner.activeId?0:null,finishAt:null,estimating:!r});continue;}
    out.set(id,{remainingS:r.remainingS,startsInS:offset,finishAt:new Date(now+(offset+r.remainingS)*1000).toISOString(),basedOnFinishedRuns:r.basedOnFinishedRuns});
    offset+=r.remainingS;
  }
  return out;
}
function queueSummary(){
  const times=queueTimes(),ids=[studyRunner.activeId,...studyRunner.queuedIds].filter(Boolean);
  const all=ids.map(id=>times.get(id)),known=all.length&&all.every(t=>t&&Number.isFinite(t.remainingS));
  const totalS=known?all.reduce((s,t)=>s+t.remainingS,0):null;
  return {studies:ids.length,activeId:studyRunner.activeId,queuedIds:studyRunner.queuedIds,remainingS:totalS,finishAt:totalS!==null?new Date(Date.now()+totalS*1000).toISOString():null,calibratedRunTypes:Object.keys(calibration.entries??{})};
}
async function saveCalibration(){try{await writeFile(CALIBRATION+'.tmp',JSON.stringify(calibration,null,2));await rename(CALIBRATION+'.tmp',CALIBRATION);}catch{/* estimates are optional */}}
const geometryPath=id=>resolve(STUDIES,id+'.geometry.bin');
async function saveGeometry(id,tris){await writeFile(geometryPath(id),Buffer.from(new Float32Array(tris).buffer));}
async function loadGeometry(id){const b=await readFile(geometryPath(id));return Array.from(new Float32Array(b.buffer,b.byteOffset,b.byteLength/4));}
function selectConditions(plan,ids){
  if(ids===undefined)return null;
  if(!Array.isArray(ids)||!ids.length)return 'Select at least one test condition.';
  const wanted=new Set(ids.map(String)),unknown=[...wanted].filter(id=>!plan.conditions.some(c=>c.id===id));
  if(unknown.length)return `Unknown test condition: ${unknown.join(', ')}`;
  plan.conditions=plan.conditions.filter(c=>wanted.has(c.id));return null;
}
async function createStudy(plan,trianglesMm,{speed,cores}){
  const study=await studyRunner.create(plan,{id:randomUUID(),name:plan.name,speed,cores});
  await saveGeometry(study.id,trianglesMm).catch(()=>{});
  const gk=geometryKey(trianglesMm);
  void (async()=>{const map=new Map();for(const c of plan.conditions)map.set(c.id,await prepareEstimates(gk,c,speed));studyPredictions.set(study.id,map);})().catch(()=>{});
  return study;
}
async function save(j){j.updatedAt=new Date().toISOString();await writeFile(resolve(j.dir,'job.json'),JSON.stringify(publicJob(j),null,2));}
async function setState(j,status,stage){if(j.cancelRequested&&status!=='cancelled')return;j.status=status;j.stage=stage;await save(j);}
/** Live solver progress parsed from the streamed log: simulated time, step size, Courant number and ETA. */
function track(j,line){
  const p=j.progress??(j.progress={step:null,simTimeS:null,endTimeS:Number(j.manifest?.numerics?.durationS)||null,deltaTS:null,courantMax:null,cells:null,percent:0,etaS:null,elapsedS:0,solveStartedAt:null,samples:[]});
  p.samples??=[];let m;
  if((m=/^HULL_CFD_STAGE:(\w+)/.exec(line))){p.step=m[1];j.stage=STAGE_TEXT[m[1]]??m[1];if(m[1]==='interFoam'){j.status='solving';p.solveStartedAt=Date.now();}return;}
  if((m=/^Time = ([-+\d.eE]+)\s*$/.exec(line))){
    const t=Number(m[1]);if(!Number.isFinite(t))return;
    if(j.status!=='solving'){j.status='solving';j.stage=STAGE_TEXT.interFoam;}
    p.solveStartedAt??=Date.now();p.simTimeS=t;p.stepCount=(p.stepCount??0)+1;const now=Date.now();p.elapsedS=(now-p.solveStartedAt)/1000;
    p.samples.push([now,t]);while(p.samples.length>2&&now-p.samples[0][0]>120_000)p.samples.shift();
    if(p.endTimeS>0){
      p.percent=Math.max(0,Math.min(100,100*t/p.endTimeS));
      const [w0,t0]=p.samples[0],rate=(t-t0)/((now-w0)/1000);
      p.etaS=rate>0&&now-w0>3000?Math.max(0,(p.endTimeS-t)/rate):null;
    }
    return;
  }
  if((m=/^deltaT = ([-+\d.eE]+)/.exec(line)))p.deltaTS=Number(m[1]);
  else if((m=/^Courant Number mean: \S+ max: ([-+\d.eE]+)/.exec(line)))p.courantMax=Number(m[1]);
  else if((m=/^\s*cells:\s+(\d+)/.exec(line)))p.cells=Number(m[1]);
}
function append(j,text){
  j.partial=(j.partial||'')+text;const lines=j.partial.split(/\r?\n/);j.partial=lines.pop();
  const fresh=[];
  for(const raw of lines){const line=raw.slice(0,1200);j.log.push(line);fresh.push(line);j.lineCount=(j.lineCount??0)+1;try{track(j,line);}catch{}}
  if(j.log.length>600)j.log=j.log.slice(-400);
  if(fresh.length&&j.listeners?.size)for(const send of j.listeners)send(fresh);
}
async function solverStatus(){
  if(availability&&Date.now()-availability.at<10_000)return availability.value;
  let value;
  try{await execute('docker',[...dockerPrefix,'image','inspect',IMAGE],{env:dockerEnv,timeout:15_000,maxBuffer:256_000});value={available:true,image:IMAGE,version:'2312',maxCores,defaultCores,message:'Pinned OpenCFD v2312 Docker image is installed. Numerical and physical validation remain required.'};}
  catch{value={available:false,image:IMAGE,version:'2312',maxCores,defaultCores,message:'Start Docker, then run npm run cfd:pull to install the pinned solver image. No estimated readings will replace missing CFD output.'};}
  availability={at:Date.now(),value};return value;
}
async function writePackage(dir,files){
  await mkdir(dir,{recursive:false});
  for(const [name,data]of Object.entries(files)){
    if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..'))throw new Error('Unsafe generated case path.');
    const path=resolve(dir,name);if(!path.startsWith(dir+sep))throw new Error('Unsafe generated case path.');
    await mkdir(dirname(path),{recursive:true});await writeFile(path,data);
  }
  // setFields can replace 0/alpha.water with a mesh-sized field. Preserve fresh inputs for export.
  await writeFile(resolve(dir,'case-input.zip'),zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,typeof v==='string'?strToU8(v):v])),{level:4}));
}
async function enqueueCase(body,context={}){
  const id=randomUUID();let prepared;
  try{prepared=await core.prepareCfdJob(body,id);}catch(error){error.preflight=true;throw error;}
  if(context.isCancelled?.())return {id:null,status:'cancelled',result:null,error:null};
  const dir=resolve(RUNS,id);await writePackage(dir,prepared.package.files);
  const {trianglesMm,...summary}=prepared.request;void trianglesMm;
  const j={id,dir,name:summary.name,container:`hull-cfd-${id}`,status:'queued',stage:'Queued',createdAt:new Date().toISOString(),log:[],request:summary,manifest:prepared.package.manifest,hydro:prepared.hydro,geometryHash:prepared.geometryHash,protocolHash:prepared.protocolHash,
    studyId:context.studyId??null,conditionId:context.conditionId??null,studyPhase:context.phase??null,cores:clampCores(context.cores??body?.cores),lineCount:0,listeners:new Set()};
  jobs.set(id,j);await save(j);
  let done;
  if(context.studyId)done=new Promise(resolveJob=>jobWaiters.set(id,resolveJob));
  await context.onQueued?.(id);
  if(context.isCancelled?.()||j.status==='cancelled'){j.status='cancelled';j.stage='Cancelled before execution';await save(j);settleJob(j);}
  else{queue.push(j);void startNext();}
  return context.studyId?done:publicJob(j);
}
async function runStudyCase(body,context){return enqueueCase(body,context);}
async function startNext(){
  if(active||!queue.length)return;
  const j=queue.shift();if(j.status==='cancelled'){void startNext();return;}active=j;
  try{
    if(j.cancelRequested||j.status==='cancelled')return;
    if(!(await solverStatus()).available)throw new Error('The pinned OpenFOAM image or Docker daemon is unavailable. Run npm run cfd:pull.');
    if(j.cancelRequested||j.status==='cancelled')return;
    await setState(j,'meshing','Checking surfaces and building finite-volume mesh');
    j.timing={startedAt:Date.now()};
    append(j,`Starting OpenFOAM in Docker on ${j.cores} CPU core${j.cores===1?'':'s'} (${memory} RAM limit)\n`);
    if(j.cancelRequested||j.status==='cancelled')return;
    const args=[...dockerPrefix,'run','--rm','--name',j.container,'--network','none','--cpus',String(j.cores),'--memory',memory,'-e',`HULL_NPROCS=${j.cores}`,'--shm-size','1g','--entrypoint','/bin/bash','--mount',`type=bind,src=${j.dir},dst=/case`,'--workdir','/case',IMAGE,'Allrun'];
    const child=spawn('docker',args,{env:dockerEnv,stdio:['ignore','pipe','pipe']});j.child=child;
    const timer=setTimeout(()=>{j.error='The configured wall-clock solver time limit was reached.';void cancel(j);},maxMs);
    const stream=async chunk=>{const text=chunk.toString();append(j,text);await writeFile(resolve(j.dir,'service-runner.log'),text,{flag:'a'}).catch(()=>{});};
    child.stdout.on('data',stream);child.stderr.on('data',stream);
    const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);}).finally(()=>clearTimeout(timer));j.child=null;
    if(j.cancelRequested||j.status==='cancelled')return;
    if(code!==0)throw new Error(`OpenFOAM stopped with exit ${code}. Inspect the stage logs; no CFD value was fabricated.`);
    await setState(j,'solving','Reading actual force and motion histories');
    j.result=await readCfdRunResult(j.dir,{manifest:j.manifest,hydro:j.hydro,geometryHash:j.geometryHash,protocolHash:j.protocolHash,...core});
    // The reader exposes actual mesh counts under solverRun; keep the UI contract explicit.
    j.result.mesh={cells:j.result.solverRun?.actualMeshCells??null,quality:j.result.quality?.meshOkay??null};
    if(j.result.motion)j.result.motion.maxRollDeg=j.result.motion.maxAbsRollDeg;
    await writeFile(resolve(j.dir,'results.json'),JSON.stringify(j.result,null,2));
    j.timing.finishedAt=Date.now();
    // Calibrate time estimates from runs that reached their full simulated time on this machine.
    if(j.result.quality?.completedTime===true&&j.progress?.solveStartedAt&&j.progress?.stepCount>10){
      calibration=learn(calibration,{manifest:j.manifest,actualCells:j.result.solverRun?.actualMeshCells,steps:j.progress.stepCount,solveWallS:(j.timing.finishedAt-j.progress.solveStartedAt)/1000,meshWallS:(j.progress.solveStartedAt-j.timing.startedAt)/1000,cores:j.cores});
      void saveCalibration();
    }
    await setState(j,'completed','Completed — convergence and physical validation pending');
  }catch(error){if(j.status!=='cancelled'){j.error=error.message;append(j,error.message+'\n');j.hint=explainFailure(j.error,j.log.slice(-300));if(j.timing)j.timing.finishedAt=Date.now();await setState(j,'failed',j.hint?.title??'Solver or preflight failed');}}
  finally{settleJob(j);active=null;j.child=null;void startNext();}
}
async function cancel(j){
  j.cancelRequested=true;
  j.status='cancelled';j.stage=j.error?'Stopped at time limit':'Cancelled by user';
  if(j.child){await execute('docker',[...dockerPrefix,'rm','-f',j.container],{env:dockerEnv,timeout:15_000}).catch(()=>{});j.child.kill('SIGTERM');}
  await save(j);settleJob(j);void startNext();
}
async function requestBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new Error('Use application/json for CFD requests.');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>160*1024*1024)throw new Error('CFD request exceeds 160 MB. Export the STL at a coarser resolution.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function caseArchive(j){
  const files={};let bytes=0;
  let initial=null;
  try{initial=unzipSync(new Uint8Array(await readFile(resolve(j.dir,'case-input.zip'))));}catch{}
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
    const p=resolve(dir,e.name),r=relative(j.dir,p).split(sep).join('/');
    if(e.isSymbolicLink())continue;
    if(e.isDirectory()){if(r==='constant/polyMesh'||(/^\d/.test(r)&&(r!=='0'||initial)))continue;await walk(p);}
    else if(r.startsWith('system/')||r.startsWith('0/')||r.startsWith('constant/')||r.startsWith('postProcessing/')||/^(Allrun|case\.foam|README\.txt|manifest\.json|hydrostatics\.json|request\.json|results\.json|job\.json|log\.)/.test(r)){
      const info=await stat(p);if(info.size>64*1024*1024)continue;bytes+=info.size;if(bytes>150*1024*1024)throw new Error('Result archive exceeds 150 MB. Read raw files in cfd-runs instead.');files[r]=new Uint8Array(await readFile(p));
    }
  }}await walk(j.dir);
  if(initial)for(const[name,data]of Object.entries(initial)){if(name.startsWith('/')||name.split('/').includes('..')||name.includes('\\'))throw new Error('Unsafe stored input archive.');files[name]=data;}
  files['ARCHIVE-NOTE.txt']=strToU8('Generated configuration and result histories. Original initial fields are retained when the input snapshot is available. Large computed field time directories and polyMesh are omitted; rerun Allrun in a fresh directory to regenerate the mesh. No convergence or experimental validation is implied.\n');return zipSync(files,{level:4});
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.zip':'application/zip','.md':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host||'';
    if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return json(res,403,{error:'The CFD service accepts local loopback hosts only.'});
    const origin=req.headers.origin;if(origin&&origin!==`http://${host}`)return json(res,403,{error:'Cross-origin solver requests are not allowed. Open the local app URL.'});
    const url=new URL(req.url,`http://${host}`),path=url.pathname;
    if(path==='/api/cfd/status'&&req.method==='GET')return json(res,200,await solverStatus());
    if(path==='/api/cfd/studies'&&req.method==='GET')return json(res,200,{studies:studyRunner.list().sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).slice(-200).map(publicStudy),queue:queueSummary()});
    if(path==='/api/cfd/queue'&&req.method==='GET')return json(res,200,queueSummary());
    if(path==='/api/cfd/queue/cancel'&&req.method==='POST'){
      for(const id of [...studyRunner.queuedIds].reverse())await studyRunner.cancel(id);
      if(studyRunner.activeId)await studyRunner.cancel(studyRunner.activeId);
      return json(res,200,queueSummary());
    }
    if(path==='/api/cfd/estimate'&&req.method==='POST'){
      const body=await requestBody(req),{plan,fix}=await planFor(body.name,body.trianglesMm);
      const speed=body.speed==='quick'?'quick':'full',cores=clampCores(Number(body.cores)),gk=geometryKey(fix.trianglesMm);
      const conditions=[];for(const c of plan.conditions)conditions.push(summariseCondition(c,await prepareEstimates(gk,c,speed),cores));
      return json(res,200,{repairNotes:fix.notes,geometryMode:plan.geometryMode,speed,cores,calibrated:Object.keys(calibration.entries??{}).length>0,machineSpeedFactor:calibration.machineSpeedFactor??1,conditions,queue:queueSummary()});
    }
    if(path==='/api/cfd/studies'&&req.method==='POST'){
      if(!(await solverStatus()).available)return json(res,409,{error:'Start Docker and run npm run cfd:pull before starting automatic tests.'});
      const body=await requestBody(req),{plan,fix}=await planFor(body.name,body.trianglesMm);
      const problem=selectConditions(plan,body.conditionIds);if(problem)return json(res,400,{error:problem});
      const speed=body.speed==='quick'?'quick':'full',cores=clampCores(Number(body.cores));
      const study=await createStudy(plan,fix.trianglesMm,{speed,cores});return json(res,202,publicStudy(studyRunner.get(study.id)));
    }
    const studyMatch=/^\/api\/cfd\/studies\/([a-f0-9-]{36})(?:\/(cancel|download|rerun))?$/.exec(path);
    if(studyMatch){
      const record=studyRunner.get(studyMatch[1]);if(!record)return json(res,404,{error:'Unknown local automatic study.'});
      if(!studyMatch[2]&&req.method==='GET')return json(res,200,publicStudy(record));
      if(studyMatch[2]==='cancel'&&req.method==='POST')return json(res,200,publicStudy(await studyRunner.cancel(record.id)));
      if(studyMatch[2]==='rerun'&&req.method==='POST'){
        if(!TERMINAL_STUDY.has(record.status))return json(res,409,{error:'This study is still running or queued.'});
        if(!(await solverStatus()).available)return json(res,409,{error:'Start Docker and run npm run cfd:pull first.'});
        let trianglesMm;try{trianglesMm=await loadGeometry(record.id);}catch{return json(res,409,{error:'The hull geometry for this study was not stored (it predates re-run support). Load the STL and run it again.'});}
        const body=await requestBody(req).catch(()=>({}));
        const unfinished=record.conditions.filter(c=>['failed','interrupted','cancelled'].includes(c.status)||(c.status==='completed'&&!c.runs.some(r=>r.status==='completed'))).map(c=>c.id);
        const ids=Array.isArray(body.conditionIds)&&body.conditionIds.length?body.conditionIds:unfinished;
        if(!ids.length)return json(res,400,{error:'Nothing to re-run: every test finished (blocked tests need a changed hull or load).'});
        const plan=core.createAutomaticPlan({name:record.name,trianglesMm});const problem=selectConditions(plan,ids);if(problem)return json(res,400,{error:problem});
        const study=await createStudy(plan,trianglesMm,{speed:record.options?.speed??'full',cores:clampCores(Number(record.options?.cores))});
        return json(res,202,publicStudy(studyRunner.get(study.id)));
      }
      if(studyMatch[2]==='download'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':`attachment; filename="openfoam-study-${record.id}.json"`});return res.end(JSON.stringify(publicStudy(record),null,2));
      }
      return json(res,405,{error:'Unsupported automatic study operation.'});
    }
    if(path==='/api/cfd/jobs'&&req.method==='GET')return json(res,200,{jobs:[...jobs.values()].map(publicJob)});
    if(path==='/api/cfd/jobs'&&req.method==='POST'){
      if([...jobs.values()].filter(j=>['queued','preparing','meshing','solving'].includes(j.status)).length>=8)return json(res,429,{error:'The local queue is full. Finish or cancel a job before adding more.'});
      const body=await requestBody(req);if(Array.isArray(body.trianglesMm))body.trianglesMm=(await repaired(body.trianglesMm)).trianglesMm;const j=await enqueueCase(body);json(res,202,{id:j.id});return;
    }
    const live=/^\/api\/cfd\/jobs\/([a-f0-9-]{36})\/stream$/.exec(path);
    if(live&&req.method==='GET'){
      const j=jobs.get(live[1]);if(!j)return json(res,404,{error:'Unknown local job.'});
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
      const event=(name,data)=>res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      const state=()=>({status:j.status,stage:j.stage,cores:j.cores??null,progress:j.progress?{...j.progress,samples:undefined}:null,error:j.error??null,lineCount:j.lineCount??0});
      event('init',{...state(),lines:j.log.slice(-400)});
      const done=()=>['completed','failed','cancelled'].includes(j.status);
      if(done()){event('end',state());return res.end();}
      let pending=[];
      const send=lines=>{pending.push(...lines);};
      j.listeners??=new Set();j.listeners.add(send);
      // Batch lines (solver output can be thousands of lines per second) and push state 4x per second.
      const flush=setInterval(()=>{
        if(pending.length){const skipped=Math.max(0,pending.length-500),lines=skipped?pending.slice(-500):pending;pending=[];event('lines',{lines,skipped});}
        event('state',state());
        if(done()){event('end',state());cleanup();res.end();}
      },250);
      const cleanup=()=>{clearInterval(flush);j.listeners?.delete(send);};
      req.on('close',cleanup);
      return;
    }
    const m=/^\/api\/cfd\/jobs\/([a-f0-9-]{36})(?:\/(cancel|download|results))?$/.exec(path);
    if(m){const j=jobs.get(m[1]);if(!j)return json(res,404,{error:'Unknown local job.'});
      if(!m[2]&&req.method==='GET')return json(res,200,publicJob(j));
      if(m[2]==='cancel'&&req.method==='POST'){await cancel(j);return json(res,200,publicJob(j));}
      if(m[2]==='results'&&req.method==='GET'){if(!j.result)return json(res,409,{error:'No genuine solver result is available for this job yet.'});return json(res,200,j.result);}
      if(m[2]==='download'&&req.method==='GET'){const bytes=await caseArchive(j);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="openfoam-${j.id}.zip"`});return res.end(bytes);}
      return json(res,405,{error:'Unsupported job operation.'});
    }
    if(path.startsWith('/api/'))return json(res,404,{error:'Unknown API route.'});
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Read-only static route.'});
    const staticRoot=resolve(ROOT,'dist'),file=resolve(staticRoot,'.'+decodeURIComponent(path==='/'?'/index.html':path));
    if(!file.startsWith(staticRoot+sep))return json(res,403,{error:'Invalid static path.'});
    const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[Object.keys(mime).find(e=>file.endsWith(e))]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
  }catch(error){if(!res.headersSent)json(res,error.code==='ENOENT'?404:400,{error:error.message});else res.end();}
});
await mkdir(RUNS,{recursive:true});
await mkdir(STUDIES,{recursive:true});
try{calibration=JSON.parse(await readFile(CALIBRATION,'utf8'));}catch{calibration={};}
// Completed results survive a local service restart; interrupted work is never replayed silently.
for(const entry of await readdir(RUNS,{withFileTypes:true})) {
  if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;
  try {
    const dir=resolve(RUNS,entry.name),record=JSON.parse(await readFile(resolve(dir,'job.json'),'utf8'));
    const j={...record,listeners:new Set(),dir,container:`hull-cfd-${entry.name}`,log:Array.isArray(record.logTail)?record.logTail:[],partial:'',geometryHash:record.manifest?.sourceHash,protocolHash:record.manifest?.protocolKey,hydro:record.result?.hydro??JSON.parse(await readFile(resolve(dir,'hydrostatics.json'),'utf8'))};
    if(!['completed','failed','cancelled'].includes(j.status)){j.status='failed';j.error='Local service restarted before this job completed. Inspect its raw logs and submit a new case if needed.';j.stage='Interrupted by service restart';}
    jobs.set(j.id,j);
  } catch { /* Ignore incomplete temporary directories rather than inventing a result. */ }
}
for(const entry of await readdir(STUDIES,{withFileTypes:true})){
  if(!entry.isFile()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
  try{await studyRunner.restore(JSON.parse(await readFile(resolve(STUDIES,entry.name),'utf8')));}catch{/* Ignore incomplete study snapshots; never fabricate progress or resume execution. */}
}
server.listen(PORT,HOST,()=>console.log(`Hull Test Bench + OpenFOAM: http://${HOST}:${PORT}\nJobs remain in ${RUNS}\nImage: ${IMAGE}\nResources: ${defaultCores} of ${maxCores} CPU cores by default (choose in the app), ${memory} RAM. CFD output remains unvalidated until convergence and physical testing.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{for(const id of [...studyRunner.queuedIds])await studyRunner.cancel(id);if(studyRunner.activeId)await studyRunner.cancel(studyRunner.activeId);if(active&&active.status!=='cancelled')await cancel(active);server.close(()=>process.exit(0));});
