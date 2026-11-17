import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCfdRunResult} from './result-reader.mjs';
import * as core from './generated/core.mjs';

async function fixture(options={}){
 const dir=await mkdtemp(join(tmpdir(),'hull-cfd-reader-'));await mkdir(join(dir,'postProcessing/hullForces/0'),{recursive:true});
 const log=['Time = 1','deltaT = 0.01','smoothSolver: Solving for Ux, Initial residual = 0.1, Final residual = 1e-8','Min(alpha.water) = 0 Max(alpha.water) = 1',options.complete===false?'':'End'].join('\n');
 await writeFile(join(dir,'log.interFoam'),log);await writeFile(join(dir,'log.checkMesh'),'cells: 12345\nMesh OK.\n');await writeFile(join(dir,'log.checkMeshDetailed'),options.detailed===false?'Failed 1 mesh checks.':'Mesh OK.');
 const header='# Time total_x total_y total_z pressure_x pressure_y pressure_z viscous_x viscous_y viscous_z\n';const rows=Array.from({length:101},(_,i)=>`${i/100} -0.01 0 2 -0.008 0 2 -0.002 0 0`).join('\n');await writeFile(join(dir,'postProcessing/hullForces/0/force.dat'),header+rows);
 const manifest={caseId:'test-fixture',solver:{application:'interFoam',version:'2312'},numerics:{durationS:1,recommendedWarmupS:.2},condition:{kind:'calm'},mode:'fixed-resistance'};
 return {dir,manifest};
}
test('actual force file fields are parsed without declaring experimental validation',async()=>{const f=await fixture();try{const r=await readCfdRunResult(f.dir,{manifest:f.manifest,...core});assert.ok(Math.abs(r.forces.meanDragN-.01)<1e-12);assert.equal(r.solverRun.actualMeshCells,12345);assert.equal(r.quality.rankable,false);assert.equal(r.quality.physicalValidation,'not-performed');}finally{await rm(f.dir,{recursive:true,force:true});}});
test('a failed detailed geometry report remains visible even with safety Mesh OK',async()=>{const f=await fixture({detailed:false});try{const r=await readCfdRunResult(f.dir,{manifest:f.manifest,...core});assert.equal(r.quality.meshOkay,true);assert.equal(r.quality.detailedMeshOkay,false);assert.equal(r.status,'incomplete-unverified');}finally{await rm(f.dir,{recursive:true,force:true});}});
test('missing normal solver completion is not promoted to a completed result',async()=>{const f=await fixture({complete:false});try{const r=await readCfdRunResult(f.dir,{manifest:f.manifest,...core});assert.equal(r.quality.completedTime,false);assert.equal(r.status,'incomplete-unverified');}finally{await rm(f.dir,{recursive:true,force:true});}});
test('missing solver output never falls back to empirical drag',async()=>{const dir=await mkdtemp(join(tmpdir(),'hull-cfd-empty-'));try{await assert.rejects(readCfdRunResult(dir,{manifest:{solver:{application:'interFoam'},numerics:{durationS:1}},...core}),/No genuine/);}finally{await rm(dir,{recursive:true,force:true});}});
test('motion RMS comes from the recorded post-startup history and retains its initial orientation inputs',async()=>{
 const f=await fixture();
 try{
  await mkdir(join(f.dir,'postProcessing/rigidBodyState/0'),{recursive:true});
  const header='# Motion State\n# Angle Units : radians\n# Time centreOfRotation centreOfMass rotation velocity omega\n';
  const rows=Array.from({length:101},(_,i)=>{const t=i/100,r=Math.sin(2*Math.PI*t/.1)*Math.PI/180,h=Math.sin(2*Math.PI*t/.1)*.001;return `${t} (.1 0 ${h}) (.1 0 ${h}) (${r} 0 0) (0 0 0) (0 0 0)`;}).join('\n');
  await writeFile(join(f.dir,'postProcessing/rigidBodyState/0/sixDoFRigidBodyState.dat'),header+rows);
  f.manifest.mode='free-motion';f.manifest.condition={kind:'beam-waves',periodS:.1};f.manifest.load={solverCgM:[.1,0,0]};f.manifest.motion={initialOrientation:[[1,0,0],[0,1,0],[0,0,1]],rollAxis:[1,0,0]};
  let received;
  const r=await readCfdRunResult(f.dir,{manifest:f.manifest,...core,parseMotionData:(text,options)=>{received=options;return core.parseMotionData(text,options);}});
  assert.ok(r.motion.rollRmsDeg>.6&&r.motion.rollRmsDeg<.8);assert.ok(r.motion.heaveRmsM>.0006&&r.motion.heaveRmsM<.0008);
  assert.equal(r.motion.rollRmsDriftWithinTolerance,true);assert.equal(r.quality.motionRmsDrift,true);assert.deepEqual(received.initialOrientation,f.manifest.motion.initialOrientation);assert.deepEqual(received.rollAxis,[1,0,0]);assert.equal(r.quality.rankable,false);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
