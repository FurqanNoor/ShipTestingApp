/**
 * Run cases on a Slurm cluster (e.g. CSC Roihu) over SSH, using the same pinned OpenFOAM image through Apptainer.
 * The app still prepares every case and reads every result locally; the cluster only executes Allrun.
 *
 * Transport is the system OpenSSH client with key authentication (BatchMode: it never prompts). Each poll is one SSH
 * connection for all active jobs. Case folders travel as tar streams (tar ships with Windows 10+, macOS and Linux).
 */
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';

export const CLUSTER_DEFAULTS={enabled:false,host:'roihu-cpu.csc.fi',user:'',account:'',partition:'small',cores:64,memoryGb:0,hours:24,remoteDir:'',sshKey:'',concurrentStudies:20};
const SAFE={host:/^[A-Za-z0-9.-]{1,253}$/,user:/^[A-Za-z0-9._-]{1,64}$/,account:/^[A-Za-z0-9_-]{1,64}$/,partition:/^[A-Za-z0-9_,-]{1,64}$/,remoteDir:/^\/[A-Za-z0-9_./-]{1,200}$/};

/** Validate and normalise settings; every value that reaches a remote shell is restricted to safe characters. */
export function normaliseClusterConfig(input={}){
  const c={...CLUSTER_DEFAULTS,...Object.fromEntries(Object.entries(input).filter(([k])=>k in CLUSTER_DEFAULTS))};
  c.enabled=c.enabled===true;
  for(const k of ['host','user','account','partition','remoteDir','sshKey'])c[k]=String(c[k]??'').trim();
  const int=(v,lo,hi,d)=>Number.isInteger(Number(v))&&Number(v)>=lo&&Number(v)<=hi?Number(v):d;
  c.cores=int(c.cores,1,512,32);c.memoryGb=int(c.memoryGb,0,4096,0);c.hours=int(c.hours,1,336,24);c.concurrentStudies=int(c.concurrentStudies,1,200,20);
  if(c.remoteDir.endsWith('/'))c.remoteDir=c.remoteDir.slice(0,-1);
  return c;
}
export function clusterProblems(c){
  const p=[];
  for(const k of ['host','user','account','partition','remoteDir'])if(!c[k])p.push(`Fill in ${k}.`);else if(!SAFE[k].test(c[k]))p.push(`${k} contains characters that are not allowed.`);
  if(c.remoteDir&&c.remoteDir.split('/').includes('..'))p.push('remoteDir must not contain "..".');
  return p;
}
export const sifPath=c=>`${c.remoteDir}/openfoam-v2312.sif`;
// Tests can substitute the SSH program (JSON array, e.g. ["node","fake-ssh.mjs"]); normal use runs the system ssh.
const SSH=(()=>{try{const v=JSON.parse(process.env.CFD_SSH_COMMAND||'null');return Array.isArray(v)&&v.length?v.map(String):['ssh'];}catch{return ['ssh'];}})();
const target=c=>`${c.user}@${c.host}`;

/** The private key ssh will use: the configured one, else the first default key that exists. */
export function keyPath(c){
  if(c.sshKey)return c.sshKey;
  for(const n of ['id_ed25519','id_ecdsa','id_rsa']){const p=join(homedir(),'.ssh',n);if(existsSync(p))return p;}
  return join(homedir(),'.ssh','id_ed25519');
}
/** Parse the "Valid: from A to B" line of ssh-keygen -L (local time, no zone). */
export function parseCertValidity(text){
  const m=/Valid:\s*(?:from\s+(\S+)\s+to\s+(\S+)|(forever))/.exec(text??'');
  if(m?.[3])return {from:null,to:null};
  if(!m)return null;
  const t=new Date(m[2]);return Number.isFinite(t.getTime())?{from:m[1],to:t.toISOString()}:null;
}
/**
 * Roihu (and other CSC systems) accept a key only together with a signed SSH certificate that expires after 24 h.
 * Returns {required, path, exists, expiresAt, valid, hoursLeft, message} for the key ssh will use.
 */
