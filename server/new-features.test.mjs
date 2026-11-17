import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanFullLog,analyseWaveGauges} from './result-reader.mjs';
import {predictRun,learn,remainingStudySeconds,DEFAULTS,PARALLEL_EXPONENT} from './estimator.mjs';
import {explainFailure} from './failure-hints.mjs';

test('full log scan covers the whole history, not only the tail',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'scan-'));
  const ok='Time = 0.1\nsmoothSolver:  Solving for Ux, Initial residual = 1e-3, Final residual = 1e-9, No Iterations 2\nPhase-1 volume fraction = 0.5  Min(alpha.water) = -1e-8  Max(alpha.water) = 1.0000001\ndeltaT = 0.001\n';
  const bad='Time = 0.0005\nPhase-1 volume fraction = 0.5  Min(alpha.water) = -0.02  Max(alpha.water) = 1\nGAMG:  Solving for p_rgh, Initial residual = nan, Final residual = nan, No Iterations 1\n';
  await writeFile(join(dir,'log'),bad+ok.repeat(20000));
  const r=await scanFullLog(join(dir,'log'));
  assert.equal(r.residualInvalid,true);assert.equal(r.alphaMin,-0.02);assert.equal(r.residualCount,40002);
  assert.equal(r.deltaT.count,20000);assert.equal(r.deltaT.maximum,.001);assert.equal(r.fatal,false);
});

test('wave gauges recover a sine wave height and period and flag a damped wave',()=>{
  const T=.6,H=.012,lines=['# Time  p1  p2'];
  for(let i=0;i<=4000;i++){const t=i*.0025,a=H/2*Math.sin(2*Math.PI*t/T),b=.5*H/2*Math.sin(2*Math.PI*t/T+1);lines.push(`${t}\t( 0.1 -0.1 ${a} ) ( 0.1 -0.2 ${b} )`);}
  const text=lines.join('\n');
  const good=analyseWaveGauges(text.replace(/\( 0\.1 -0\.2 [^)]*\)/g,m=>m),{startS:3,endS:10,targetHeightM:H,targetPeriodS:T});
  assert.ok(Math.abs(good.gauges[0].heightM/H-1)<.01,String(good.gauges[0].heightM));
  assert.ok(Math.abs(good.gauges[0].periodS/T-1)<.01);
  assert.ok(Math.abs(good.gauges[1].heightM/(H/2)-1)<.01);
  // Mean of a full-height and a half-height gauge is 75% of target: outside the ±10% tolerance.
  assert.equal(good.withinTolerance,false);assert.ok(Math.abs(good.heightRatio-.75)<.01);
  const onlyFull=analyseWaveGauges(lines.map(l=>l.replace(/ \( 0\.1 -0\.2 [^)]*\)$/,'')).join('\n'),{startS:3,endS:10,targetHeightM:H,targetPeriodS:T});
  assert.equal(onlyFull.withinTolerance,true);
});

test('estimator reproduces the measured quick calm run and learns from finished runs',()=>{
  const manifest={condition:{kind:'calm'},mesh:{fidelity:'quick',estimatedBaseCells:107712,finestCellM:.003125},numerics:{durationS:4,maxDeltaTS:.004}};
  const p=predictRun(manifest,{cores:4});
  // Measured on the reference VM: 128,170 cells, 3,593 steps, 1,081 s solve + ~20 s meshing.
  assert.ok(Math.abs(p.cells-128170)/128170<.01);assert.ok(Math.abs(p.steps-3593)/3593<.05);assert.ok(Math.abs(p.totalS-1100)/1100<.1,String(p.totalS));
  // A machine twice as fast halves later predictions, including for run types it has not seen yet.
  const cal=learn({},{manifest,actualCells:128170,steps:3593,solveWallS:540,meshWallS:10,cores:4});
  assert.ok(Math.abs(predictRun(manifest,{cores:4,calibration:cal}).solveS-540)/540<.02);
  const wave={condition:{kind:'beam-waves'},mesh:{fidelity:'quick',estimatedBaseCells:1e6,finestCellM:.002},numerics:{durationS:10,maxDeltaTS:.006}};
  assert.ok(predictRun(wave,{cores:4,calibration:cal}).solveS<predictRun(wave,{cores:4}).solveS*.6);
  assert.equal(predictRun(manifest,{cores:16}).solveS/predictRun(manifest,{cores:1}).solveS,16**-PARALLEL_EXPONENT);
  assert.ok(DEFAULTS['calm:quick'].secondsPerCellStep>0);
});

test('study remaining time uses the live solver rate and scales queued runs by actual/predicted',()=>{
  const r=remainingStudySeconds({active:{predictedS:1000,liveEtaS:300,elapsedS:900},pending:[{predictedS:1000},{predictedS:500}],finished:[{predictedS:1000,actualS:2000}]});
  assert.equal(r.activeS,300);assert.equal(r.queuedS,3000);assert.equal(r.totalS,3300);
  const meshing=remainingStudySeconds({active:{predictedS:1000,liveEtaS:null,elapsedS:200},pending:[]});
  assert.equal(meshing.totalS,800);
});

test('common failures get a plain-language explanation',()=>{
  assert.equal(explainFailure('This load reaches or exceeds the hull envelope displacement.').title,'Hull cannot float this load');
  assert.equal(explainFailure('OpenFOAM stopped with exit 1.',['Mesh quality checks did not pass. Solver stopped before creating results.']).title,'Mesh failed the quality check');
  assert.equal(explainFailure('OpenFOAM stopped with exit 137. Inspect the stage logs').title,'Ran out of memory');
  assert.equal(explainFailure('HULL_CFD_STAGE:surfaceCheck\nall fine'),null);
});

test('boolean output snapping merges nanometre-apart vertices and keeps the surface closed',async()=>{
  const {snapTriangles}=await import('./geometry-repair.mjs');
  // Unit cube (mm) where one corner is stored twice, 10 nm apart, plus a sliver between the two copies.
  const v=[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
  const q=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const tris=q.flatMap(([a,b,c,d])=>[[a,b,c],[a,c,d]]).flatMap(t=>t.flatMap(i=>v[i]));
  const nudged=tris.map((x,i)=>i===0?x+1e-5:x);
  const out=snapTriangles(nudged);
  assert.ok(out);assert.equal(out.length,tris.length);assert.equal(out[0],0);
  // An open surface is not accepted (caller then keeps the original).
  assert.equal(snapTriangles(tris.slice(0,-9)),null);
});

test('mesh gate tolerates a few soft-quality faces but never invalid cells',async()=>{
  const {meshGate}=await import('./result-reader.mjs');const {readFile}=await import('node:fs/promises');
  // Real snappyHexMesh wave mesh (catamaran, 307k cells): 3 faces at 65.1° and 2 twisted faces.
  const real=await readFile(new URL('./fixtures/checkMesh-tolerated.log',import.meta.url),'utf8');
  const g=meshGate(real);assert.equal(g.ok,true);assert.equal(g.softFaces,5);assert.equal(g.cells,307272);
  assert.equal(meshGate(real.replace(/(pyramid volume < 1e-18\s*:\s*)0/,'$11')).ok,false);
  assert.equal(meshGate(real.replace(/(non-orthogonality >  65 degrees\s*:\s*)3/,'$1300')).ok,false);
  assert.equal(meshGate(real.replace('highly skew faces','zero or negative cell volume')).ok,false);
  assert.equal(meshGate('    cells: 10\nMesh OK.\n').ok,true);
});
