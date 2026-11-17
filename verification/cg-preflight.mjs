// Run after npm run build:cfd. This checks the distributed service core, not a CFD solve.
import {prepareCfdJob} from '../server/generated/core.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const stl=await readFile(new URL('../samples/barge-200.stl',import.meta.url));
const faceCount=stl.readUInt32LE(80);
assert.equal(stl.length,84+faceCount*50,'Expected the supplied binary STL fixture.');
const trianglesMm=Array.from({length:faceCount},(_,face)=>Array.from({length:9},(_,j)=>stl.readFloatLE(84+face*50+12+j*4))).flat();
assert.ok(trianglesMm.length>0);
const prepared=await prepareCfdJob({
  name:'Packaged CAD CG preflight',trianglesMm,geometryMode:'closed-envelope',mode:'calm',
  massKg:.25,cgSource:'cad-estimate',cgM:[0,0,0],measurementsConfirmed:true,assumptionsConfirmed:true,
  cgEstimate:{distribution:'shell',payloads:[{name:'Cargo',massKg:.05,positionM:[.12,0,.04]}]},
  speedMps:.3,mesh:'coarse',durationS:5,timeStepS:.0005,
},'packaged-cg-preflight');
const estimate=JSON.parse(prepared.package.files['cg-estimate.json']);
const manifest=JSON.parse(prepared.package.files['manifest.json']);
const req=JSON.parse(prepared.package.files['request.json']);
assert.equal(manifest.load.cgMeasured,false);
assert.equal(manifest.load.cgSource,'cad-estimate');
assert.equal(req.cgSource,'cad-estimate');
assert.equal(req.physicalProtocol.cgSource,'cad-estimate');
assert.equal(estimate.recomputedByService,true);
assert.ok(Math.abs(estimate.hullMassKg-.2)<1e-12);
assert.equal(estimate.payloadMassKg,.05);
estimate.cgM.forEach((v,i)=>assert.ok(Math.abs(v-(.2*estimate.hullCgM[i]+.05*[.12,0,.04][i])/.25)<1e-12));
assert.deepEqual(manifest.load.cgM,estimate.cgM);
assert.ok(manifest.notes.some(n=>n.includes('was not measured')));
const output={
  applicationVersion:'1.2.0',test:'Distributed service core CAD-CG preflight',passed:true,
  nativeSolverRun:false,physicalAccuracyValidated:false,
  totalMassKg:.25,hullMassKg:estimate.hullMassKg,payloadMassKg:estimate.payloadMassKg,
  hullCgM:estimate.hullCgM,loadedCgM:estimate.cgM,cgSource:req.cgSource,cgMeasured:manifest.load.cgMeasured,
  geometryHash:prepared.geometryHash,protocolHash:prepared.protocolHash,
  assumptions:estimate.assumptions,
};
await writeFile(new URL('./cg-preflight.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({passed:true,cgM:estimate.cgM,cgSource:req.cgSource,cgMeasured:manifest.load.cgMeasured}));
