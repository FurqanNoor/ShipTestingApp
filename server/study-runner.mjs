/** Bounded unattended CFD studies. Passing sensitivity checks is not physical validation. */
import {explainFailure} from './failure-hints.mjs';
/**
 * Full: three solves per condition, all started at once on a cluster: coarse (the Quick setup), medium (grid refined by
 * sqrt(2)) and a halved time step on the coarse grid. The reported value is the medium-grid result.
 * Dropped from the earlier five-solve study: the fine grid (8-10 h per wave test, which made Full an overnight job)
 * and the 50% larger domain (on the first measured Full study it moved calm drag by -27% to +22%, i.e. inside the
 * run's own slow drag wander, so it did not tell a real boundary effect apart from noise).
 */
const PHASES=['coarse','medium','time-step'];
/** Allowed relative change for a pass. Calm drag wanders about +-10% over 3 s blocks of a 17.5 s averaging window, so
 * changes much below 5% cannot be resolved; a smaller bar would fail every hull on noise. */
export const SENSITIVITY_TOLERANCE=.05;
/** quick: one fast screening solve per condition. full: mesh and time-step sensitivity (3 solves). */
export const SPEEDS={quick:['coarse'],full:PHASES};
export function phasesFor(speed){return SPEEDS[speed]??SPEEDS.full;}
const TERMINAL=new Set(['completed','failed','cancelled','blocked','interrupted','skipped']);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const copy=v=>JSON.parse(JSON.stringify(v));
const getResult=run=>run?.status==='completed'&&run.result?.source==='OpenFOAM'?run.result:null;
const cells=r=>r?.solverRun?.actualMeshCells??r?.mesh?.cells;

function check(name,passed,reason,extra={}){return {name,passed,relativeChange:null,threshold:null,reason,...extra};}
function response(result,mode){return mode==='beam-waves'?result?.motion?.rollRmsDeg:result?.forces?.meanDragN;}
function comparable(a,b,domainVariant=false){
  if(!a||!b||!a.geometryHash||a.geometryHash!==b.geometryHash)return false;
  if(!domainVariant&&(!a.protocolHash||a.protocolHash!==b.protocolHash))return false;
  const x=a.manifest,y=b.manifest;
  if(!x||!y)return false;
  const physical=m=>({kind:m.condition?.kind,heightM:m.condition?.heightM??null,periodS:m.condition?.periodS??null,speedMps:m.speedMps,load:m.load,solver:m.solver,geometry:m.geometry,physics:m.physics,motion:m.motion?{inertiaKgM2:m.motion.inertiaKgM2,inertiaSource:m.motion.inertiaSource,initialOrientation:m.motion.initialOrientation,rollAxis:m.motion.rollAxis,inertiaTensorKgM2:m.motion.inertiaTensorKgM2,effectiveRollInertiaKgM2:m.motion.effectiveRollInertiaKgM2}:null});
  // Numerical controls and boundary size deliberately vary, physical mass/geometry/pose do not.
  const trimLoad=m=>{const p=physical(m);if(p.load)p.load={...p.load};return p;};
  if(JSON.stringify(trimLoad(x))!==JSON.stringify(trimLoad(y)))return false;
  return finite(x.numerics?.durationS)&&Math.abs(x.numerics.durationS-y.numerics?.durationS)<1e-9;
}
function difference(a,b,mode){
  const av=response(a,mode),bv=response(b,mode),floor=mode==='beam-waves'?.01:1e-6;
  if(!finite(av)||!finite(bv))return null;
  const scale=Math.max(Math.abs(av),Math.abs(bv));
  return scale>floor?Math.abs(av-bv)/scale:null;
}
function safeQuality(result,mode){
  if(!result)return false;
  const q=result.quality??{};
  const required=['meshOkay','detailedMeshOkay','completedTime','alphaBounded','residualsFinite','forceCoverageComplete','timeStepsValid'];
  if(required.some(k=>q[k]!==true)||!result.forces||!Number.isInteger(cells(result))||cells(result)<=0)return false;
  if(mode==='beam-waves')return q.waveDurationSufficient===true&&result.motion?.rollRmsDriftWithinTolerance===true&&finite(result.motion?.rollRmsDeg);
  return q.forceHistoryDrift===true&&finite(result.forces?.meanDragN);
}

