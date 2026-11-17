/** Bounded unattended CFD studies. Passing sensitivity checks is not physical validation. */
import {explainFailure} from './failure-hints.mjs';
const PHASES=['coarse','medium','fine','time-step','domain'];
/** quick: one fast screening solve per condition. full: mesh/time-step/domain sensitivity (5 solves). */
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
  const coarse=getResult(byPhase.get('coarse')),medium=getResult(byPhase.get('medium')),fine=getResult(byPhase.get('fine'));
  const half=getResult(byPhase.get('time-step')),domain=getResult(byPhase.get('domain'));
  const checks=[];
  const phases=phasesFor(condition.speed);
  checks.push(check('Completed numerical quality',phases.every(p=>safeQuality(getResult(byPhase.get(p)),condition.mode)),
    condition.mode==='beam-waves'?'All five runs need complete, bounded solver histories, both mesh reviews and stationary post-startup RMS roll.':'All five runs need complete, bounded solver histories, both mesh reviews and stationary post-startup forces.'));
  const meshComparable=comparable(coarse,medium)&&comparable(medium,fine);
  const distinct=meshComparable&&cells(coarse)<cells(medium)&&cells(medium)<cells(fine);
  checks.push(check('Three distinct meshes',!!distinct,'Actual cell counts must strictly increase on three otherwise matching physical cases.'));
  const previous=meshComparable?difference(coarse,medium,condition.mode):null,meshChange=meshComparable?difference(medium,fine,condition.mode):null;
  checks.push(check('Mesh sensitivity',distinct&&meshChange!==null&&previous!==null?meshChange<=.02&&meshChange<=previous:null,
    condition.mode==='beam-waves'?'Finest-pair RMS roll change must be at most 2% and no larger than the preceding change; tiny responses are inconclusive.':'Finest-pair drag change must be at most 2% and no larger than the preceding change; near-zero drag is inconclusive.',{relativeChange:meshChange,threshold:.02,precedingRelativeChange:previous}));
  const actualFineDt=fine?.solverRun?.actualDeltaTS?.maximum,actualHalfDt=half?.solverRun?.actualDeltaTS?.maximum;
  const dtComparable=comparable(fine,half)&&cells(fine)===cells(half);
  const dtReduced=dtComparable&&finite(actualFineDt)&&actualFineDt>0&&finite(actualHalfDt)&&actualHalfDt>0&&actualHalfDt<=actualFineDt*.6;
  checks.push(check('Actual time-step reduction',!!dtReduced,'The largest recorded solver time step must decrease by at least 40%; changing an inactive cap alone is inconclusive.'));
  const dtChange=dtComparable?difference(fine,half,condition.mode):null;
  checks.push(check('Time-step sensitivity',dtReduced&&dtChange!==null?dtChange<=.02:null,'Reference and half-step response must differ by at most 2%.',{relativeChange:dtChange,threshold:.02}));
  const domainComparable=comparable(fine,domain,true),scale=fine?.manifest?.domain?.scale,larger=domain?.manifest?.domain?.scale;
  const expanded=domainComparable&&finite(scale)&&finite(larger)&&larger>=scale*1.49;
  const domainChange=domainComparable?difference(fine,domain,condition.mode):null;
  checks.push(check('Domain sensitivity',expanded&&domainChange!==null?domainChange<=.02:null,'A domain enlarged by 50% must change response by at most 2%, using the same observation duration.',{relativeChange:domainChange,threshold:.02}));
  const reference=fine??medium??coarse,referenceRun=reference?[...byPhase.values()].find(r=>r.result===reference):null;
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
    scope:'Declared mesh/time/domain sensitivity diagnostics only. Uniform CAD mass assumptions, wave propagation/reflection, flow-model uncertainty and physical accuracy remain unvalidated.'};
}

