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
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import * as core from './generated/core.mjs';
import {readCfdRunResult} from './result-reader.mjs';
import {StudyRunner,numericalRequest,phasesFor,conditionPhases} from './study-runner.mjs';
import {predictRun,learn,remainingStudySeconds} from './estimator.mjs';
import {explainFailure} from './failure-hints.mjs';
import {repairHullTriangles} from './geometry-repair.mjs';
import * as cluster from './cluster.mjs';

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
const defaultCores=/^\d+$/.test(process.env.CFD_CPUS||'')?Math.min(maxCores,Math.max(1,Number(process.env.CFD_CPUS))):Math.max(1,Math.min(12,maxCores>2?Math.floor(maxCores/2):maxCores)); // measured: more ranks than physical cores is slower
const STAGE_TEXT={surfaceCheck:'Checking hull surface',blockMesh:'Building background mesh',surfaceFeatureExtract:'Extracting hull edges',snappyHexMesh:'Meshing actual hull',checkMesh:'Checking mesh quality',meshDetailedDiagnostics:'Detailed mesh diagnostics',setFields:'Setting initial water level',decomposePar:'Splitting mesh across CPU cores',interFoam:'Solving free-surface flow'};
const clampCores=v=>Number.isInteger(v)&&v>=1?Math.min(v,maxCores):defaultCores;
// Per-run safety stop. Full-mode fine wave runs take many hours on a laptop, so the default is generous (72 h);
// set CFD_TIMEOUT_MS to change it (1 minute to 7 days).
const maxMs=Math.max(60_000,Math.min(Number(process.env.CFD_TIMEOUT_MS)||72*3_600_000,7*86_400_000));
const CALIBRATION=resolve(RUNS,'calibration.json');
let calibration={};
/* ---------- Optional Slurm cluster backend (e.g. CSC Roihu) ---------- */
const CLUSTER_CONFIG=resolve(RUNS,'cluster.json'),CLUSTER_CALIBRATION=resolve(RUNS,'calibration-cluster.json');
let clusterConfig=cluster.normaliseClusterConfig(),clusterCalibration={},clusterCheck=null,clusterInstall={state:'idle',message:''};
const clusterJobs=new Map();let clusterPolling=false;
const clusterReady=()=>clusterConfig.enabled&&!cluster.clusterProblems(clusterConfig).length;
const POLL_MS=20_000;
// A running cluster job with no new log output for this long has hung; it is cancelled and reported (CFD_STALL_MINUTES).
const STALL_MS=Math.max(5,Number(process.env.CFD_STALL_MINUTES)||20)*60_000;
const TERMINAL_STUDY=new Set(['completed','failed','cancelled','interrupted']);
const TERMINAL_JOB=new Set(['completed','failed','cancelled']);
const DONE_CONDITION=new Set(['completed','failed','blocked','cancelled','interrupted','skipped']);

function publicJob(j){return {backend:j.backend??'local',slurmId:j.slurmId??null,slurmState:j.slurmState??null,remoteDir:j.remoteDir??null,id:j.id,name:j.name,status:j.status,stage:j.stage,cores:j.cores??null,progress:j.progress?{...j.progress,samples:undefined}:null,logLines:j.lineCount??0,createdAt:j.createdAt,updatedAt:j.updatedAt,logTail:j.log.slice(-100),error:j.error||null,hint:j.hint??null,timing:j.timing??null,result:j.result||null,manifest:j.manifest,request:j.request,studyId:j.studyId??null,conditionId:j.conditionId??null,studyPhase:j.studyPhase??null};}
function settleJob(j){const resolveJob=jobWaiters.get(j.id);if(resolveJob){jobWaiters.delete(j.id);resolveJob(publicJob(j));}}
async function persistStudy(record){
  const previous=studyWrites.get(record.id)??Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const path=resolve(STUDIES,record.id+'.json'),temp=path+'.tmp';await writeFile(temp,JSON.stringify(record,null,2));await rename(temp,path);});
  studyWrites.set(record.id,next);
  try{await next;}finally{if(studyWrites.get(record.id)===next)studyWrites.delete(record.id);}
}
// Locally one solve at a time; on the cluster every solve of several studies at once (each is its own Slurm job).
const studyRunner=new StudyRunner({runCase:runStudyCase,cancelCase:async id=>{const j=jobs.get(id);if(j?.studyId)await cancel(j);},persist:persistStudy,
  slots:()=>clusterReady()?{studies:clusterConfig.concurrentStudies,runs:64}:{studies:1,runs:1},
  // After a restart, a study waits again for its re-attached cluster jobs (null: the job is not being watched).
  loadPlan:async record=>{const tris=await loadGeometry(record.id,{exact:true});const plan=core.createAutomaticPlan({name:record.name,trianglesMm:tris});return new Map(plan.conditions.map(c=>[c.id,c]));},
  resumeJob:id=>{const j=jobs.get(id);if(!j)return null;if(['completed','failed','cancelled'].includes(j.status))return Promise.resolve(publicJob(j));if(!clusterJobs.has(id))return null;return new Promise(resolveJob=>jobWaiters.set(id,resolveJob));}});