/** Uses actual output only; thresholds are declared numerical diagnostics, never accuracy percentages. */
export function assessCondition(condition){
  const byPhase=new Map(condition.runs.map(run=>[run.phase,run]));
  const coarse=getResult(byPhase.get('coarse')),medium=getResult(byPhase.get('medium')),half=getResult(byPhase.get('time-step'));
  const checks=[],tol=SENSITIVITY_TOLERANCE,pct=Math.round(tol*100);
  const phases=phasesFor(condition.speed);
  checks.push(check('Completed numerical quality',phases.every(p=>safeQuality(getResult(byPhase.get(p)),condition.mode)),
    condition.mode==='beam-waves'?'All three runs need complete, bounded solver histories, both mesh reviews and stationary post-startup RMS roll.':'All three runs need complete, bounded solver histories, both mesh reviews and stationary post-startup forces.'));
  const meshComparable=comparable(coarse,medium);
  const distinct=meshComparable&&cells(coarse)<cells(medium);
  checks.push(check('Two distinct meshes',!!distinct,'Actual cell counts must increase from the coarse to the medium mesh on otherwise matching physical cases.'));
  const meshChange=distinct?difference(coarse,medium,condition.mode):null;
  checks.push(check('Mesh sensitivity',distinct&&meshChange!==null?meshChange<=tol:null,
    condition.mode==='beam-waves'?`Coarse-to-medium RMS roll change must be at most ${pct}%; tiny responses are inconclusive.`:`Coarse-to-medium drag change must be at most ${pct}%; near-zero drag is inconclusive.`,{relativeChange:meshChange,threshold:tol}));
  const actualFineDt=coarse?.solverRun?.actualDeltaTS?.maximum,actualHalfDt=half?.solverRun?.actualDeltaTS?.maximum;
  const dtComparable=comparable(coarse,half)&&cells(coarse)===cells(half);
  const dtReduced=dtComparable&&finite(actualFineDt)&&actualFineDt>0&&finite(actualHalfDt)&&actualHalfDt>0&&actualHalfDt<=actualFineDt*.6;
  checks.push(check('Actual time-step reduction',!!dtReduced,'The largest recorded solver time step must decrease by at least 40%; changing an inactive cap alone is inconclusive.'));
  const dtChange=dtComparable?difference(coarse,half,condition.mode):null;
  checks.push(check('Time-step sensitivity',dtReduced&&dtChange!==null?dtChange<=tol:null,`Coarse-grid reference and half-step response must differ by at most ${pct}%.`,{relativeChange:dtChange,threshold:tol}));
  const reference=medium??coarse,referenceRun=reference?[...byPhase.values()].find(r=>r.result===reference):null;
  const metrics=reference?{
    referenceJobId:referenceRun?.jobId??null,referenceMesh:referenceRun?.phase??null,
    meanDragN:finite(reference.forces?.meanDragN)?reference.forces.meanDragN:null,
    rollRmsDeg:finite(reference.motion?.rollRmsDeg)?reference.motion.rollRmsDeg:null,
    maxRollDeg:finite(reference.motion?.maxAbsRollDeg)?reference.motion.maxAbsRollDeg:null,
    heaveRmsM:finite(reference.motion?.heaveRmsM)?reference.motion.heaveRmsM:null,
    initialBuoyancyN:reference.hydro?.buoyancyN??null,initialGmM:reference.hydro?.gmM??null,freeboardM:reference.hydro?.freeboardM??null,
    cgM:reference.manifest?.load?.cgM??null,inertiaKgM2:reference.manifest?.motion?.inertiaKgM2??null,
    inertiaSource:reference.manifest?.motion?.inertiaSource??null,actualMeshCells:cells(reference)??null,
    waveHeightRatio:finite(reference.waves?.heightRatio)?reference.waves.heightRatio:null,wavePeriodRatio:finite(reference.waves?.periodRatio)?reference.waves.periodRatio:null,waveAchieved:reference.waves?.withinTolerance??null,rimImmersionRisk:reference.rimImmersion?.risk??null,rimMarginM:finite(reference.rimImmersion?.margin)?reference.rimImmersion.margin:null,
  }:null;
  if(condition.speed==='quick'){
    const quality=checks[0];
    return {checks:[quality],metrics,numericalSensitivityPassed:null,quick:true,physicalValidation:'not-performed',rankable:false,
      scope:'QUICK screening run: one coarse solve with a shortened observation window. No mesh, time-step or domain sensitivity was checked. Use Full mode before relying on these numbers.'};
  }
  return {checks,metrics,numericalSensitivityPassed:checks.every(c=>c.passed===true),physicalValidation:'not-performed',rankable:false,
    scope:'Declared mesh and time-step sensitivity diagnostics only (the domain size is fixed by the protocol). Uniform CAD mass assumptions, wave propagation/reflection, flow-model uncertainty and physical accuracy remain unvalidated.'};
}

