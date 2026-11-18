import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normaliseClusterConfig,clusterProblems,batchScript,sifPath,parseCertValidity,certificateStatus} from './cluster.mjs';
import {StudyRunner} from './study-runner.mjs';

const good={enabled:true,host:'roihu.csc.fi',user:'student1',account:'project_2001234',partition:'small',cores:32,hours:12,remoteDir:'/scratch/project_2001234/hulltests'};

test('cluster settings are validated so nothing unsafe reaches a remote shell',()=>{
  assert.deepEqual(clusterProblems(normaliseClusterConfig(good)),[]);
  assert.ok(clusterProblems(normaliseClusterConfig({...good,remoteDir:"/scratch/x'; rm -rf ~"})).some(p=>/remoteDir/.test(p)));
  assert.ok(clusterProblems(normaliseClusterConfig({...good,account:'proj $(id)'})).some(p=>/account/.test(p)));
  assert.ok(clusterProblems(normaliseClusterConfig({...good,remoteDir:'/scratch/../home'})).length>0);
  assert.ok(clusterProblems(normaliseClusterConfig({...good,user:''})).some(p=>/user/.test(p)));
  const c=normaliseClusterConfig({...good,cores:'9999',hours:-3,unknown:'x'});
  assert.equal(c.cores,32);assert.equal(c.hours,24);assert.equal('unknown' in c,false);
});

test('batch script runs the pinned image on one node with all cores and a clean environment',()=>{
  const c=normaliseClusterConfig({...good,memoryGb:16});const s=batchScript(c,{name:'hull-abc'});
  for(const line of ['#SBATCH --account=project_2001234','#SBATCH --partition=small','#SBATCH --nodes=1','#SBATCH --cpus-per-task=32','#SBATCH --mem=16G','#SBATCH --time=12:00:00','#SBATCH --output=service-runner.log'])assert.ok(s.includes(line),line);
  assert.ok(s.includes(`apptainer exec --cleanenv --env HULL_NPROCS=32 --bind "$PWD:/case" --pwd /case '${sifPath(c)}' bash Allrun.sh`));
  assert.ok(s.includes('echo "HULL_EXIT $code"'));
  assert.equal(batchScript(normaliseClusterConfig(good),{name:'x'}).includes('--mem='),false);
});

function plan(count){return {schema:1,protocol:'standard-220-v1',name:'p',geometryMode:'closed-envelope',distribution:'shell',geometryNotes:[],assumptions:[],defaults:{loadsKg:[.15,.25,.35],maxCells:5000000},conditions:Array.from({length:count},(_,i)=>({id:'c'+i,label:'C'+i,massKg:.25,mode:'calm',request:{trianglesMm:[0,0,0,200,0,0,0,30,40],massKg:.25,speedMps:.3,mode:'calm',maxCells:5000000}}))};}

test('on a cluster every solve of every condition starts at once',async()=>{
  let running=0,peak=0;const order=[];
  const runner=new StudyRunner({slots:()=>({studies:5,runs:64}),cancelCase:async()=>{},runCase:async(req,ctx)=>{
    running++;peak=Math.max(peak,running);order.push(`${ctx.conditionId}:${ctx.phase}`);await ctx.onQueued('job-'+order.length);
    await new Promise(r=>setTimeout(r,20));running--;return {id:'job-'+order.length,status:'completed',result:{source:'OpenFOAM'}};}});
  await runner.create(plan(3),{id:'cluster-study',speed:'full',backend:'cluster'});await runner.running;
  const r=runner.get('cluster-study');
  assert.equal(order.length,9);assert.equal(r.status,'completed');assert.equal(r.options.backend,'cluster');
  assert.equal(peak,9,`peak concurrency ${peak}`);
});