function publicStudy(record){
  if(!record)return null;
  const j=jobs.get(record.activeJobId);
  const eta=queueTimes().get(record.id);if(eta)record.eta=eta;else if(TERMINAL_STUDY.has(record.status))record.eta={remainingS:0,finishAt:null};
  const queuePosition=studyRunner.queuedIds.indexOf(record.id);record.queuePosition=queuePosition>=0?queuePosition+1:null;
  if(j){record.activeJob={id:j.id,status:j.status,stage:j.stage,cores:j.cores??null,progress:j.progress?{...j.progress,samples:undefined}:null,logTail:j.log.slice(-15)};const condition=record.conditions.find(c=>c.id===j.conditionId);record.stage=`${condition?.label??'Automatic test'} · ${j.studyPhase}: ${j.stage}`;}
  const pred=studyPredictions.get(record.id);let weightSum=0,doneSum=0;
  for(const condition of record.conditions){
    for(const run of condition.runs??[]){
      const job=run.jobId&&jobs.get(run.jobId);
      if(job)run.live={status:job.status,stage:job.stage,percent:Number.isFinite(job.progress?.percent)?job.progress.percent:0,etaS:Number.isFinite(job.progress?.etaS)?job.progress.etaS:null,slurmState:job.slurmState??null};
    }
    const planned=pred?.get(condition.id)?.runs?.filter(r=>!r.error)??conditionPhases(condition,record.options?.speed).map(phase=>({phase}));
    for(const r of planned){
      const weight=r.manifest?Math.max(1,predictS(r.manifest,record.options?.cores??defaultCores,record.options?.backend).totalS):1,run=condition.runs?.find(x=>x.phase===r.phase);
      const fraction=DONE_CONDITION.has(condition.status)||(run&&DONE_CONDITION.has(run.status))?1:run?.live?(run.live.status==='completed'?1:run.live.percent/100):0;
      weightSum+=weight;doneSum+=weight*fraction;
    }
  }
  record.overall={percent:weightSum?100*doneSum/weightSum:0,weighted:!!pred};
  // Every running test shows its own job's live stage (on a cluster all of a study's tests run at once).
  for(const condition of record.conditions){
    if(condition.status!=='running')continue;
    const run=[...(condition.runs??[])].reverse().find(r=>r.jobId&&jobs.has(r.jobId)),job=run&&jobs.get(run.jobId);
    if(job&&!['completed','failed','cancelled'].includes(job.status))condition.stage=`${job.studyPhase}: ${job.stage}${job.progress?.percent>0&&job.progress.percent<100?` (${Math.round(job.progress.percent)}%)`:''}`;
  }
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
const slimManifest=m=>({condition:{kind:m.condition?.kind},mesh:{fidelity:m.mesh?.fidelity,estimatedBaseCells:m.mesh?.estimatedBaseCells,finestCellM:m.mesh?.finestCellM},numerics:{durationS:m.numerics?.durationS,maxDeltaTS:m.numerics?.maxDeltaTS,maxCo:m.numerics?.maxCo}});
/** Prepare (but never run) every solve a condition would make, to preflight it and size its mesh. */
async function prepareEstimates(geomKey,condition,speed){
  const key=`${geomKey}|${condition.id}|${speed}`;
  if(estimateCache.has(key))return estimateCache.get(key);
  const pending=(async()=>{
    const runs=[];let fine=null;
    for(const phase of phasesFor(speed,condition.mode??condition.request?.mode)){
      await new Promise(r=>setImmediate(r)); // keep the service responsive between ~0.3 s preparations
      try{const p=await core.prepareCfdJob(numericalRequest(condition.request,phase,fine?{manifest:fine}:null,speed),'estimate');runs.push({phase,manifest:slimManifest(p.package.manifest)});if(phase==='fine')fine=p.package.manifest;}
      catch(e){const error=String(e?.message??e);runs.push({phase,error,hint:explainFailure(error)});break;}
    }
    return {runs};
  })();
  estimateCache.set(key,pending);if(estimateCache.size>3000)estimateCache.delete(estimateCache.keys().next().value);
  return pending;
}
/** A cluster node scales well past one desktop's saturation (384 cores per Roihu node). */
const CLUSTER_SATURATION=512,CELLS_PER_CORE=5000,MAX_CLUSTER_CORES=192;
/**
 * Cores for one cluster job: the configured count for Quick-sized meshes, more for larger meshes so each core keeps
 * about 5000 cells (64 cores was the measured optimum at ~330k cells). Rounded to 32 so jobs pack onto nodes.
 */
function clusterCoresFor(manifest){
  const base=clusterConfig.cores,cells=predictRun(manifest,{cores:base,calibration:clusterCalibration,saturation:CLUSTER_SATURATION}).cells;
  // Finer-mesh calm checks set Full mode's wall time (54-86 min on 128 cores, 18 Nov): give them the maximum.
  if(['medium','fine'].includes(manifest?.mesh?.level))return Math.max(base,MAX_CLUSTER_CORES);
  if(!(cells>0))return base;
  return Math.max(base,Math.min(MAX_CLUSTER_CORES,Math.max(base,Math.ceil(cells/CELLS_PER_CORE/32)*32)));
}
const predictS=(manifest,cores,backend='local')=>backend==='cluster'?predictRun(manifest,{cores:clusterCoresFor(manifest),calibration:clusterCalibration,saturation:CLUSTER_SATURATION}):predictRun(manifest,{cores,calibration});
function summariseCondition(condition,entry,cores,backend='local'){
  const first=entry.runs[0],blocked=!!first?.error;
  const runs=entry.runs.map(r=>r.error?{phase:r.phase,error:r.error,hint:r.hint}:{phase:r.phase,cells:predictS(r.manifest,cores,backend).cells,predictedS:predictS(r.manifest,cores,backend).totalS,simulatedS:r.manifest.numerics.durationS});
  // On the cluster every solve of a condition runs at once: its wall time is the slowest one.
  const ok=runs.filter(r=>Number.isFinite(r.predictedS)),parallelS=Math.max(0,...ok.map(r=>r.predictedS));
  return {id:condition.id,label:condition.label,mode:condition.mode,blocked,error:blocked?first.error:null,hint:blocked?first.hint:null,
    laterPhaseError:!blocked&&entry.runs.find(r=>r.error)?.error||null,predictedS:backend==='cluster'?parallelS:runs.reduce((t,r)=>t+(r.predictedS??0),0),runs};
}
/**
 * Remaining wall time of one cluster run. Before solving: the calibrated prediction minus time already spent. While
 * solving: the live solver rate, blended with the prediction over the first 10% (start-up steps are unrepresentative).
 */
function runRemainingS(j,manifest){
  const pred=predictS(manifest,0,'cluster');
  if(j&&TERMINAL_JOB.has(j.status))return 0;
  const p=j?.progress;
  if(p?.step==='interFoam'||p?.percent>0){
    const done=Math.max(0,Math.min(1,(p.percent??0)/100));
    if(done>=.995)return 60; // solved; only the result download is left
    // No live rate yet (just started, or the rate window was reset after a log skip): prediction for what is left.
    if(!Number.isFinite(p.etaS))return Math.max(0,pred.solveS*(1-done));
    const w=Math.min(1,done/.1);
    return w*p.etaS+(1-w)*Math.max(0,pred.solveS*(1-done));
  }
  const elapsed=j?.timing?.runningAt?(Date.now()-j.timing.runningAt)/1000:0;
  return Math.max(pred.totalS*.05,pred.totalS-elapsed);
}
/** Remaining time for one study, from calibrated predictions plus the live solver rate of the active run. */
function studyRemaining(record){
  if(TERMINAL_STUDY.has(record.status))return {remainingS:0};
  const pred=studyPredictions.get(record.id);if(!pred)return null;
  if(record.options?.backend==='cluster'){
    // Parallel: every solve runs at once, so each condition needs its slowest unfinished solve.
    let worst=0,slowest=null;
    for(const c of record.conditions){
      const entry=pred.get(c.id);if(!entry)return null;if(DONE_CONDITION.has(c.status))continue;
      const left=entry.runs.filter(r=>!r.error).map(r=>{const run=c.runs.find(x=>x.phase===r.phase),j=run?.jobId?jobs.get(run.jobId):null;
        if(run&&DONE_CONDITION.has(run.status))return 0;
        return runRemainingS(j,r.manifest);});
      const ok=entry.runs.filter(r=>!r.error),total=Math.max(0,...left);
      if(total>worst){worst=total;slowest=`${c.label} · ${ok[left.indexOf(total)]?.phase??''}`;}
    }
    return {remainingS:worst,activeRunS:worst,slowest,basedOnFinishedRuns:Object.keys(clusterCalibration.entries??{}).length>0};
  }
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
  for(const id of [...studyRunner.activeIds,...studyRunner.queuedIds]){
    const record=studyRunner.records.get(id);if(!record)continue;
    const r=studyRemaining(record);
    if(record.options?.backend==='cluster'&&studyRunner.activeIds.has(id)){out.set(id,r?{remainingS:r.remainingS,startsInS:0,finishAt:new Date(now+r.remainingS*1000).toISOString(),parallel:true,slowest:r.slowest??null}:{remainingS:null,startsInS:0,finishAt:null,estimating:true});continue;}
    if(!r||!known){known=false;out.set(id,{remainingS:r?.remainingS??null,startsInS:id===studyRunner.activeId?0:null,finishAt:null,estimating:!r});continue;}
    out.set(id,{remainingS:r.remainingS,startsInS:offset,finishAt:new Date(now+(offset+r.remainingS)*1000).toISOString(),basedOnFinishedRuns:r.basedOnFinishedRuns});
    offset+=r.remainingS;
  }
  return out;
}
function queueSummary(){
  const times=queueTimes(),ids=[...studyRunner.activeIds,...studyRunner.queuedIds];
  const all=ids.map(id=>times.get(id)),known=all.length&&all.every(t=>t&&Number.isFinite(t.remainingS));
  // Parallel (cluster) studies overlap: the queue finishes when the slowest one does.
  const totalS=known?all.reduce((s,t)=>t.parallel?Math.max(s,t.remainingS):s+t.remainingS,0):null;
  return {studies:ids.length,backend:clusterReady()?'cluster':'local',activeIds:[...studyRunner.activeIds],activeId:studyRunner.activeId,queuedIds:studyRunner.queuedIds,remainingS:totalS,finishAt:totalS!==null?new Date(Date.now()+totalS*1000).toISOString():null,calibratedRunTypes:Object.keys(calibration.entries??{})};
}
async function saveCalibration(){try{await writeFile(CALIBRATION+'.tmp',JSON.stringify(calibration,null,2));await rename(CALIBRATION+'.tmp',CALIBRATION);}catch{/* estimates are optional */}}
const geometryPath=id=>resolve(STUDIES,id+'.geometry.bin');
const exactGeometryPath=id=>resolve(STUDIES,id+'.geometry64.bin');
async function saveGeometry(id,tris){await writeFile(exactGeometryPath(id),Buffer.from(new Float64Array(tris).buffer));}
/** exact=true: only the bit-exact float64 copy (needed to continue a study); otherwise falls back to older float32 files. */
async function loadGeometry(id,{exact=false}={}){
  try{const b=await readFile(exactGeometryPath(id));return Array.from(new Float64Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)));}
  catch(error){if(exact)throw error;}
  const b=await readFile(geometryPath(id));return Array.from(new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)));
}
/** Time predictions for a study (also rebuilt for studies re-attached after a restart). */
async function ensurePredictions(record){
  if(studyPredictions.has(record.id))return;
  const tris=await loadGeometry(record.id),plan=core.createAutomaticPlan({name:record.name,trianglesMm:tris}),gk=geometryKey(tris),map=new Map();
  for(const c of plan.conditions)if(record.conditions.some(x=>x.id===c.id))map.set(c.id,await prepareEstimates(gk,c,record.options?.speed??'full'));
  studyPredictions.set(record.id,map);
}
function selectConditions(plan,ids){
  if(ids===undefined)return null;
  if(!Array.isArray(ids)||!ids.length)return 'Select at least one test condition.';
  const wanted=new Set(ids.map(String)),unknown=[...wanted].filter(id=>!plan.conditions.some(c=>c.id===id));
  if(unknown.length)return `Unknown test condition: ${unknown.join(', ')}`;
  plan.conditions=plan.conditions.filter(c=>wanted.has(c.id));return null;
}
async function createStudy(plan,trianglesMm,{speed,cores,experiment}){
  const backend=clusterReady()?'cluster':'local';if(backend==='cluster')cores=clusterConfig.cores;
  const study=await studyRunner.create(plan,{id:randomUUID(),name:plan.name,speed,cores,backend,protocolVersion:core.PROTOCOL_VERSION,...(experiment?{experiment}:{})});
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
    p.samples.push([now,t]);while(p.samples.length>2&&now-p.samples[0][0]>600_000)p.samples.shift();
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
  if(clusterReady()){
    const ok=clusterCheck?.ok===true&&clusterCheck.solverInstalled===true;
    return {available:ok,backend:'cluster',host:clusterConfig.host,image:IMAGE,version:'2312',maxCores:clusterConfig.cores,defaultCores:clusterConfig.cores,
      message:ok?`Runs on ${clusterConfig.host} (${clusterConfig.cores} cores per test, all tests in parallel).`:'Cluster selected: open the cluster settings, press Test connection, then Install solver.'};
  }
  return dockerStatus();
}
/** Local Docker solver availability (used by local runs even while the cluster is selected). */
async function dockerStatus(){
  if(availability&&Date.now()-availability.at<10_000)return availability.value;
  let value;
  try{await execute('docker',[...dockerPrefix,'image','inspect',IMAGE],{env:dockerEnv,timeout:15_000,maxBuffer:256_000});value={available:true,backend:'local',image:IMAGE,version:'2312',maxCores,defaultCores,message:'Pinned OpenCFD v2312 Docker image is installed. Numerical and physical validation remain required.'};}
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
/**
 * Fingerprint of a generated case: every input file, with the job id masked. Two jobs with the same fingerprint are the
 * same simulation (geometry, mesh, numerics and generator version), so a Full study can reuse a finished Quick result
 * instead of queueing an identical 192-core run again.
 */
function caseDigest(files,id){
  const h=createHash('sha256');
  for(const name of Object.keys(files).sort()){
    const v=files[name];h.update(name+'\0');
    h.update(typeof v==='string'?v.split(id).join('<case>'):Buffer.from(v instanceof Uint8Array?v:strToU8(String(v))));h.update('\0');
  }
  return h.digest('hex');
}
async function reusableJob(prepared,id){
  const m=prepared.package.manifest,want=caseDigest(prepared.package.files,id);
  for(const j of jobs.values()){
    if(j.status!=='completed'||j.result?.source!=='OpenFOAM'||j.manifest?.sourceHash!==m.sourceHash||j.manifest?.protocolKey!==m.protocolKey||j.manifest?.mesh?.level!==m.mesh?.level)continue;
    try{
      const old=unzipSync(new Uint8Array(await readFile(resolve(j.dir,'case-input.zip'))));
      // String files were zipped as UTF-8; compare them as text so the id mask applies.
      const files=Object.fromEntries(Object.entries(old).map(([k,v])=>[k,typeof prepared.package.files[k]==='string'?strFromU8(v):v]));
      if(Object.keys(files).length===Object.keys(prepared.package.files).length&&caseDigest(files,j.id)===want)return j;
    }catch{/* no inputs on disk: not reusable */}
  }
  return null;
}
async function enqueueCase(body,context={}){
  const id=randomUUID();let prepared;
  try{prepared=await core.prepareCfdJob(body,id);}catch(error){error.preflight=true;throw error;}
  if(context.isCancelled?.())return {id:null,status:'cancelled',result:null,error:null};
  if(context.reuse&&context.studyId){
    const hit=await reusableJob(prepared,id).catch(()=>null);
    if(hit)return {id:hit.id,status:'completed',result:hit.result,error:null,hint:null,reused:true};
  }
  const dir=resolve(RUNS,id);await writePackage(dir,prepared.package.files);
  const {trianglesMm,...summary}=prepared.request;void trianglesMm;
  const j={id,dir,name:summary.name,container:`hull-cfd-${id}`,status:'queued',stage:'Queued',createdAt:new Date().toISOString(),log:[],request:summary,manifest:prepared.package.manifest,hydro:prepared.hydro,geometryHash:prepared.geometryHash,protocolHash:prepared.protocolHash,
    studyId:context.studyId??null,conditionId:context.conditionId??null,studyPhase:context.phase??null,cores:clampCores(context.cores??body?.cores),lineCount:0,listeners:new Set(),
    backend:(context.backend??(context.studyId?'local':clusterReady()?'cluster':'local'))==='cluster'?'cluster':'local'};
  if(j.backend==='cluster')j.cores=clusterCoresFor(j.manifest);
  jobs.set(id,j);await save(j);
  let done;
  if(context.studyId)done=new Promise(resolveJob=>jobWaiters.set(id,resolveJob));
  await context.onQueued?.(id);
  if(context.isCancelled?.()||j.status==='cancelled'){j.status='cancelled';j.stage='Cancelled before execution';await save(j);settleJob(j);}
  else if(j.backend==='cluster')void submitToCluster(j);
  else{queue.push(j);void startNext();}
  return context.studyId?done:publicJob(j);
}
async function runStudyCase(body,context){return enqueueCase(body,context);}
async function startNext(){
  if(active||!queue.length)return;
  const j=queue.shift();if(j.status==='cancelled'){void startNext();return;}active=j;
  try{
    if(j.cancelRequested||j.status==='cancelled')return;
    if(!(await dockerStatus()).available)throw new Error('The pinned OpenFOAM image or Docker daemon is unavailable. Run npm run cfd:pull.');
    if(j.cancelRequested||j.status==='cancelled')return;
    await setState(j,'meshing','Checking surfaces and building finite-volume mesh');
    j.timing={startedAt:Date.now()};
    append(j,`Starting OpenFOAM in Docker on ${j.cores} CPU core${j.cores===1?'':'s'} (${memory} RAM limit)\n`);
    if(j.cancelRequested||j.status==='cancelled')return;
    const args=[...dockerPrefix,'run','--rm','--name',j.container,'--network','none','--cpus',String(j.cores),'--memory',memory,'-e',`HULL_NPROCS=${j.cores}`,'--shm-size','1g','--entrypoint','/bin/bash','--mount',`type=bind,src=${j.dir},dst=/case`,'--workdir','/case',IMAGE,'Allrun'];
    const child=spawn('docker',args,{env:dockerEnv,stdio:['ignore','pipe','pipe']});j.child=child;
    const timer=setTimeout(()=>{j.error=`Stopped by the safety time limit (${Math.round(maxMs/3_600_000)} h per run). Set CFD_TIMEOUT_MS to allow longer runs.`;void cancel(j);},maxMs);
    // Same hang watchdog as on the cluster: no solver output for STALL_MS stops the run instead of holding the machine.
    let lastOutputAt=Date.now();
    const stall=setInterval(()=>{if(Date.now()-lastOutputAt>STALL_MS){j.error=`The solver stopped responding (no output for ${Math.round(STALL_MS/60000)} minutes) and was stopped. Re-run this test; it is not a hull result.`;void cancel(j);}},60_000);
    const stream=async chunk=>{lastOutputAt=Date.now();const text=chunk.toString();append(j,text);await writeFile(resolve(j.dir,'service-runner.log'),text,{flag:'a'}).catch(()=>{});};
    child.stdout.on('data',stream);child.stderr.on('data',stream);
    const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);}).finally(()=>{clearTimeout(timer);clearInterval(stall);});j.child=null;
    if(j.cancelRequested||j.status==='cancelled')return;
    if(code!==0)throw new Error(`OpenFOAM stopped with exit ${code}. Inspect the stage logs; no CFD value was fabricated.`);
    await finishRun(j);
  }catch(error){if(j.status!=='cancelled')await failRun(j,error);}
  finally{settleJob(j);active=null;j.child=null;void startNext();}
}
async function failRun(j,error){j.error=error.message;append(j,error.message+'\n');j.hint=explainFailure(j.error,j.log.slice(-300));if(j.timing)j.timing.finishedAt=Date.now();await setState(j,'failed',j.hint?.title??'Solver or preflight failed');}
/** Read the genuine solver output of a finished run (local or cluster), learn its timing, and mark it completed. */
async function finishRun(j){
    await setState(j,'solving','Reading actual force and motion histories');
    j.result=await readCfdRunResult(j.dir,{manifest:j.manifest,hydro:j.hydro,geometryHash:j.geometryHash,protocolHash:j.protocolHash,...core});
    // The reader exposes actual mesh counts under solverRun; keep the UI contract explicit.
    j.result.mesh={cells:j.result.solverRun?.actualMeshCells??null,quality:j.result.quality?.meshOkay??null};
    if(j.result.motion)j.result.motion.maxRollDeg=j.result.motion.maxAbsRollDeg;
    // A cluster job's streamed log can trail the finished run; show the completed solve as 100%.
    if(j.result.quality?.completedTime===true&&j.progress){j.progress.percent=100;j.progress.etaS=0;if(j.progress.endTimeS)j.progress.simTimeS=j.progress.endTimeS;}
    await writeFile(resolve(j.dir,'results.json'),JSON.stringify(j.result,null,2));
    j.timing.finishedAt=Date.now();
    // Calibrate time estimates from runs that reached their full simulated time on this machine.
    if(j.result.quality?.completedTime===true&&j.progress?.solveStartedAt&&j.progress?.stepCount>10){
      const steps=j.result.solverRun?.actualDeltaTS?.count??j.progress.stepCount,solveFrom=j.logSkipped?(j.timing.runningAt??j.progress.solveStartedAt):j.progress.solveStartedAt;
      const sample={manifest:j.manifest,actualCells:j.result.solverRun?.actualMeshCells,steps,solveWallS:(j.timing.finishedAt-solveFrom)/1000,meshWallS:(j.progress.solveStartedAt-(j.timing.runningAt??j.timing.startedAt))/1000,cores:j.cores};
      if(j.backend==='cluster'){clusterCalibration=learn(clusterCalibration,{...sample,saturation:CLUSTER_SATURATION});void saveJson(CLUSTER_CALIBRATION,clusterCalibration);}
      else{calibration=learn(calibration,sample);void saveCalibration();}
    }
    await setState(j,'completed','Completed — convergence and physical validation pending');
}
async function saveJson(path,value){try{await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}catch{/* optional */}}

