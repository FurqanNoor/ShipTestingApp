import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
const image='opencfd/openfoam-run@sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76';
const prefix=existsSync('/var/run/docker.sock')?['--host=unix:///var/run/docker.sock']:[];
const env={...process.env};if(prefix.length)for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
console.log('Pulling the pinned OpenCFD OpenFOAM v2312 runtime. Docker must be installed and running.');
const child=spawn('docker',[...prefix,'pull',image],{env,stdio:'inherit'});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
