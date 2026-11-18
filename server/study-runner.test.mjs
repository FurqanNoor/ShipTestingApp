import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StudyRunner,assessCondition} from './study-runner.mjs';
import {timeWeightedRms} from './result-reader.mjs';

// Run order: time-step and domain checks are made on the coarse grid, before the expensive medium and fine runs.
const phases=['coarse','time-step','domain','medium','fine'];
function solverResult(phase,{mode='calm',value,cellCount,actualDt}={}){
  const index=phases.indexOf(phase),responses=[1,.995,.99,.985,.984];
  return {source:'OpenFOAM',geometryHash:'actual-synthetic-fixture-geometry-hash',protocolHash:phase==='domain'?'domain-variant-protocol-hash':'matching-reference-protocol-hash',
    manifest:{condition:{kind:mode,heightM:mode==='calm'?undefined:.007,periodS:mode==='calm'?undefined:.45},speedMps:mode==='calm'?.3:0,
      load:{massKg:.25,cgM:[.1,0,.015],cgSource:'cad-estimate',cgMeasured:false},physics:{densityWaterKgM3:998},
      domain:{scale:phase==='domain'?1.5:1},numerics:{durationS:40,initialDeltaTS:phase==='time-step'?.00025:.0005,maxDeltaTS:phase==='time-step'?.00025:.0005},
      ...(mode==='beam-waves'?{motion:{inertiaKgM2:[.0001,.0002,.00025],inertiaSource:'cad-estimate'}}:{})},
    solverRun:{actualMeshCells:cellCount??[1000,1000,1500,2000,4000][index],actualDeltaTS:{maximum:actualDt??(phase==='time-step'?.00025:.0005)}},
    forces:{meanDragN:mode==='calm'?(value??responses[index]):0},
    ...(mode==='beam-waves'?{motion:{rollRmsDeg:value??responses[index],heaveRmsM:.001,maxAbsRollDeg:1.5,rollRmsDriftWithinTolerance:true}}:{}),
    hydro:{buoyancyN:2.45,gmM:.01,freeboardM:.02},
    quality:{meshOkay:true,detailedMeshOkay:true,completedTime:true,alphaBounded:true,residualsFinite:true,forceCoverageComplete:true,timeStepsValid:true,forceHistoryDrift:mode==='calm'?true:null,waveDurationSufficient:mode==='calm'?null:true},
  };
}
function condition(mode='calm'){
  return {id:'condition-1',label:'250 g calm',massKg:.25,mode,runs:phases.map(phase=>({phase,jobId:'job-'+phase,status:'completed',result:solverResult(phase,{mode})}))};
}
function plan(count=2){return {schema:1,protocol:'standard-220-v1',name:'Automatic fixture',geometryMode:'closed-envelope',distribution:'shell',geometryNotes:[],assumptions:['Synthetic prescribed mass, not a physical measurement.'],defaults:{loadsKg:[.15,.25,.35],maxCells:5000000},conditions:Array.from({length:count},(_,i)=>({id:'condition-'+i,label:`Condition ${i}`,massKg:.25,mode:'calm',request:{trianglesMm:[0,0,0,200,0,0,0,30,40],massKg:.25,speedMps:.3,mode:'calm',maxCells:5000000}}))};}
function successfulCase(calls){return async(request,context)=>{calls.push({request,context});const id='job-'+calls.length;await context.onQueued(id);return {id,status:'completed',result:solverResult(context.phase)};};}