function initialRecord(plan,{id,name,now,speed='full',cores=1}){
  const phases=phasesFor(speed);
  const {conditions,...summary}=plan;
  return {schema:1,id,name:name??plan.name??'Automatic hull study',status:'queued',stage:'Preparing automatic tests',createdAt:now,updatedAt:now,
    plan:copy(summary),options:{speed,cores},conditions:conditions.map(({request,...c})=>({...copy(c),speed,status:'pending',stage:'Waiting',runs:[]})),
    progress:{conditionsTotal:conditions.length,conditionsFinished:0,solvesFinished:0,solvesMaximum:conditions.length*phases.length},activeJobId:null,error:null,
    physicalValidation:'not-performed',rankable:false};
}
export function numericalRequest(request,phase,fineResult,speed='full'){
  const tris=request.trianglesMm;let xmin=Infinity,xmax=-Infinity;
  for(let i=0;i<tris.length;i+=3){xmin=Math.min(xmin,tris[i]);xmax=Math.max(xmax,tris[i]);}
  const lengthM=(xmax-xmin)/1000,period=request.wavePeriodS;
  if(speed==='quick'){
    // ~6 hull lengths of towing (calm) or wave arrival + 8 periods (waves, set by the case generator).
    // Courant-limited adaptive steps instead of a fixed 0.5 ms cap.
    const calm=request.mode==='calm',duration=calm?Math.max(3,6*lengthM/request.speedMps):1;
    return {...request,fidelity:'quick',durationS:duration,mesh:'coarse',timeStepS:.001,maxDeltaTS:.004,maxCo:calm?.8:1,maxCells:Math.min(request.maxCells??5000000,5000000),domainScale:1};
  }
  const duration=Math.max(request.durationS??0,request.mode==='calm'?Math.max(12,30*lengthM/request.speedMps):Math.max(30,80*period));
  const base={...request,durationS:duration,mesh:['coarse','medium'].includes(phase)?phase:'fine',timeStepS:.0005,maxDeltaTS:.0005,maxCells:Math.min(request.maxCells??5000000,5000000),domainScale:phase==='domain'?1.5:1};
  if(phase==='time-step'){
    base.timeStepS=(fineResult?.manifest?.numerics?.initialDeltaTS??.0005)/2;
    base.maxDeltaTS=(fineResult?.manifest?.numerics?.maxDeltaTS??.0005)/2;
  }
  return base;
}

export const MAX_QUEUED_STUDIES=100;
/**
 * The injected runner executes one study at a time, in submission order. Further studies wait in a queue
 * (e.g. one per competition entry). It never retries or resumes work silently.
 */