function initialRecord(plan,{id,name,now,speed='full',cores=1,backend,protocolVersion}){
  const phases=phasesFor(speed);
  const {conditions,...summary}=plan;
  return {schema:1,id,name:name??plan.name??'Automatic hull study',status:'queued',stage:'Preparing automatic tests',createdAt:now,updatedAt:now,
    plan:copy(summary),options:{speed,cores,...(backend?{backend}:{}),...(protocolVersion?{protocolVersion}:{})},conditions:conditions.map(({request,...c})=>({...copy(c),speed,status:'pending',stage:'Waiting',runs:[]})),
    progress:{conditionsTotal:conditions.length,conditionsFinished:0,solvesFinished:0,solvesMaximum:conditions.length*phases.length},activeJobId:null,error:null,
    physicalValidation:'not-performed',rankable:false};
}
/**
 * Time-step controls. Calm: Courant 0.4 and a 2 ms cap. On the first Full study (SWATH hull, 150/250/350 g) halving the
 * earlier 0.8 / 4 ms raised calm drag by +16%, +6% and +21%, always upward: a real time-step bias, not noise. Waves keep
 * Courant 1 / 4 ms (their own interface Courant limit applies; see waves.ts).
 */
export function stepControls(calm){return calm?{timeStepS:.0005,maxDeltaTS:.002,maxCo:.4}:{timeStepS:.001,maxDeltaTS:.004,maxCo:1};}
export function numericalRequest(request,phase,fineResult,speed='full'){
  const tris=request.trianglesMm;let xmin=Infinity,xmax=-Infinity;
  for(let i=0;i<tris.length;i+=3){xmin=Math.min(xmin,tris[i]);xmax=Math.max(xmax,tris[i]);}
  const lengthM=(xmax-xmin)/1000,period=request.wavePeriodS;
  if(speed==='quick'){
    // Calm: 40 hull lengths of towing, averaged over the last 60%. 30 s Roihu runs of real competition-style hulls settled
    // only after ~8-12 s; a 16 L/U run (11.7 s) read 9-23% low by different amounts per hull. 12-30 s is within ~2-5%.
    // Waves: arrival + 8 periods (set by the case generator).
    // Courant-limited adaptive steps instead of a fixed 0.5 ms cap.
    const calm=request.mode==='calm',duration=calm?Math.max(24,40*lengthM/request.speedMps):1;
    return {...request,fidelity:'quick',durationS:duration,mesh:'coarse',...stepControls(calm),maxCells:Math.min(request.maxCells??5000000,5000000),domainScale:1};
  }
  // Full = convergence check of the Quick setup: its coarse grid and numerics are Quick's; medium refines the grid by
  // sqrt(2). Same simulated time for every phase (comparisons require it), longer than Quick:
  // calm the same 40 hull lengths as Quick (averaged over the last 60%), waves 25 periods (~12 measured after warm-up).
  const calm=request.mode==='calm';
  const duration=calm?Math.max(24,40*lengthM/request.speedMps):25*period;
  const base={...request,fidelity:'quick',durationS:duration,mesh:['medium','fine'].includes(phase)?phase:'coarse',...stepControls(calm),maxCells:Math.min(request.maxCells??5000000,5000000),domainScale:phase==='domain'?1.5:1};
  if(phase==='time-step'){
    // Halve both the Courant limit and the cap, so the solver's actual step really halves.
    base.timeStepS/=2;base.maxDeltaTS/=2;base.maxCo/=2;
  }
  return base;
}