test('several studies run side by side when the cluster has slots, and queue beyond them',async()=>{
  const releases=[];const runner=new StudyRunner({slots:()=>({studies:2,runs:64}),cancelCase:async()=>{},
    runCase:async(req,ctx)=>{await ctx.onQueued('j');await new Promise(r=>releases.push(r));return {id:'j',status:'completed',result:null};}});
  await runner.create(plan(1),{id:'a',speed:'quick'});await runner.create(plan(1),{id:'b',speed:'quick'});const third=await runner.create(plan(1),{id:'c',speed:'quick'});
  assert.equal(third.status,'queued');assert.deepEqual([...runner.activeIds].sort(),['a','b']);assert.deepEqual(runner.queuedIds,['c']);
  for(let i=0;i<20&&!(releases.length===2);i++)await new Promise(r=>setTimeout(r,5));
  releases.shift()();for(let i=0;i<50&&!runner.activeIds.has('c');i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(runner.activeIds.has('c'));
  while(releases.length)releases.shift()();for(let i=0;i<50&&runner.activeIds.size;i++){await new Promise(r=>setTimeout(r,5));while(releases.length)releases.shift()();}
});

test('Roihu daily SSH certificate validity is read and a missing certificate is explained',async()=>{
  const v=parseCertValidity('        Type: ssh-ed25519-cert-v01@openssh.com user certificate\n        Valid: from 2026-11-17T10:00:00 to 2026-11-18T10:00:00\n');
  assert.equal(v.from,'2026-11-17T10:00:00');assert.equal(Date.parse(v.to),new Date('2026-11-18T10:00:00').getTime());
  assert.equal(parseCertValidity('Valid: forever').to,null);
  assert.equal(parseCertValidity('garbage'),null);
  const s=await certificateStatus(normaliseClusterConfig({...good,host:'roihu-cpu.csc.fi',sshKey:'/nonexistent/key'}));
  assert.equal(s.required,true);assert.equal(s.exists,false);assert.equal(s.valid,false);assert.match(s.message,/Sign and download SSH certificate/);
  const other=await certificateStatus(normaliseClusterConfig({...good,host:'cluster.example.org',sshKey:'/nonexistent/key'}));
  assert.equal(other.required,false);
});

test('on a cluster, a failed coarse run leaves the condition with the medium result and an inconclusive time-step check',async()=>{
  const runner=new StudyRunner({slots:()=>({studies:5,runs:64}),cancelCase:async()=>{},runCase:async(req,ctx)=>{
    await ctx.onQueued('job-'+ctx.phase);
    return ctx.phase==='coarse'?{id:'job-c',status:'failed',error:'Floating point exception',result:null}:{id:'job-'+ctx.phase,status:'completed',result:{source:'OpenFOAM'}};}});
  await runner.create(plan(1),{id:'s',speed:'full',backend:'cluster'});await runner.running;
  const c=runner.get('s').conditions[0];
  assert.deepEqual(c.runs.map(r=>r.phase).sort(),['coarse','medium','time-step']);
  assert.equal(c.result.numericalSensitivityPassed,false);
});

test('only a run folder under <remoteDir>/runs/<uuid> may be removed from the cluster',async()=>{
  const {isRunDir}=await import('./cluster.mjs');
  const c={remoteDir:'/scratch/p/fnoor/hulltests'};
  assert.equal(isRunDir(c,'/scratch/p/fnoor/hulltests/runs/3512ce5b-c759-4e3c-9500-36369059c229'),true);
  for(const bad of ['/scratch/p/fnoor/hulltests','/scratch/p/fnoor/hulltests/runs','/scratch/p/fnoor/hulltests/runs/..','/scratch/p/fnoor/hulltests/runs/x/../../..','/scratch/p/fnoor/hulltests/openfoam-v2312.sif','/scratch/p/fnoor/hulltests/runs/3512ce5b-c759-4e3c-9500-36369059c229/..',"/scratch/p/fnoor/hulltests/runs/3512ce5b-c759-4e3c-9500-36369059c22' ; rm -rf ~"])assert.equal(isRunDir(c,bad),false,bad);
  assert.equal(isRunDir({remoteDir:''},'/runs/3512ce5b-c759-4e3c-9500-36369059c229'),false);
});

test('Slurm time limits follow the predicted run time instead of a flat 24 h',async()=>{
  const {timeLimitMinutes,batchScript}=await import('./cluster.mjs');
  const c={hours:24,cores:64,account:'a',partition:'small',remoteDir:'/r'};
  assert.equal(timeLimitMinutes(c,3600),210);assert.equal(timeLimitMinutes(c,300),60);assert.equal(timeLimitMinutes(c,40*3600),1440);assert.equal(timeLimitMinutes(c,null),1440);
  assert.match(batchScript(c,{name:'hull-x',minutes:210}),/#SBATCH --time=03:30:00/);
  assert.match(batchScript(c,{name:'hull-x'}),/#SBATCH --time=24:00:00/);
});