export class StudyRunner {
  constructor({runCase,cancelCase,persist=async()=>{},now=()=>new Date().toISOString()}){
    this.runCase=runCase;this.cancelCase=cancelCase;this.persist=persist;this.now=now;this.records=new Map();this.activeId=null;this.waiting=[];
  }
  get busy(){return this.activeId!==null;}
  /** Study ids waiting to run, in order. */
  get queuedIds(){return this.waiting.map(w=>w.study.id);}
  start(study,plan){this.activeId=study.id;this.running=Promise.resolve().then(()=>this.execute(study,plan));}
  next(){const n=this.waiting.shift();if(n)this.start(n.study,n.plan);}
  get(id){const record=this.records.get(id);return record?copy(record):null;}
  list(){return [...this.records.values()].map(copy);}
  async save(study){study.updatedAt=this.now();study.progress.conditionsFinished=study.conditions.filter(c=>TERMINAL.has(c.status)).length;study.progress.solvesFinished=study.conditions.flatMap(c=>c.runs).filter(r=>r.jobId&&TERMINAL.has(r.status)).length;await this.persist(copy(study));}
  async restore(record){
    if(!record||record.schema!==1||typeof record.id!=='string'||!Array.isArray(record.conditions))return;
    const study=copy(record);
    if(['queued','running'].includes(study.status)){
      study.status='interrupted';study.stage='Interrupted by service restart';study.error='The local service restarted. No study work was resumed automatically.';study.activeJobId=null;
      for(const c of study.conditions)if(['pending','running'].includes(c.status)){c.status='interrupted';c.stage='Not resumed after restart';for(const r of c.runs)if(!TERMINAL.has(r.status))r.status='interrupted';}
      await this.save(study);
    }
    this.records.set(study.id,study);
  }
  async create(plan,options){
    if(this.waiting.length>=MAX_QUEUED_STUDIES)throw new Error(`The queue already holds ${MAX_QUEUED_STUDIES} studies. Let some finish first.`);
    if(!plan||!Array.isArray(plan.conditions)||plan.conditions.length<1||plan.conditions.length>12)throw new Error('An automatic study requires 1–12 planned physical conditions.');
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
    if(study.activeJobId)await this.cancelCase(study.activeJobId);
    return this.get(id);
  }
  async execute(study,plan){
    try{
      if(study.status==='cancelled')return;
      study.status='running';await this.save(study);
      for(let index=0;index<plan.conditions.length;index++){
        if(study.status==='cancelled')break;
        const condition=study.conditions[index],planned=plan.conditions[index];
        condition.status='running';condition.stage='Preparing coarse mesh';study.stage=`${condition.label} · coarse`;await this.save(study);
        const speed=study.options?.speed??'full';
        for(const phase of phasesFor(speed)){
          if(study.status==='cancelled')break;
          const fine=getResult(condition.runs.find(r=>r.phase==='fine'));
          if(['time-step','domain'].includes(phase)&&!fine){condition.runs.push({phase,status:'skipped',error:'No genuine fine reference run is available.'});continue;}
          const run={phase,status:'preparing'};condition.runs.push(run);condition.stage=`${phase}: preparing`;study.stage=`${condition.label} · ${phase}`;await this.save(study);
          try{
            const job=await this.runCase(numericalRequest(planned.request,phase,fine,speed),{
              studyId:study.id,conditionId:condition.id,phase,cores:study.options?.cores,isCancelled:()=>study.status==='cancelled',
              onQueued:async id=>{run.jobId=id;run.status='running';study.activeJobId=id;condition.stage=`${phase}: queued`;await this.save(study);if(study.status==='cancelled')await this.cancelCase(id);},
            });
            run.jobId=job.id;run.status=job.status;run.result=job.result??null;run.error=job.error??null;run.hint=job.hint??(job.status==='failed'?explainFailure(job.error):null);if(run.hint&&!condition.hint)condition.hint=run.hint;
            if(job.status==='cancelled'&&study.status!=='cancelled'){study.status='cancelled';study.stage='Stopped after job cancellation';for(const c of study.conditions)if(['pending','running'].includes(c.status))c.status='cancelled';}
          }catch(error){
            if(study.status==='cancelled'){run.status='cancelled';break;}
            run.status=error.preflight===true?'blocked':'failed';run.error=String(error.message??error);run.hint=explainFailure(run.error);if(run.hint&&!condition.hint)condition.hint=run.hint;
            if(error.preflight===true){condition.error=run.error;condition.status='blocked';condition.stage='Blocked by geometry, flotation or resource preflight';break;}
          }finally{study.activeJobId=null;await this.save(study);}
        }
        condition.result=assessCondition(condition);
        if(study.status!=='cancelled'&&condition.status!=='blocked'){
          condition.status=condition.runs.some(r=>getResult(r))?'completed':'failed';
          condition.stage=condition.result.quick?(condition.status==='completed'?'Quick run finished — rough numbers, no sensitivity checks':'Quick run failed — see the log'):condition.result.numericalSensitivityPassed?'Sensitivity checks passed; physical validation pending':'Finished with inconclusive numerical sensitivity';
        }
        await this.save(study);
      }
      if(study.status!=='cancelled'){study.status='completed';study.stage='Automatic tests finished — review numerical sensitivity and assumptions';}
    }catch(error){study.status='failed';study.stage='Automatic study stopped';study.error=String(error.message??error);}
    finally{study.activeJobId=null;await this.save(study);if(this.activeId===study.id){this.activeId=null;this.next();}}
  }
}