export function certificateStatus(c,now=Date.now()){
  const required=/(^|\.)csc\.fi$/i.test(c.host||'')&&/roihu/i.test(c.host||'');
  const path=keyPath(c)+'-cert.pub';
  const base={required,path,exists:existsSync(path),expiresAt:null,valid:false,hoursLeft:0};
  if(!base.exists)return Promise.resolve({...base,message:required?`No Roihu SSH certificate found. In MyCSC open Profile → SSH public keys → ⋮ → "Sign and download SSH certificate" and save it as ${path}`:''});
  return new Promise(res=>execFile('ssh-keygen',['-L','-f',path],{windowsHide:true,timeout:10_000},(err,out)=>{
    const v=err?null:parseCertValidity(out);
    if(!v)return res({...base,message:`Could not read the SSH certificate ${path}. Download it again from MyCSC.`});
    if(!v.to)return res({...base,valid:true,hoursLeft:Infinity,message:'SSH certificate does not expire.'});
    const left=(Date.parse(v.to)-now)/3_600_000;
    res({...base,expiresAt:v.to,valid:left>0,hoursLeft:Math.max(0,left),
      message:left>0?`SSH certificate valid for ${left<1?Math.round(left*60)+' more minutes':left.toFixed(1)+' more hours'}.`:'The Roihu SSH certificate has expired (they last 24 h). In MyCSC open Profile → SSH public keys → ⋮ → "Sign and download SSH certificate" and save it as '+path+' (replace the old file).'});
  }));
}
function sshArgs(c){
  const a=['-o','BatchMode=yes','-o','LogLevel=ERROR','-o','ConnectTimeout=20','-o','StrictHostKeyChecking=accept-new','-o','ServerAliveInterval=30'];
  if(c.sshKey)a.push('-i',c.sshKey);
  return a;
}