export const MAX_QUEUED_STUDIES=100;
/**
 * Runs studies in submission order. Locally one study and one solve run at a time (slots {studies:1,runs:1}); on a
 * cluster several studies, and every solve of a study, can run at once because the solves are independent.
 * It never retries or resumes work silently.
 */
export class StudyRunner {
  constructor({runCase,cancelCase,persist=async()=>{},now=()=>new Date().toISOString(),slots=()=>({studies:1,runs:1}),resumeJob=()=>null,loadPlan=async()=>null}){
    this.resumeJob=resumeJob;this.loadPlan=loadPlan;this.runCase=runCase;this.cancelCase=cancelCase;this.persist=persist;this.now=now;this.slots=slots;this.records=new Map();this.activeIds=new Set();this.waiting=[];
  }
  /** First running study (kept for callers that show one active study). */
  get activeId(){return this.activeIds.values().next().value??null;}
  get busy(){return this.activeIds.size>=Math.max(1,this.slots().studies||1);}
  /** Study ids waiting to run, in order. */
  get queuedIds(){return this.waiting.map(w=>w.study.id);}
  start(study,plan){this.activeIds.add(study.id);this.running=Promise.resolve().then(()=>this.execute(study,plan));}
  next(){while(!this.busy&&this.waiting.length){const n=this.waiting.shift();this.start(n.study,n.plan);}}
  get(id){const record=this.records.get(id);return record?copy(record):null;}
  list(){return [...this.records.values()].map(copy);}
  async save(study){study.updatedAt=this.now();study.progress.conditionsFinished=study.conditions.filter(c=>TERMINAL.has(c.status)).length;study.progress.solvesFinished=study.conditions.flatMap(c=>c.runs).filter(r=>r.jobId&&TERMINAL.has(r.status)).length;await this.persist(copy(study));}
  async restore(record){
    if(!record||record.schema!==1||typeof record.id!=='string'||!Array.isArray(record.conditions))return;
    const study=copy(record);
    // A cluster study continues after a restart: it waits again for its submitted jobs (they kept running on the
    // cluster) and submits the checks that had not started yet, from the same stored geometry. Without that geometry
    // the unsubmitted checks are marked interrupted (re-run them); nothing finished is ever replayed.
    if(study.status==='running'&&study.options?.backend==='cluster'){
      const open=study.conditions.filter(c=>['pending','running'].includes(c.status));
      const watched=open.some(c=>c.runs.some(r=>r.jobId&&!TERMINAL.has(r.status)&&this.resumeJob(r.jobId)));
      if(watched){
        let planned=null;try{planned=await this.loadPlan(study);}catch{planned=null;}
        study.stage='Re-attached to cluster jobs after a restart';study.activeJobIds=[];study.activeJobId=null;
        this.records.set(study.id,study);this.activeIds.add(study.id);await this.save(study);
        const speed=study.options?.speed??'full';
        this.running=Promise.all(open.map(c=>{c.status='running';return this.runClusterCondition(study,c,planned?.get(c.id)??null,speed);})).then(()=>{
          if(study.status==='cancelled')return;
          const unfinished=study.conditions.some(c=>c.status==='interrupted');
          study.status=unfinished?'interrupted':'completed';study.stage=unfinished?'Some tests could not continue after a restart: re-run them':'Automatic tests finished — review numerical sensitivity and assumptions';
        }).catch(error=>{study.status='failed';study.stage='Automatic study stopped';study.error=String(error.message??error);})
          .finally(async()=>{study.activeJobId=null;study.activeJobIds=[];await this.save(study);this.activeIds.delete(study.id);this.next();});
        return;
      }
    }
    if(['queued','running'].includes(study.status)){
      study.status='interrupted';study.stage='Interrupted by service restart';study.error='The local service restarted. No study work was resumed automatically.';study.activeJobId=null;
      for(const c of study.conditions)if(['pending','running'].includes(c.status)){c.status='interrupted';c.stage='Not resumed after restart';for(const r of c.runs)if(!TERMINAL.has(r.status))r.status='interrupted';}
      await this.save(study);
    }
    this.records.set(study.id,study);
  }
  async create(plan,options){
    if(this.waiting.length>=MAX_QUEUED_STUDIES)throw new Error(`The queue already holds ${MAX_QUEUED_STUDIES} studies. Let some finish first.`);
    if(!plan||!Array.isArray(plan.conditions)||plan.conditions.length<1||plan.conditions.length>9)throw new Error('An automatic study requires 1–9 planned physical conditions.');
    const study=initialRecord(plan,{...options,now:this.now()});study.options.speed=SPEEDS[study.options.speed]?study.options.speed:'full';this.records.set(study.id,study);
    const queued=this.busy;if(queued)study.stage='Waiting in queue';
    try{await this.save(study);}catch(error){this.records.delete(study.id);throw error;}
    // Retain the execution promise for shutdown/tests while returning the reviewable plan immediately.
    if(queued)this.waiting.push({study,plan});else this.start(study,plan);
    return this.get(study.id);
  }
  async cancel(id){
    const study=this.records.get(id);if(!study)return null;
    if(!['queued','running'].includes(study.status))return this.get(id);
    const waitingIndex=this.waiting.findIndex(w=>w.study.id===id);
    if(waitingIndex>=0){
      this.waiting.splice(waitingIndex,1);study.status='cancelled';study.stage='Removed from queue';
      for(const c of study.conditions){c.status='cancelled';c.stage='Cancelled';}
      await this.save(study);return this.get(id);
    }
    study.status='cancelled';study.stage='Cancelled by user';
    for(const c of study.conditions)if(['pending','running'].includes(c.status)){c.status='cancelled';c.stage='Cancelled';}
    await this.save(study);
    for(const jobId of new Set([...(study.activeJobIds??[]),study.activeJobId].filter(Boolean)))await this.cancelCase(jobId);
    return this.get(id);
  }
  /** One solve of one condition. Returns false when the condition is blocked (no further solves make sense). */
  async runPhase(study,condition,planned,phase,speed){
    if(study.status==='cancelled')return false;
    const reference=getResult(condition.runs.find(r=>r.phase==='coarse'));
    const run={phase,status:'preparing'};condition.runs.push(run);condition.stage=`${phase}: preparing`;study.stage=`${condition.label} · ${phase}`;await this.save(study);
    try{
      const job=await this.runCase(numericalRequest(planned.request,phase,reference,speed),{
        studyId:study.id,conditionId:condition.id,phase,cores:study.options?.cores,backend:study.options?.backend,isCancelled:()=>study.status==='cancelled',
        onQueued:async id=>{run.jobId=id;run.status='running';study.activeJobId=id;(study.activeJobIds??=[]).push(id);condition.stage=`${phase}: queued`;await this.save(study);if(study.status==='cancelled')await this.cancelCase(id);},
      });
      this.applyJob(study,condition,run,job);
    }catch(error){
      if(study.status==='cancelled'){run.status='cancelled';return false;}
      run.status=error.preflight===true?'blocked':'failed';run.error=String(error.message??error);run.hint=explainFailure(run.error);if(run.hint&&!condition.hint)condition.hint=run.hint;
      if(error.preflight===true){condition.error=run.error;condition.status='blocked';condition.stage='Blocked by geometry, flotation or resource preflight';return false;}
    }finally{
      if(run.jobId&&study.activeJobIds)study.activeJobIds=study.activeJobIds.filter(id=>id!==run.jobId);
      if(study.activeJobId===run.jobId)study.activeJobId=study.activeJobIds?.at(-1)??null;
      await this.save(study);
    }
    return true;
  }
  /** Record a finished job on its run (shared by normal runs and runs re-attached after a restart). */
  applyJob(study,condition,run,job){
    run.jobId=job.id;run.status=job.status;run.result=job.result??null;run.error=job.error??null;run.hint=job.hint??(job.status==='failed'?explainFailure(job.error):null);if(run.hint&&!condition.hint)condition.hint=run.hint;
    if(job.status==='cancelled'&&study.status!=='cancelled'){study.status='cancelled';study.stage='Stopped after job cancellation';for(const c of study.conditions)if(['pending','running'].includes(c.status))c.status='cancelled';}
  }
  finishCondition(study,condition){
    condition.result=assessCondition(condition);
    if(study.status!=='cancelled'&&condition.status!=='blocked'&&condition.runs.some(r=>r.status==='interrupted')){
      condition.status='interrupted';condition.stage='Not every run could continue after a restart: re-run this test';return;
    }
    if(study.status!=='cancelled'&&condition.status!=='blocked'){
      condition.status=condition.runs.some(r=>getResult(r))?'completed':'failed';
      condition.stage=condition.result.quick?(condition.status==='completed'?'Quick run finished — rough numbers, no sensitivity checks':'Quick run failed — see the log'):condition.result.numericalSensitivityPassed?'Sensitivity checks passed; physical validation pending':'Finished with inconclusive numerical sensitivity';
    }
  }
  /**
   * Cluster: every phase of the condition at once. Phases that
   * already have a job (after a restart) are waited for instead of submitted again. planned=null: unsubmitted phases
   * cannot be prepared and are marked interrupted.
   */
  async runClusterCondition(study,condition,planned,speed){
    const phases=phasesFor(speed);
    const ensure=async phase=>{
      const existing=condition.runs.find(r=>r.phase===phase);
      if(existing&&TERMINAL.has(existing.status))return existing.status!=='blocked';
      if(existing?.jobId){
        const done=this.resumeJob(existing.jobId);
        if(!done){existing.status='interrupted';existing.error='The app restarted and this run could not be re-attached.';return true;}
        if(!(study.activeJobIds??=[]).includes(existing.jobId))study.activeJobIds.push(existing.jobId);
        const job=await done;this.applyJob(study,condition,existing,job);
        study.activeJobIds=study.activeJobIds.filter(id=>id!==existing.jobId);await this.save(study);return true;
      }
      if(existing)condition.runs.splice(condition.runs.indexOf(existing),1); // prepared but never submitted
      if(study.status==='cancelled')return false;
      if(!planned){condition.runs.push({phase,status:'interrupted',error:'Not submitted before the app restarted.'});return true;}
      return this.runPhase(study,condition,planned,phase,speed);
    };
    // Every solve starts at once: they are independent, and the comparisons are made when all have finished. This saves
    // a whole coarse run of waiting. A geometry/load preflight failure blocks all of them the same way.
    await Promise.all(phases.map(ensure));
    this.finishCondition(study,condition);await this.save(study);
  }
  async execute(study,plan){
    try{
      if(study.status==='cancelled')return;
      study.status='running';await this.save(study);
      const speed=study.options?.speed??'full',parallel=Math.max(1,this.slots().runs||1);
      if(parallel>1){
        // Cluster: the coarse run of every condition first (it also preflights the condition), then all other phases.
        const conditions=plan.conditions.map((planned,index)=>({planned,condition:study.conditions[index]}));
        for(const {condition} of conditions){condition.status='running';condition.stage='Submitting';}
        await this.save(study);
        await Promise.all(conditions.map(({planned,condition})=>this.runClusterCondition(study,condition,planned,speed)));
      }else{
        for(let index=0;index<plan.conditions.length;index++){
          if(study.status==='cancelled')break;
          const condition=study.conditions[index],planned=plan.conditions[index];
          condition.status='running';condition.stage='Preparing coarse mesh';study.stage=`${condition.label} · coarse`;await this.save(study);
          for(const phase of phasesFor(speed)){
            if(study.status==='cancelled')break;
            if(['time-step','domain'].includes(phase)&&!getResult(condition.runs.find(r=>r.phase==='coarse'))){condition.runs.push({phase,status:'skipped',error:'No genuine coarse reference run is available.'});continue;}
            if(!(await this.runPhase(study,condition,planned,phase,speed)))break;
          }
          this.finishCondition(study,condition);
          await this.save(study);
        }
      }
      if(study.status!=='cancelled'){study.status='completed';study.stage='Automatic tests finished — review numerical sensitivity and assumptions';}
    }catch(error){study.status='failed';study.stage='Automatic study stopped';study.error=String(error.message??error);}
    finally{study.activeJobId=null;study.activeJobIds=[];await this.save(study);this.activeIds.delete(study.id);this.next();}
  }
}
