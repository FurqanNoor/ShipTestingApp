// Regression test for the overnight crash: many simultaneous uploads, the login node refusing some connections, and the
// resulting broken pipe killing the server. A fake ssh refuses the first attempts, then accepts; uploads must succeed,
// never exceed the connection limit, and never throw an unhandled EPIPE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('uploads are throttled, refused connections are retried, and a broken pipe never crashes the process',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ssh-test-'));
  try{
    const state=join(dir,'state');await writeFile(state,'0 0');
    // Fake ssh: tracks concurrent connections; every third call is refused immediately (exit 255, stdin unread).
    const fake=join(dir,'fake-ssh.mjs');
    await writeFile(fake,`import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
const S=${JSON.stringify(state)},L=S+'.lock';
const lock=()=>{for(;;){try{closeSync(openSync(L,'wx'));return;}catch{}}};const unlock=()=>unlinkSync(L);
lock();let [n,max,calls=0]=readFileSync(S,'utf8').split(' ').map(Number);n++;calls++;max=Math.max(max,n);writeFileSync(S,n+' '+max+' '+calls);unlock();
const done=c=>{lock();let [a,b,k]=readFileSync(S,'utf8').split(' ').map(Number);writeFileSync(S,(a-1)+' '+b+' '+k);unlock();process.exit(c);};
if(calls%3===0){process.stderr.write('kex_exchange_identification: Connection closed by remote host\\n');setTimeout(()=>done(255),5);}
else{let bytes=0;process.stdin.on('data',d=>{bytes+=d.length;});process.stdin.on('end',()=>setTimeout(()=>done(0),20));}
`);
    process.env.CFD_SSH_COMMAND=JSON.stringify([process.execPath,fake]);process.env.CFD_SSH_SLOTS='3';process.env.CFD_SSH_RETRY_MS='5';
    const cluster=await import('./cluster.mjs?ssh-test');
    const c=cluster.normaliseClusterConfig({enabled:true,host:'roihu-cpu.csc.fi',user:'u',account:'project_1',partition:'small',remoteDir:'/scratch/project_1/x'});
    const caseDir=join(dir,'case');await import('node:fs/promises').then(f=>f.mkdir(caseDir));
    await writeFile(join(caseDir,'big.dat'),'x'.repeat(2_000_000));
    let unhandled=null;const onError=e=>{unhandled=e;};process.on('uncaughtException',onError);
    try{await Promise.all(Array.from({length:12},(_,i)=>cluster.upload(c,caseDir,`/scratch/project_1/x/runs/${i}`)));}
    finally{process.off('uncaughtException',onError);}
    const [,max,calls]=(await readFile(state,'utf8')).split(' ').map(Number);
    assert.equal(unhandled,null);
    assert.ok(max<=3,`at most 3 connections at once (saw ${max})`);
    assert.ok(calls>12,'refused connections were retried');
  }finally{await rm(dir,{recursive:true,force:true});}
});