/** Run one remote command. Resolves with stdout; rejects with a readable message (stderr) on failure. */
export function ssh(c,command,{timeoutMs=120_000,stdin=null}={}){
  return new Promise((res,rej)=>{
    const child=spawn(SSH[0],[...SSH.slice(1),...sshArgs(c),target(c),command],{stdio:[stdin?'pipe':'ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';const timer=setTimeout(()=>{child.kill();rej(new Error('The cluster did not answer in time (SSH timeout).'));},timeoutMs);
    child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
    child.once('error',e=>{clearTimeout(timer);rej(new Error(e.code==='ENOENT'?'The ssh command was not found. Install the OpenSSH client (built into Windows 10/11, macOS and Linux).':e.message));});
    child.once('exit',code=>{clearTimeout(timer);if(code===0)res(out);else rej(new Error(explainSsh(err)||`Remote command failed (exit ${code}).`));});
    if(stdin){stdin.pipe(child.stdin);stdin.once('error',e=>{child.kill();rej(e);});}
  });
}
function explainSsh(err){
  // Drop informational client warnings (e.g. "** WARNING: connection is not using a post-quantum key exchange").
  const e=err.split('\n').filter(l=>!/^\*\*|^\s*\*\* /.test(l)&&!/post-quantum|upgraded\.|openssh\.com\/pq/i.test(l)).join('\n').trim();
  if(/Permission denied/i.test(e))return 'The cluster refused the SSH login. On Roihu this usually means the daily SSH certificate is missing or expired: in MyCSC open Profile → SSH public keys → ⋮ → "Sign and download SSH certificate" and save it next to your key as id_ed25519-cert.pub. Otherwise check that the public key is added in MyCSC and the project has Roihu enabled. '+e.slice(0,300);
  if(/Could not resolve hostname/i.test(e))return 'Unknown cluster host name. Check the host setting. '+e.slice(0,200);
  if(/timed out|Connection refused|No route/i.test(e))return 'Could not reach the cluster. Check your internet connection or VPN. '+e.slice(0,200);
  return e.slice(0,600);
}

/** Stream a local folder (as tar) into a remote folder. */
// On Windows use the built-in bsdtar: a Git/MSYS GNU tar earlier in PATH misreads "C:\..." paths. The folder is passed as
// the working directory rather than a -C argument for the same reason.
const TAR=(()=>{if(process.platform!=='win32')return 'tar';const p=join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');return existsSync(p)?p:'tar';})();
export function upload(c,localDir,remoteDir){
  const tar=spawn(TAR,['--exclude=case-input.zip','-cf','-','.'],{cwd:localDir,stdio:['ignore','pipe','pipe'],windowsHide:true});
  return ssh(c,`mkdir -p '${remoteDir}' && tar -C '${remoteDir}' -xf -`,{stdin:tar.stdout,timeoutMs:600_000});
}
/** Fetch the result files (logs and postProcessing) of a finished remote case into the local case folder. */
export function download(c,remoteDir,localDir){
  return new Promise((res,rej)=>{
    const s=spawn(SSH[0],[...SSH.slice(1),...sshArgs(c),target(c),`cd '${remoteDir}' && tar -cf - log.* service-runner.log postProcessing 2>/dev/null; true`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    const t=spawn(TAR,['-xf','-'],{cwd:localDir,stdio:['pipe','ignore','pipe'],windowsHide:true});
    s.stdout.pipe(t.stdin);t.stdin.on('error',()=>{});let err='';s.stderr.on('data',d=>{err+=d;});t.stderr.on('data',d=>{err+=d;});
    const timer=setTimeout(()=>{s.kill();t.kill();rej(new Error('Downloading results from the cluster timed out.'));},900_000);
    let pending=2,failed=null;const done=code=>{if(code!==0&&!failed)failed=code;if(--pending===0){clearTimeout(timer);failed?rej(new Error(explainSsh(err)||'Downloading results failed.')):res();}};
    // If the local tar stops early, stop ssh too instead of letting it block on a full pipe until the timeout.
    s.once('exit',done);t.once('exit',code=>{if(code!==0)s.kill();done(code);});s.once('error',rej);t.once('error',rej);
  });
}

/** Slurm batch script: one node, all requested cores, the pinned image through Apptainer with a clean environment. */
export function batchScript(c,{name,cores=c.cores}){
  const hh=String(c.hours).padStart(2,'0');
  return ['#!/bin/bash',
    `#SBATCH --job-name=${name}`,`#SBATCH --account=${c.account}`,`#SBATCH --partition=${c.partition}`,
    '#SBATCH --nodes=1','#SBATCH --ntasks=1',`#SBATCH --cpus-per-task=${cores}`,
    ...(c.memoryGb?[`#SBATCH --mem=${c.memoryGb}G`]:[]),
    `#SBATCH --time=${hh}:00:00`,'#SBATCH --output=service-runner.log',
    'cd "$SLURM_SUBMIT_DIR"',
    "tr -d '\\r' < Allrun > Allrun.sh",
    // --cleanenv keeps Slurm variables away from the container's own OpenMPI (it then launches ranks on this node).
    `apptainer exec --cleanenv --env HULL_NPROCS=${cores} --bind "$PWD:/case" --pwd /case '${sifPath(c)}' bash Allrun.sh`,
    'code=$?',
    // Keep the scratch quota small: decomposed fields are not needed once logs and postProcessing are written.
    'rm -rf processor* 2>/dev/null',
    'echo "HULL_EXIT $code"','exit $code',''].join('\n');
}

export async function submit(c,remoteDir){
  const out=await ssh(c,`cd '${remoteDir}' && sbatch --parsable job.sh`);
  const id=/^(\d+)/.exec(out.trim())?.[1];if(!id)throw new Error('The cluster did not return a Slurm job id: '+out.slice(0,200));
  return id;
}
export const cancelRemote=(c,slurmId)=>ssh(c,`scancel ${Number(slurmId)}`).catch(()=>{});

/**
 * One SSH call for every active job: Slurm state plus the new part of each job's log (base64, so any log content is
 * safe to parse). Returns Map(slurmId -> {state, bytes, text}).
 */
export async function poll(c,list){
  if(!list.length)return new Map();
  const parts=list.map(j=>{const id=Number(j.slurmId),off=Math.max(0,Number(j.offset)||0);
    return `echo "@@JOB ${id}"; s=$(squeue -h -j ${id} -o %T 2>/dev/null); [ -z "$s" ] && s=$(sacct -n -X -j ${id} -o State%20 2>/dev/null | head -1 | tr -d ' '); echo "@@STATE $s"; f='${j.remoteDir}/service-runner.log'; n=$(stat -c %s "$f" 2>/dev/null || echo 0); x=$(tail -c 400 "$f" 2>/dev/null | grep -ao 'HULL_EXIT [0-9]*' | tail -1); echo "@@EXIT $x"; echo "@@SIZE $n"; if [ "$n" -gt ${off} ]; then tail -c +${off+1} "$f" | head -c 4194304 | base64 -w0; fi; echo; echo "@@END"`;});
  const out=await ssh(c,parts.join('; '),{timeoutMs:120_000});
  const map=new Map(),offsets=new Map(list.map(j=>[String(Number(j.slurmId)),Math.max(0,Number(j.offset)||0)]));
  for(const block of out.split('@@JOB ').slice(1)){
    const id=/^(\d+)/.exec(block)?.[1];if(!id)continue;
    const state=/@@STATE ([^\n]*)/.exec(block)?.[1].trim()??'';
    const size=Number(/@@SIZE (\d+)/.exec(block)?.[1]??0);
    // The exit marker is read from the end of the remote log, so it is found even while the streamed log lags behind.
    const exitCode=/@@EXIT HULL_EXIT (\d+)/.exec(block)?.[1]??null;
    const b64=(block.split(/@@SIZE \d+\r?\n/)[1]??'').split('@@END')[0].trim();
    const buf=b64?Buffer.from(b64,'base64'):Buffer.alloc(0);
    // Advance only by what was actually sent (at most 4 MB per poll); a fast log catches up over the next polls.
    map.set(id,{state,size,bytes:(offsets.get(id)??0)+buf.length,exitCode,text:buf.toString('utf8')});
  }
  return map;
}
export const RUNNING_STATES=new Set(['PENDING','CONFIGURING','RUNNING','COMPLETING','REQUEUED','RESIZING','SUSPENDED']);
export const SLURM_TEXT={PENDING:'Waiting for a compute node on the cluster',CONFIGURING:'Starting a compute node',RUNNING:'Running on the cluster',COMPLETING:'Finishing on the cluster'};

/** Connection test: host, Slurm, Apptainer and whether the solver image is installed. */
export async function checkCluster(c){
  const out=await ssh(c,`echo "@@HOST $(hostname)"; echo "@@APPTAINER $(command -v apptainer || command -v singularity || echo none)"; echo "@@SBATCH $(command -v sbatch || echo none)"; mkdir -p '${c.remoteDir}' && echo "@@DIR ok" || echo "@@DIR fail"; [ -f '${sifPath(c)}' ] && echo "@@SIF ok" || echo "@@SIF missing"; echo "@@PARTITIONS"; sinfo -h -o "%P %l %c" 2>/dev/null | head -20`,{timeoutMs:60_000});
  const get=k=>new RegExp(`@@${k} ([^\\n]*)`).exec(out)?.[1].trim()??'';
  return {host:get('HOST'),apptainer:get('APPTAINER')!=='none'&&!!get('APPTAINER'),slurm:get('SBATCH')!=='none'&&!!get('SBATCH'),remoteDirOk:get('DIR')==='ok',solverInstalled:get('SIF')==='ok',
    partitions:(out.split('@@PARTITIONS')[1]??'').trim().split('\n').map(l=>l.trim()).filter(Boolean)};
}
/** Download the pinned OpenFOAM image into the remote folder once (caches kept under remoteDir, not the small home). */
export function installSolver(c,image){
  const cache=`${c.remoteDir}/.apptainer-cache`;
  return ssh(c,`mkdir -p '${cache}/tmp' && cd '${c.remoteDir}' && if [ -f '${sifPath(c)}' ]; then echo already; else APPTAINER_CACHEDIR='${cache}' APPTAINER_TMPDIR='${cache}/tmp' apptainer pull '${sifPath(c)}.part' 'docker://${image}' && mv '${sifPath(c)}.part' '${sifPath(c)}' && echo installed; fi`,{timeoutMs:3_600_000});
}

export async function loadClusterConfig(path){try{return normaliseClusterConfig(JSON.parse(await readFile(path,'utf8')));}catch{return normaliseClusterConfig();}}
export async function saveClusterConfig(path,c){await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(c,null,2));await rename(path+'.tmp',path);}