test('complete genuine-output fixtures can pass declared sensitivity diagnostics without granting physical validation',()=>{
  const r=assessCondition(condition());assert.equal(r.numericalSensitivityPassed,true);assert.equal(r.rankable,false);assert.equal(r.physicalValidation,'not-performed');assert.equal(r.metrics.referenceMesh,'fine');
});
test('identical actual cell counts cannot masquerade as three refined meshes',()=>{
  const c=condition();c.runs[3].result.solverRun.actualMeshCells=1000;const r=assessCondition(c);assert.equal(r.numericalSensitivityPassed,false);assert.equal(r.checks.find(c=>c.name==='Three distinct meshes').passed,false);
});
test('mesh comparisons require recorded matching physical protocol hashes',()=>{
  const c=condition();delete c.runs[3].result.protocolHash;assert.equal(assessCondition(c).numericalSensitivityPassed,false);
  c.runs[3].result.protocolHash='different-load-or-pose';assert.equal(assessCondition(c).checks.find(c=>c.name==='Three distinct meshes').passed,false);
});
test('an inactive halved timestep cap does not pass actual timestep sensitivity',()=>{
  const c=condition();c.runs[1].result.solverRun.actualDeltaTS.maximum=.0005;const r=assessCondition(c);assert.equal(r.checks.find(c=>c.name==='Actual time-step reduction').passed,false);assert.equal(r.numericalSensitivityPassed,false);
});
test('wave comparisons use RMS roll rather than a near-zero mean longitudinal force',()=>{
  const r=assessCondition(condition('beam-waves'));assert.equal(r.numericalSensitivityPassed,true);assert.equal(r.metrics.meanDragN,0);assert.equal(r.metrics.rollRmsDeg,.984);
});
test('unsettled wave response, failed detailed meshes and missing genuine channels remain inconclusive',()=>{
  for(const mutate of [r=>{r.motion.rollRmsDriftWithinTolerance=false;},r=>{r.quality.detailedMeshOkay=false;},r=>{r.source='empirical-preview';}]){
    const c=condition('beam-waves');mutate(c.runs[4].result);assert.equal(assessCondition(c).numericalSensitivityPassed,false);
  }
});
test('changed physical observations and failed domain enlargement cannot pass comparison',()=>{
  const c=condition();c.runs[2].result.manifest.numerics.durationS=50;assert.equal(assessCondition(c).checks.find(c=>c.name==='Domain sensitivity').passed,null);
  c.runs[2].result.manifest.numerics.durationS=40;c.runs[2].result.manifest.domain.scale=1;assert.equal(assessCondition(c).numericalSensitivityPassed,false);
});
test('a blocked fine mesh retains only the available genuine earlier result',()=>{
  const c=condition();c.runs=c.runs.filter(r=>['coarse','medium'].includes(r.phase)).concat({phase:'fine',status:'blocked',error:'Mesh budget exceeded'});const r=assessCondition(c);assert.equal(r.metrics.referenceMesh,'medium');assert.equal(r.numericalSensitivityPassed,false);assert.equal(r.rankable,false);
});
test('runner schedules exactly five distinct numerical cases per condition with bounded common protocol',async()=>{
  const calls=[],snapshots=[],runner=new StudyRunner({runCase:successfulCase(calls),cancelCase:async()=>{},persist:async s=>snapshots.push(s)});
  const created=await runner.create(plan(),{id:'study-fixture'});await runner.running;const r=runner.get(created.id);
  assert.equal(calls.length,10);assert.deepEqual(calls.slice(0,5).map(c=>c.context.phase),phases);assert.equal(r.progress.solvesFinished,10);assert.equal(r.progress.conditionsFinished,2);assert.equal(r.status,'completed');
  assert.equal(new Set(calls.slice(0,5).map(c=>c.request.durationS)).size,1);assert.equal(calls[1].request.maxDeltaTS,.002);assert.equal(calls[1].request.maxCo,.4);assert.equal(calls[2].request.domainScale,1.5);assert.ok(calls.every(c=>c.request.maxCells<=5000000));
  assert.equal(JSON.stringify(snapshots).includes('trianglesMm'),false);
});
test('a condition blocked by preflight does not prevent other conditions from running',async()=>{
  const calls=[],run=successfulCase(calls),runner=new StudyRunner({runCase:async(req,ctx)=>{if(ctx.conditionId==='condition-0')throw Object.assign(new Error('Overloaded hull'),{preflight:true});return run(req,ctx);},cancelCase:async()=>{}});
  await runner.create(plan(),{id:'blocked-study'});await runner.running;const r=runner.get('blocked-study');assert.equal(r.conditions[0].status,'blocked');assert.equal(r.conditions[1].status,'completed');assert.equal(calls.length,5);assert.equal(r.progress.conditionsFinished,2);
});
test('cancelling a study cancels its owned active job and schedules no follow-ups',async()=>{
  let started,finish;const didStart=new Promise(r=>{started=r;}),jobDone=new Promise(r=>{finish=r;}),cancelled=[],calls=[];
  const runner=new StudyRunner({runCase:async(req,ctx)=>{calls.push(ctx);await ctx.onQueued('owned-job');started();return jobDone;},cancelCase:async id=>cancelled.push(id)});
  await runner.create(plan(),{id:'cancel-study'});await didStart;await runner.cancel('cancel-study');finish({id:'owned-job',status:'cancelled'});await runner.running;
  assert.deepEqual(cancelled,['owned-job']);assert.equal(calls.length,1);assert.equal(runner.get('cancel-study').status,'cancelled');assert.equal(runner.busy,false);
});
test('a second study waits in the queue and starts only after the first finishes',async()=>{
  let finish;const pending=new Promise(r=>{finish=r;}),seen=[];
  const runner=new StudyRunner({runCase:async(request,context)=>{seen.push(context.studyId);if(context.studyId==='first')return pending;await context.onQueued('job-'+seen.length);return {id:'job-'+seen.length,status:'completed',result:null};},cancelCase:async()=>{}});
  await runner.create(plan(1),{id:'first'});const second=await runner.create(plan(1),{id:'second'});
  assert.equal(second.status,'queued');assert.equal(second.stage,'Waiting in queue');assert.deepEqual(runner.queuedIds,['second']);
  await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['first']);
  finish({id:'first-job',status:'completed',result:null});
  for(let i=0;i<50&&runner.get('second').status!=='completed';i++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual([...new Set(seen)],['first','second']);assert.ok(seen.lastIndexOf('first')<seen.indexOf('second'));assert.equal(runner.get('second').status,'completed');assert.equal(runner.busy,false);
});
test('a queued study can be removed without running anything',async()=>{
  let finish;const pending=new Promise(r=>{finish=r;}),seen=[];
  const runner=new StudyRunner({runCase:async(request,context)=>{seen.push(context.studyId);return pending;},cancelCase:async()=>{}});
  await runner.create(plan(1),{id:'first'});await runner.create(plan(1),{id:'second'});
  const removed=await runner.cancel('second');assert.equal(removed.status,'cancelled');assert.equal(removed.stage,'Removed from queue');assert.deepEqual(runner.queuedIds,[]);
  await runner.cancel('first');finish({id:'first-job',status:'cancelled'});await runner.running;
  await new Promise(r=>setTimeout(r,10));assert.deepEqual(seen,['first']);
});
test('restart restores completed outputs and marks unfinished work interrupted without replay',async()=>{
  const calls=[],runner=new StudyRunner({runCase:successfulCase(calls),cancelCase:async()=>{}});
  const record={schema:1,id:'restore-study',status:'running',conditions:[{id:'one',status:'running',runs:[{phase:'coarse',jobId:'old-job',status:'meshing'}]}],progress:{conditionsTotal:1,conditionsFinished:0,solvesFinished:0,solvesMaximum:5},activeJobId:'old-job'};
  await runner.restore(record);assert.equal(runner.get(record.id).status,'interrupted');assert.equal(runner.get(record.id).conditions[0].runs[0].status,'interrupted');assert.equal(calls.length,0);assert.equal(runner.busy,false);
});
test('time-weighted motion RMS integrates linear samples exactly and is insensitive to sampling density',()=>{
  const sparse=[{timeS:0,x:0},{timeS:1,x:1}],dense=Array.from({length:101},(_,i)=>({timeS:i/100,x:i/100}));
  assert.ok(Math.abs(timeWeightedRms(sparse,'x')-Math.sqrt(1/3))<1e-14);assert.ok(Math.abs(timeWeightedRms(dense,'x')-timeWeightedRms(sparse,'x'))<1e-14);
  assert.ok(Math.abs(timeWeightedRms(sparse,'x',.5,1)-Math.sqrt(7/12))<1e-14);assert.equal(timeWeightedRms([], 'x'),null);
});