/* ---------- Cluster execution ---------- */
async function submitToCluster(j){
  try{
    if(!clusterReady())throw new Error('Cluster settings are incomplete. Open "Run on Roihu" settings.');
    const cert=await cluster.certificateStatus(clusterConfig);
    if(cert.required&&!cert.valid)throw new Error(cert.message);
    j.remoteDir=`${clusterConfig.remoteDir}/runs/${j.id}`;j.timing={startedAt:Date.now()};
    await setState(j,'queued','Uploading case to the cluster');
    append(j,`Uploading case to ${clusterConfig.host} (${j.remoteDir})\n`);
    await writeFile(resolve(j.dir,'job.sh'),cluster.batchScript(clusterConfig,{name:'hull-'+j.id.slice(0,8),cores:j.cores}));
    await cluster.upload(clusterConfig,j.dir,j.remoteDir);
    if(j.cancelRequested)return;
    j.slurmId=await cluster.submit(clusterConfig,j.remoteDir);j.offset=0;j.slurmState='PENDING';
    append(j,`Submitted Slurm job ${j.slurmId} (${j.cores} cores, partition ${clusterConfig.partition}, up to ${clusterConfig.hours} h)\n`);
    await setState(j,'queued',cluster.SLURM_TEXT.PENDING);
    if(j.cancelRequested){await cluster.cancelRemote(clusterConfig,j.slurmId);return;}
    clusterJobs.set(j.id,j);void pollCluster();
  }catch(error){if(j.status!=='cancelled'){await failRun(j,error);settleJob(j);}}
}
/** Poll all cluster jobs with one SSH call: live logs, Slurm state, and download/finish when a job ends. */
async function pollCluster(){
  if(clusterPolling)return;clusterPolling=true;
  try{
    while(clusterJobs.size){
      const list=[...clusterJobs.values()];let states;
      try{states=await cluster.poll(clusterConfig,list.map(j=>({slurmId:j.slurmId,remoteDir:j.remoteDir,offset:j.offset})));}
      catch(error){for(const j of list)if(j.lastConnError!==error.message){j.lastConnError=error.message;append(j,'Cluster connection problem (the job keeps running on the cluster; retrying every 20 s): '+error.message+'\n');}await new Promise(r=>setTimeout(r,POLL_MS));continue;}
      for(const j of list)j.lastConnError=null;
      for(const j of list){
        const s=states.get(String(j.slurmId));if(!s||!clusterJobs.has(j.id))continue;
        if(s.skipped&&s.text){
          // Jumped ahead: drop the cut first line and restart the rate window (sim time jumps over unseen steps).
          j.partial='';j.logSkipped=true;if(j.progress)j.progress.samples=[];
          const cut=s.text.indexOf('\n');s.text='[… earlier solver output skipped to keep up; the full log comes with the results …]\n'+(cut>=0?s.text.slice(cut+1):'');
        }
        if(s.text){append(j,s.text);j.offset=s.bytes;await writeFile(resolve(j.dir,'service-runner.log'),s.text,{flag:'a'}).catch(()=>{});}
        const state=s.state.replace(/[+].*$/,'');j.slurmState=state||j.slurmState;
        if(cluster.RUNNING_STATES.has(state)){
          if(state==='RUNNING'&&!j.timing.runningAt){j.timing.runningAt=Date.now();if(j.status==='queued')await setState(j,'meshing',cluster.SLURM_TEXT.RUNNING);}
          else if(state==='PENDING'&&j.status==='queued')j.stage=cluster.SLURM_TEXT.PENDING;
          // Watchdog: a running job whose log has not grown for STALL_MS has hung (seen once in a wave run: MPI stopped
          // mid-step and the job would have held its cores until the time limit). Cancel it and report it for a re-run.
          if(state==='RUNNING'){
            if(s.size!==j.lastLogSize){j.lastLogSize=s.size;j.lastLogGrowthAt=Date.now();}
            else if(Date.now()-(j.lastLogGrowthAt??Date.now())>STALL_MS&&!j.stallCancelled){
              j.stallCancelled=true;clusterJobs.delete(j.id);await cluster.cancelRemote(clusterConfig,j.slurmId);
              await failRun(j,new Error(`The solver stopped responding on the cluster (no output for ${Math.round(STALL_MS/60000)} minutes), so the job was cancelled to save your allocation. Re-run this test; it is not a hull result.`));
              settleJob(j);
            }
          }
          continue;
        }
        const exit=s.exitCode!=null?[null,s.exitCode]:/HULL_EXIT (\d+)/.exec(j.log.slice(-50).join('\n'));
        if(!exit&&!state){j.missingPolls=(j.missingPolls??0)+1;if(j.missingPolls<4)continue;}
        clusterJobs.delete(j.id);
        void (async()=>{
          try{
            if(j.cancelRequested)return;
            if(!exit||exit[1]!=='0')throw new Error(state==='TIMEOUT'?`The cluster stopped the job at its ${clusterConfig.hours} h time limit. Increase "Max hours per run" in the cluster settings.`:state==='OUT_OF_MEMORY'?'The cluster job ran out of memory. Set "Memory per run" higher in the cluster settings.':`OpenFOAM stopped on the cluster (Slurm state ${state||'unknown'}, exit ${exit?.[1]??'none'}). Inspect the stage logs; no CFD value was fabricated.`);
            await setState(j,'solving','Downloading results from the cluster');
            // A finished job's results stay on the cluster, so a lost connection or an expired certificate only delays the download.
            for(let attempt=0,last='';;attempt++){
              try{await cluster.download(clusterConfig,j.remoteDir,j.dir);break;}
              catch(error){
                if(j.cancelRequested||attempt>=4320)throw error;
                if(error.message!==last){last=error.message;append(j,'Download from the cluster failed (retrying every 20 s; the results are safe on the cluster): '+error.message+'\n');}
                await new Promise(r=>setTimeout(r,POLL_MS));
              }
            }
            await finishRun(j);
            // Results (logs + postProcessing) are local now; free the cluster's file quota.
            void cluster.removeRemote(clusterConfig,j.remoteDir);
          }catch(error){if(j.status!=='cancelled')await failRun(j,error);}
          finally{settleJob(j);}
        })();
      }
      await new Promise(r=>setTimeout(r,POLL_MS));
    }
  }finally{clusterPolling=false;}
}
async function cancel(j){
  j.cancelRequested=true;
  j.status='cancelled';j.stage=j.error?'Stopped at time limit':'Cancelled by user';
  const child=j.child;
  if(child){await execute('docker',[...dockerPrefix,'rm','-f',j.container],{env:dockerEnv,timeout:15_000}).catch(()=>{});child.kill('SIGTERM');}
  if(j.backend==='cluster'){clusterJobs.delete(j.id);if(j.slurmId)await cluster.cancelRemote(clusterConfig,j.slurmId);
    // A cancelled job is killed before its own cleanup: remove its folder once Slurm has stopped it.
    const dir=j.remoteDir;setTimeout(()=>void cluster.removeRemote(clusterConfig,dir),60_000).unref?.();}
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
    if(path==='/api/cfd/cluster'&&req.method==='GET')return json(res,200,{config:clusterConfig,problems:cluster.clusterProblems(clusterConfig),check:clusterCheck,install:clusterInstall,activeJobs:clusterJobs.size,certificate:await cluster.certificateStatus(clusterConfig)});
    if(path==='/api/cfd/cluster'&&req.method==='POST'){
      const next=cluster.normaliseClusterConfig({...clusterConfig,...await requestBody(req)});
      const changedTarget=['host','user','remoteDir','sshKey'].some(k=>next[k]!==clusterConfig[k]);
      if(clusterJobs.size&&changedTarget)return json(res,409,{error:'Cluster jobs are running. Change the connection settings after they finish.'});
      clusterConfig=next;if(changedTarget)clusterCheck=null;await saveJson(CLUSTER_CONFIG,clusterConfig);
      return json(res,200,{config:clusterConfig,problems:cluster.clusterProblems(clusterConfig),check:clusterCheck,install:clusterInstall});
    }
    if(path==='/api/cfd/cluster/check'&&req.method==='POST'){
      const problems=cluster.clusterProblems(clusterConfig);if(problems.length)return json(res,400,{error:problems.join(' ')});
      try{clusterCheck={ok:true,at:new Date().toISOString(),...await cluster.checkCluster(clusterConfig)};}
      catch(error){clusterCheck={ok:false,at:new Date().toISOString(),error:error.message};}
      return json(res,200,{config:clusterConfig,check:clusterCheck,install:clusterInstall,certificate:await cluster.certificateStatus(clusterConfig)});
    }
    if(path==='/api/cfd/cluster/install'&&req.method==='POST'){
      const problems=cluster.clusterProblems(clusterConfig);if(problems.length)return json(res,400,{error:problems.join(' ')});
      if(clusterInstall.state!=='running'){
        clusterInstall={state:'running',message:'Downloading the OpenFOAM v2312 image on the cluster (about 700 MB; usually 5–20 minutes).',startedAt:new Date().toISOString()};
        void cluster.installSolver(clusterConfig,IMAGE).then(async out=>{clusterInstall={state:'done',message:/already/.test(out)?'The solver was already installed.':'Solver installed on the cluster.'};try{clusterCheck={ok:true,at:new Date().toISOString(),...await cluster.checkCluster(clusterConfig)};}catch{}})
          .catch(error=>{clusterInstall={state:'failed',message:error.message};});
      }
      return json(res,202,{install:clusterInstall});
    }
    if(path==='/api/cfd/queue/cancel'&&req.method==='POST'){
      for(const id of [...studyRunner.queuedIds].reverse())await studyRunner.cancel(id);
      for(const id of [...studyRunner.activeIds])await studyRunner.cancel(id);
      return json(res,200,queueSummary());
    }
    if(path==='/api/cfd/estimate'&&req.method==='POST'){
      const body=await requestBody(req),{plan,fix}=await planFor(body.name,body.trianglesMm);
      const speed=['quick','mesh-check','experiment'].includes(body.speed)?body.speed:'full',cores=clampCores(Number(body.cores)),gk=geometryKey(fix.trianglesMm);
      const backend=clusterReady()?'cluster':'local',coresUsed=backend==='cluster'?clusterConfig.cores:cores;
      const conditions=[];for(const c of plan.conditions)conditions.push(summariseCondition(c,await prepareEstimates(gk,c,speed),coresUsed,backend));
      return json(res,200,{repairNotes:fix.notes,geometryMode:plan.geometryMode,speed,cores:coresUsed,backend,parallel:backend==='cluster',calibrated:Object.keys((backend==='cluster'?clusterCalibration:calibration).entries??{}).length>0,machineSpeedFactor:calibration.machineSpeedFactor??1,conditions,queue:queueSummary()});
    }
    if(path==='/api/cfd/studies'&&req.method==='POST'){
      if(!(await solverStatus()).available)return json(res,409,{error:'Start Docker and run npm run cfd:pull before starting automatic tests.'});
      const body=await requestBody(req),{plan,fix}=await planFor(body.name,body.trianglesMm);
      const problem=selectConditions(plan,body.conditionIds);if(problem)return json(res,400,{error:problem});
      const speed=['quick','mesh-check','experiment'].includes(body.speed)?body.speed:'full',cores=clampCores(Number(body.cores));
      const experiment=speed==='experiment'&&body.experiment&&typeof body.experiment==='object'?{waveGeneration:{...(Number.isFinite(body.experiment.wavelengths)?{wavelengths:body.experiment.wavelengths}:{}),...(Number.isFinite(body.experiment.strength)?{strength:body.experiment.strength}:{}),...(Number.isFinite(body.experiment.gainScale)?{gainScale:body.experiment.gainScale}:{})}}:undefined;
      const study=await createStudy(plan,fix.trianglesMm,{speed,cores,...(experiment?{experiment}:{})});return json(res,202,publicStudy(studyRunner.get(study.id)));
    }
    const studyMatch=/^\/api\/cfd\/studies\/([a-f0-9-]{36})(?:\/(cancel|download|rerun|geometry))?$/.exec(path);
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
        const study=await createStudy(plan,trianglesMm,{speed:['quick','full'].includes(body.speed)?body.speed:record.options?.speed??'full',cores:clampCores(Number(record.options?.cores))});
        return json(res,202,publicStudy(studyRunner.get(study.id)));
      }
      if(studyMatch[2]==='geometry'&&req.method==='GET'){
        // The placed (oriented, mm) triangles the study was run with, so the workbench can show the hull again after a reload.
        try{const trianglesMm=await loadGeometry(record.id);return json(res,200,{id:record.id,name:record.name,trianglesMm});}
        catch{return json(res,404,{error:'This study has no stored geometry.'});}
      }
      if(studyMatch[2]==='download'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':`attachment; filename="openfoam-study-${record.id}.json"`});return res.end(JSON.stringify(publicStudy(record),null,2));
      }
      return json(res,405,{error:'Unsupported automatic study operation.'});
    }
    if(path==='/api/cfd/jobs'&&req.method==='GET')return json(res,200,{jobs:[...jobs.values()].map(publicJob)});
    if(path==='/api/cfd/jobs'&&req.method==='POST'){
      if(!clusterReady()&&[...jobs.values()].filter(j=>['queued','preparing','meshing','solving'].includes(j.status)).length>=8)return json(res,429,{error:'The local queue is full. Finish or cancel a job before adding more.'});
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
clusterConfig=await cluster.loadClusterConfig(CLUSTER_CONFIG);
try{clusterCalibration=JSON.parse(await readFile(CLUSTER_CALIBRATION,'utf8'));}catch{clusterCalibration={};}
// Completed results survive a local service restart; interrupted work is never replayed silently.
const unnamedClusterJobs=[];
for(const entry of await readdir(RUNS,{withFileTypes:true})) {
  if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;
  try {
    const dir=resolve(RUNS,entry.name),record=JSON.parse(await readFile(resolve(dir,'job.json'),'utf8'));
    const j={...record,listeners:new Set(),dir,container:`hull-cfd-${entry.name}`,log:Array.isArray(record.logTail)?record.logTail:[],partial:'',geometryHash:record.manifest?.sourceHash,protocolHash:record.manifest?.protocolKey,hydro:record.result?.hydro??JSON.parse(await readFile(resolve(dir,'hydrostatics.json'),'utf8'))};
    if(!['completed','failed','cancelled'].includes(j.status)&&j.backend==='cluster'&&j.slurmId&&clusterReady()){
      // A submitted cluster job keeps running on the cluster while the app is closed: re-attach and keep watching it.
      // Its log is streamed again from the start (the saved tail is only the last lines).
      j.log=[];j.lineCount=0;j.offset=0;j.timing??={startedAt:Date.now()};j.reattached=true;
      append(j,`App restarted: re-attached to Slurm job ${j.slurmId}.\n`);
      jobs.set(j.id,j);clusterJobs.set(j.id,j);continue;
    }
    if(!['completed','failed','cancelled'].includes(j.status)){
      if(j.backend==='cluster'&&!j.slurmId)unnamedClusterJobs.push('hull-'+j.id.slice(0,8));
      j.status='failed';j.error='Local service restarted before this job completed. Inspect its raw logs and submit a new case if needed.';j.stage='Interrupted by service restart';}
    jobs.set(j.id,j);
  } catch { /* Ignore incomplete temporary directories rather than inventing a result. */ }
}
// Jobs whose submit was in flight when the service stopped have no recorded Slurm id; cancel them by their unique name.
if(unnamedClusterJobs.length&&clusterReady())void cluster.cancelRemoteByName(clusterConfig,unnamedClusterJobs);
for(const entry of await readdir(STUDIES,{withFileTypes:true})){
  if(!entry.isFile()||entry.isSymbolicLink()||!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
  try{await studyRunner.restore(JSON.parse(await readFile(resolve(STUDIES,entry.name),'utf8')));}catch{/* Ignore incomplete study snapshots; never fabricate progress or resume execution. */}
}
// Check the cluster connection at startup, so tests can be started without pressing Test connection first.
if(clusterConfig.enabled&&clusterConfig.user)void cluster.checkCluster(clusterConfig).then(r=>{clusterCheck={ok:true,at:new Date().toISOString(),...r};},e=>{clusterCheck={ok:false,at:new Date().toISOString(),error:e.message};});
if(clusterJobs.size)void pollCluster();
for(const id of studyRunner.activeIds){const r=studyRunner.records.get(id);if(r)void ensurePredictions(r).catch(()=>{});}
server.listen(PORT,HOST,()=>console.log(`Hull Test Bench + OpenFOAM: http://${HOST}:${PORT}\nJobs remain in ${RUNS}\nImage: ${IMAGE}\nResources: ${defaultCores} of ${maxCores} CPU cores by default (choose in the app), ${memory} RAM. CFD output remains unvalidated until convergence and physical testing.`));
// Closing the app stops local work. Cluster jobs keep running on the cluster and are re-attached at the next start
// (use Stop in the app to cancel them); studies still waiting in the queue are cancelled.
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{for(const id of [...studyRunner.queuedIds])await studyRunner.cancel(id);for(const id of [...studyRunner.activeIds]){const s=studyRunner.get(id);if(s?.options?.backend!=='cluster')await studyRunner.cancel(id);}if(active&&active.status!=='cancelled')await cancel(active);server.close(()=>process.exit(0));});
// A long-running service must not die because one child process closed its pipe early (a refused SSH upload did exactly
// that). Such stream errors are logged; anything else is still fatal.
process.on('uncaughtException',error=>{
  if(['EPIPE','ECONNRESET','ERR_STREAM_DESTROYED'].includes(error?.code)){console.error('Ignored stream error:',error.message);return;}
  console.error(error);process.exit(1);
});