test('quick studies run one coarse solve per selected condition with quick fidelity',async()=>{
  const {numericalRequest,phasesFor}=await import('./study-runner.mjs');
  assert.deepEqual(phasesFor('quick'),['coarse']);assert.equal(phasesFor('anything').length,5);
  const calls=[],runner=new StudyRunner({runCase:successfulCase(calls),cancelCase:async()=>{}});
  const study=await runner.create(plan(2),{id:'quick-study',speed:'quick',cores:3});await runner.running;
  const done=runner.get(study.id);
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.context.phase==='coarse'&&c.context.cores===3&&c.request.fidelity==='quick'));
  assert.equal(done.progress.solvesMaximum,2);assert.deepEqual(done.options,{speed:'quick',cores:3});
  for(const c of done.conditions){assert.equal(c.status,'completed');assert.equal(c.result.quick,true);assert.equal(c.result.numericalSensitivityPassed,null);assert.equal(c.result.rankable,false);assert.equal(c.result.metrics.referenceMesh,'coarse');}
  const tris=[0,0,0,200,0,0,0,10,0];
  const q=numericalRequest({mode:'calm',speedMps:.3,trianglesMm:tris},'coarse',null,'quick');
  assert.equal(q.fidelity,'quick');assert.equal(q.maxCo,.8);assert.ok(Math.abs(q.durationS-16*.2/.3)<1e-9);
  const full=numericalRequest({mode:'calm',speedMps:.3,trianglesMm:tris},'coarse',null);
  // Full's coarse grid and numerics are Quick's, over a longer window (16 hull lengths, the same as Quick: the drag is stationary after start-up).
  assert.equal(full.fidelity,'quick');assert.equal(full.maxDeltaTS,.004);assert.equal(full.maxCo,.8);assert.ok(Math.abs(full.durationS-16*.2/.3)<1e-9);
  const wave=numericalRequest({mode:'beam-waves',speedMps:0,wavePeriodS:.45,trianglesMm:tris},'fine',null);assert.equal(wave.mesh,'fine');assert.ok(Math.abs(wave.durationS-25*.45)<1e-9);assert.equal(wave.maxCo,1);
});
test('full remains the default speed and keeps all five phases',async()=>{
  const calls=[],runner=new StudyRunner({runCase:successfulCase(calls),cancelCase:async()=>{}});
  await runner.create(plan(1),{id:'full-study'});await runner.running;
  assert.equal(calls.length,5);assert.equal(runner.get('full-study').options.speed,'full');
});

test('after a restart, a Quick cluster study re-attaches to its running jobs and finishes',async()=>{
  const saved=[];let release;
  const runner=new StudyRunner({runCase:async()=>{throw new Error('nothing may be resubmitted');},cancelCase:async()=>{},persist:async s=>{saved.push(s);},
    resumeJob:id=>id==='job-running'?new Promise(r=>{release=r;}):null});
  const cond=(id,status,runs)=>({id,label:id,mode:'calm',status,stage:'',speed:'quick',runs});
  await runner.restore({schema:1,id:'s1',name:'Hull',status:'running',options:{speed:'quick',backend:'cluster',cores:64},progress:{conditionsTotal:3,conditionsFinished:1,solvesFinished:1,solvesMaximum:3},
    conditions:[cond('done','completed',[{phase:'coarse',status:'completed',jobId:'job-done',result:solverResult('coarse')}]),
      cond('running','running',[{phase:'coarse',status:'running',jobId:'job-running'}]),
      cond('unsent','running',[{phase:'coarse',status:'preparing'}])]});
  let s=runner.get('s1');
  assert.equal(s.status,'running');assert.deepEqual(s.activeJobIds,['job-running']);assert.ok(runner.activeIds.has('s1'));
  assert.equal(s.conditions[2].status,'interrupted');
  release({id:'job-running',status:'completed',result:solverResult('coarse'),error:null});
  await runner.running;
  s=runner.get('s1');
  assert.equal(s.conditions[1].status,'completed');assert.equal(s.conditions[1].result.quick,true);
  assert.equal(s.status,'interrupted','an unsent test leaves the study re-runnable');assert.ok(!runner.activeIds.has('s1'));
});
test('a restored local or Full study is still marked interrupted, never resumed',async()=>{
  const runner=new StudyRunner({runCase:async()=>{},cancelCase:async()=>{},resumeJob:()=>Promise.resolve({})});
  await runner.restore({schema:1,id:'s2',name:'Hull',status:'running',options:{speed:'full',backend:'cluster',cores:64},progress:{},conditions:[{id:'a',status:'running',runs:[{phase:'coarse',status:'running',jobId:'j'}]}]});
  assert.equal(runner.get('s2').status,'interrupted');
});
