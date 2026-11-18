/** Reads real OpenFOAM files only. Numerical checks never confer validation. */
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const LOG_LIMIT=5*1024*1024;
const RESULT_LIMIT=64*1024*1024;
const NUMBER='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numeric=new RegExp(`^${NUMBER}$`);
const finiteToken=value=>typeof value==='string'&&numeric.test(value)&&Number.isFinite(Number(value))?Number(value):null;

function relativeName(base,path) {
  const name=relative(base,path);
  if(isAbsolute(name)||name==='..'||name.startsWith('..'+sep))throw new Error('Solver output must stay within its case directory.');
  return name.split(sep).join('/');
}
async function regularFile(path) {
  try{const s=await lstat(path);return s.isFile()&&!s.isSymbolicLink()?s:null;}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;}
}
async function regularDirectory(path) {
  try{const s=await lstat(path);return s.isDirectory()&&!s.isSymbolicLink();}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}
}
async function boundedFile(base,path,limit,tail=false) {
  relativeName(base,path);
  const stat=await regularFile(path);
  if(!stat)return null;
  if(!tail&&stat.size>limit)return {text:null,bytes:stat.size,truncated:true,path:relativeName(base,path)};
  const length=Math.min(stat.size,limit),start=tail?Math.max(0,stat.size-limit):0;
  const handle=await open(path,'r');
  try {
    const buffer=Buffer.alloc(length);
    const {bytesRead}=await handle.read(buffer,0,length,start);
    return {text:buffer.subarray(0,bytesRead).toString('utf8'),bytes:stat.size,truncated:start>0,path:relativeName(base,path)};
  } finally{await handle.close();}
}

/**
 * Stream the complete solver log (any size) for the history-wide checks: finite residuals, alpha bounds,
 * fatal errors and time-step range. Memory stays bounded; only summaries are kept.
 */
export async function scanFullLog(path){
  const residualRe=/(?:Initial|Final)\s+residual\s*=\s*([^\s,;]+)/gi,minRe=/min\(\s*alpha\.water\s*\)\s*=\s*([^\s,;]+)/gi,maxRe=/max\(\s*alpha\.water\s*\)\s*=\s*([^\s,;]+)/gi;
  const out={lines:0,residualCount:0,residualInvalid:false,alphaMin:Infinity,alphaMax:-Infinity,alphaMinCount:0,alphaMaxCount:0,alphaInvalid:false,fatal:false,deltaT:{minimum:Infinity,maximum:-Infinity,count:0,invalid:false}};
  const rl=createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity});
  for await(const line of rl){
    out.lines++;
    if(/FOAM FATAL|Foam::sigFpe::sigHandler|Floating point exception\s*\(core dumped\)|Segmentation fault/i.test(line))out.fatal=true;
    if(line.includes('residual'))for(const m of line.matchAll(residualRe)){out.residualCount++;if(finiteToken(m[1])===null)out.residualInvalid=true;}
    if(line.includes('alpha.water)')){
      for(const m of line.matchAll(minRe)){const v=finiteToken(m[1]);out.alphaMinCount++;if(v===null)out.alphaInvalid=true;else out.alphaMin=Math.min(out.alphaMin,v);}
      for(const m of line.matchAll(maxRe)){const v=finiteToken(m[1]);out.alphaMaxCount++;if(v===null)out.alphaInvalid=true;else out.alphaMax=Math.max(out.alphaMax,v);}
    }
    const dt=/^\s*deltaT\s*=\s*([^\s,;]+)\s*$/.exec(line);
    if(dt){const v=finiteToken(dt[1]);out.deltaT.count++;if(v===null||v<=0)out.deltaT.invalid=true;else{out.deltaT.minimum=Math.min(out.deltaT.minimum,v);out.deltaT.maximum=Math.max(out.deltaT.maximum,v);}}
  }
  return out;
}

/**
 * Achieved regular waves from the interfaceHeight gauges (postProcessing/waveGauges/<t>/position.dat):
 * free-surface elevation at each gauge, height from the RMS of the de-meaned signal (H = 2*sqrt(2)*RMS for a sine)
 * and period from mean zero up-crossing interval, over the post-warmup window.
 */
/**
 * Mesh acceptance, identical to the Allrun gate. "Mesh OK" passes. Otherwise the mesh is accepted only if:
 * - the generic checkMesh failures are limited to highly skew faces or severely non-orthogonal faces (snappyHexMesh's
 *   relaxed pass allows up to 75°, and the solver uses limited non-orthogonal correction);
 * - no meshQualityDict face has zero/negative pyramid volume, invalid tetrahedra or a degenerate cell determinant;
 * - the remaining soft quality faces number at most max(10, cells / 10,000).
 */
export function meshGate(meshText){
  const cells=Number(/^\s*cells:\s*(\d+)/m.exec(meshText)?.[1]??0),limit=Math.max(10,Math.floor(cells/10000));
  if(/\bMesh OK\b/.test(meshText)&&!/Failed\s+[1-9]\d*\s+mesh checks|FOAM FATAL|Mesh has failed/i.test(meshText))return {ok:true,tolerated:false,softFaces:0,cells,limit};
  const generic=[...meshText.matchAll(/^\s*\*\*\*.*$/gm)].map(m=>m[0]);
  const section=(meshText.split(/Checking faces in error\s*:/)[1]??'').split(/\n\s*\n|<</)[0];
  const rows=[...section.matchAll(/^(.*?):\s*(\d+)\s*$/gm)].map(m=>({name:m[1],n:Number(m[2])}));
  const hard=rows.some(r=>/pyramid|tet quality|determinant/.test(r.name)&&r.n>0),softFaces=rows.reduce((a,r)=>a+(/pyramid|tet quality|determinant/.test(r.name)?0:r.n),0);
  const tolerated=/Failed\s+[1-9]\d*\s+mesh checks/.test(meshText)&&!/FOAM FATAL|Mesh has failed/.test(meshText)&&rows.length>0&&!hard&&softFaces<=limit
    &&generic.every(l=>/highly skew faces|severely non-orthogonal/.test(l));
  return {ok:tolerated,tolerated,softFaces,cells,limit};
}

export function analyseWaveGauges(text,{startS,endS,targetHeightM,targetPeriodS,wavelengthM=null,direction=null}){
  const rows=[];let positions=null;
  for(const line of text.split(/\r?\n/)){
    if(!line.trim()||line.trim().startsWith('#'))continue;
    const t=finiteToken(line.trim().split(/\s+/)[0]);if(t===null)continue;
    const matches=[...line.matchAll(/\(\s*([^\s()]+)\s+([^\s()]+)\s+([^\s()]+)\s*\)/g)];
    const vectors=matches.map(m=>finiteToken(m[3]));
    if(vectors.length&&vectors.every(v=>v!==null)){rows.push({t,z:vectors});positions??=matches.map(m=>[finiteToken(m[1]),finiteToken(m[2])]);}
  }
  if(!rows.length)return null;
  const gauges=rows[0].z.map((_,g)=>{
    const s=rows.filter(r=>r.t>=startS&&r.t<=endS&&r.z.length>g).map(r=>({t:r.t,z:r.z[g]}));
    if(s.length<20)return {samples:s.length,heightM:null,periodS:null};
    const mean=s.reduce((a,r)=>a+r.z,0)/s.length;
    const rms=timeWeightedRms(s.map(r=>({timeS:r.t,v:r.z-mean})),'v');
    const ups=[];for(let i=1;i<s.length;i++){const a=s[i-1].z-mean,b=s[i].z-mean;if(a<0&&b>=0)ups.push(s[i-1].t+(s[i].t-s[i-1].t)*(-a)/(b-a));}
    const periodS=ups.length>=3?(ups[ups.length-1]-ups[0])/(ups.length-1):null;
    return {samples:s.length,heightM:rms===null?null:2*Math.SQRT2*rms,periodS,crestToTroughM:Math.max(...s.map(r=>r.z))-Math.min(...s.map(r=>r.z))};
  });
  const usable=gauges.filter(g=>Number.isFinite(g.heightM));
  if(!usable.length)return {gauges,heightRatio:null,periodRatio:null,withinTolerance:null};
  const localHeightM=usable.reduce((a,g)=>a+g.heightM,0)/usable.length;
  const periods=usable.filter(g=>Number.isFinite(g.periodS)),periodS=periods.length?periods.reduce((a,g)=>a+g.periodS,0)/periods.length:null;
  // Incident/reflected separation: gauges beside a hull see the incoming wave plus what the hull reflects and radiates
  // back (a partial standing wave), so a single gauge can read anywhere from (1-Kr) to (1+Kr) times the incident height.
  const separation=separateIncidentWave(rows,{startS,endS,periodS:periodS??targetPeriodS,wavelengthM,direction,positions});
  const heightM=separation?separation.incidentHeightM:localHeightM;
  const heightRatio=targetHeightM>0?heightM/targetHeightM:null,periodRatio=periodS!==null&&targetPeriodS>0?periodS/targetPeriodS:null;
  const withinTolerance=heightRatio!==null&&periodRatio!==null?Math.abs(heightRatio-1)<=WAVE_HEIGHT_TOLERANCE&&Math.abs(periodRatio-1)<=WAVE_PERIOD_TOLERANCE:null;
  return {gauges,heightM,heightMethod:separation?'incident (multi-gauge separation)':'mean of gauges',localHeightM,reflectionCoefficient:separation?.reflectionCoefficient??null,periodS,targetHeightM,targetPeriodS,heightRatio,periodRatio,withinTolerance,tolerance:{height:WAVE_HEIGHT_TOLERANCE,period:WAVE_PERIOD_TOLERANCE},windowS:[startS,endS]};
}

/**
 * Least-squares split of regular-wave gauge records into an incident and a reflected component (Goda & Suzuki 1976,
 * extended to N gauges). Each gauge is fitted with c + a cos(wt) + b sin(wt) at the wave period, giving a complex
 * amplitude Z; then Z(s) = Ai e^{-iks} + Ar e^{iks} is fitted over gauge positions s along the propagation direction.
 * Returns null when it cannot be done reliably (fewer than 2 gauges, no wavelength, or gauges ~half a wavelength apart).
 */
export function separateIncidentWave(rows,{startS,endS,periodS,wavelengthM,direction,positions}){
  if(!(wavelengthM>0)||!(periodS>0)||!Array.isArray(direction)||!positions||positions.length<2)return null;
  const w=2*Math.PI/periodS,k=2*Math.PI/wavelengthM,win=rows.filter(r=>r.t>=startS&&r.t<=endS);
  if(win.length<40)return null;
  const s=positions.map(p=>p[0]*direction[0]+p[1]*direction[1]);
  if(s.some(v=>!Number.isFinite(v)))return null;
  const Z=positions.map((_,g)=>{
    const S=[[0,0,0],[0,0,0],[0,0,0]],R=[0,0,0];
    for(let i=1;i<win.length;i++){const r=win[i],dt=r.t-win[i-1].t,f=[1,Math.cos(w*r.t),Math.sin(w*r.t)];for(let a=0;a<3;a++){R[a]+=dt*f[a]*r.z[g];for(let b=0;b<3;b++)S[a][b]+=dt*f[a]*f[b];}}
    const x=solveLinear(S,R);return x?[x[1],-x[2]]:null;
  });
  if(Z.some(z=>!z))return null;
  // Normal equations for the 2 complex unknowns: M x = r, M = A^H A, r = A^H Z, A[g] = [e^{-iks}, e^{iks}].
  const N=s.length;let m12=[0,0];const r1=[0,0],r2=[0,0];
  for(let g=0;g<N;g++){
    const c=Math.cos(k*s[g]),sn=Math.sin(k*s[g]);
    // conj(e^{-iks}) = e^{iks}; conj(e^{iks}) = e^{-iks}
    r1[0]+=c*Z[g][0]-sn*Z[g][1];r1[1]+=c*Z[g][1]+sn*Z[g][0];
    r2[0]+=c*Z[g][0]+sn*Z[g][1];r2[1]+=c*Z[g][1]-sn*Z[g][0];
    m12[0]+=Math.cos(2*k*s[g]);m12[1]+=Math.sin(2*k*s[g]);// conj(e^{-iks}) e^{iks} = e^{2iks}
  }
  // M = [[N, m12],[conj(m12), N]]; det = N^2 - |m12|^2 (real). Ill-conditioned when all gauges sit ~lambda/2 apart.
  const det=N*N-(m12[0]**2+m12[1]**2);if(det<.05*N*N)return null;
  const mul=(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]];
  const t1=mul(m12,r2),Ai=[(N*r1[0]-t1[0])/det,(N*r1[1]-t1[1])/det];
  const t2=mul([m12[0],-m12[1]],r1),Ar=[(N*r2[0]-t2[0])/det,(N*r2[1]-t2[1])/det];
  const ai=Math.hypot(...Ai),ar=Math.hypot(...Ar);
  return {incidentHeightM:2*ai,reflectedHeightM:2*ar,reflectionCoefficient:ai>0?ar/ai:null,gaugePositionsM:s};
}
function solveLinear(A,b){
  const n=b.length,M=A.map((r,i)=>[...r,b[i]]);
  for(let i=0;i<n;i++){let p=i;for(let j=i+1;j<n;j++)if(Math.abs(M[j][i])>Math.abs(M[p][i]))p=j;[M[i],M[p]]=[M[p],M[i]];if(Math.abs(M[i][i])<1e-300)return null;
    for(let j=i+1;j<n;j++){const f=M[j][i]/M[i][i];for(let c=i;c<=n;c++)M[j][c]-=f*M[i][c];}}
  const x=new Array(n).fill(0);for(let i=n-1;i>=0;i--){let v=M[i][n];for(let c=i+1;c<n;c++)v-=M[i][c]*x[c];x[i]=v/M[i][i];}return x;
}
export const WAVE_HEIGHT_TOLERANCE=.1,WAVE_PERIOD_TOLERANCE=.05;

/** Never silently concatenate restart histories or choose an older valid file. */
async function latestOutput(base,objectName,fileNames) {
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(objectName))throw new Error('Invalid OpenFOAM function object name.');
  const pp=join(base,'postProcessing');
  if(!await regularDirectory(pp))return null;
  const object=join(pp,objectName);
  if(!await regularDirectory(object))return null;
  const entries=await readdir(object,{withFileTypes:true});
  const starts=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&numeric.test(e.name)&&Number.isFinite(Number(e.name))).sort((a,b)=>Number(b.name)-Number(a.name));
  if(!starts.length)return null;
  const selected=join(object,starts[0].name);
  for(const file of fileNames) {
    const path=join(selected,file);
    if(await regularFile(path))return {path,restartSegments:starts.length,segmentStartTimeS:Number(starts[0].name)};
  }
  return {path:null,restartSegments:starts.length,segmentStartTimeS:Number(starts[0].name)};
}
function observations(text,pattern) {
  return [...text.matchAll(pattern)].map(match=>({value:finiteToken(match[1]),raw:match[1]}));
}
function range(values) {
  if(!values.length)return null;
  return {minimum:values.reduce((a,b)=>Math.min(a,b),Infinity),maximum:values.reduce((a,b)=>Math.max(a,b),-Infinity),last:values[values.length-1],count:values.length};
}

/** Exact squared integral for the piecewise-linear sampled signal, independent of sample density. */
export function timeWeightedRms(samples,key,start=samples[0]?.timeS,end=samples[samples.length-1]?.timeS){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
  let area=0,covered=0;
  for(let i=1;i<samples.length;i++){
    const a=samples[i-1],b=samples[i],lo=Math.max(start,a.timeS),hi=Math.min(end,b.timeS);
    if(hi<=lo)continue;
    if(!Number.isFinite(a[key])||!Number.isFinite(b[key])||b.timeS<=a.timeS)return null;
    const va=a[key]+(b[key]-a[key])*(lo-a.timeS)/(b.timeS-a.timeS),vb=a[key]+(b[key]-a[key])*(hi-a.timeS)/(b.timeS-a.timeS);
    area+=(hi-lo)*(va*va+va*vb+vb*vb)/3;covered+=hi-lo;
  }
  return covered>0&&Math.abs(covered-(end-start))<=Math.max(1e-9,(end-start)*1e-8)?Math.sqrt(Math.max(0,area/covered)):null;
}

/**
 * Parser functions are injected from the built TS core. Importing this module
 * neither executes OpenFOAM nor requires a compiled/bundled browser dependency.
 */
export async function readCfdRunResult(caseDir,options) {
  const {manifest,hydro=null,geometryHash,protocolHash,parseForceData,summarizeForces,parseMotionData}=options??{};
  if(!manifest||!manifest.solver||!manifest.numerics)throw new Error('A solver manifest is required to read its results.');
  if(typeof parseForceData!=='function'||typeof summarizeForces!=='function')throw new Error('OpenFOAM force parsers must be supplied by the built core.');
  const base=await realpath(caseDir);
  const application=manifest.solver.application;
  if(!/^[A-Za-z][A-Za-z0-9]*$/.test(application))throw new Error('Invalid solver application in manifest.');
  const warnings=[],files=[],fileDetails=[];
  function remember(file,role) {
    if(!file)return;
    if(!files.includes(file.path)){files.push(file.path);fileDetails.push({path:file.path,bytes:file.bytes,role,truncatedRead:file.truncated});}
  }
  const [solverLog,meshLog,detailedMeshLog]=await Promise.all([
    boundedFile(base,join(base,'log.'+application),LOG_LIMIT,true),
    boundedFile(base,join(base,'log.checkMesh'),LOG_LIMIT,true),
    boundedFile(base,join(base,'log.checkMeshDetailed'),LOG_LIMIT,true),
  ]);
  remember(solverLog,'solver-log');remember(meshLog,'mesh-quality-log');
  remember(detailedMeshLog,'additional-geometry-diagnostics');
  const detailedMeshOkay=detailedMeshLog?(/\bMesh OK\b/.test(detailedMeshLog.text)&&!/Failed\s+[1-9]\d*\s+mesh checks|FOAM FATAL/i.test(detailedMeshLog.text)):null;
  if(detailedMeshOkay!==true)warnings.push('Additional allGeometry diagnostics are absent or contain warnings/failures (including cell concavity). Inspect log.checkMeshDetailed; passing mandatory safety limits does not resolve these diagnostics.');
  for(const name of ['manifest.json','log.surfaceCheck','log.snappyHexMesh','log.setFields']) {
    const meta=await regularFile(join(base,name));
    if(meta)remember({path:name,bytes:meta.size,truncated:false},name==='manifest.json'?'manifest':'stage-log');
  }
  const forceLocation=await latestOutput(base,options.forceObjectName??'hullForces',['force.dat','forces.dat']);
  const motionLocation=await latestOutput(base,options.motionObjectName??'rigidBodyState',['sixDoFRigidBodyState.dat']);
  const forceFile=forceLocation?.path?await boundedFile(base,forceLocation.path,RESULT_LIMIT):null;
  const motionFile=motionLocation?.path?await boundedFile(base,motionLocation.path,RESULT_LIMIT):null;
  remember(forceFile,'dimensional-force-history');remember(motionFile,'rigid-body-motion-history');
  const text=solverLog?.text??'',meshText=meshLog?.text??'';
  const times=observations(text,new RegExp(`^\\s*Time\\s*=\\s*(${NUMBER})\\s*$`,'gm')).map(x=>x.value).filter(x=>x!==null);
  const hasSolverEvidence=times.length>0||forceFile!==null||motionFile!==null;
  if(!hasSolverEvidence)throw new Error('No genuine OpenFOAM solver history was found. No force or motion results were created.');
  if(!solverLog)warnings.push('Solver log is missing; final-time completion and residual quality cannot be established.');
  if(solverLog?.truncated)warnings.push('Only the final5MB of the solver log were inspected. Full-history residual/phase bounds remain unverified; download the raw log.');
  if(meshLog?.truncated)warnings.push('Only the final5MB of checkMesh output were inspected.');
  const lastSolverTimeS=times.length?times[times.length-1]:null;
  const expectedEndTimeS=Number(manifest.numerics.durationS);
  const endMarkerObserved=/^\s*End\s*$/m.test(text);
  const completionTolerance=Math.max(1e-8,Math.abs(expectedEndTimeS)*1e-6);
  const completedTime=Number.isFinite(expectedEndTimeS)&&expectedEndTimeS>0&&lastSolverTimeS!==null&&lastSolverTimeS>=expectedEndTimeS-completionTolerance&&endMarkerObserved;
  if(!completedTime)warnings.push('The solver log does not establish completion of the requested final time with a normal End marker.');
  const failedMesh=/Failed\s+[1-9]\d*\s+mesh checks|FOAM FATAL|Mesh has failed/i.test(meshText);
  const gate=meshGate(meshText),onlyWallSkew=gate.tolerated;
  const meshOkay=meshLog?((/\bMesh OK\b/.test(meshText)&&!failedMesh)||onlyWallSkew):null;
  if(onlyWallSkew)warnings.push(`checkMesh flagged a few faces beyond its generic limits (hull-wall skewness above 4, or non-orthogonality up to snappyHexMesh's relaxed 75°): ${gate.softFaces} face${gate.softFaces===1?'':'s'} among ${gate.cells.toLocaleString('en-GB')} cells, within the accepted ${gate.limit}. No negative volumes, invalid tetrahedra or degenerate cells.`);
  const cellMatch=meshText.match(/^\s*cells\s*:\s*(\d+)\s*$/mi)??meshText.match(/number of cells\s*[:=]\s*(\d+)/i);
  const actualMeshCells=cellMatch?Number(cellMatch[1]):null;
  if(meshOkay!==true)warnings.push('A successful checkMesh summary is missing or failed. The numerical mesh has not passed this review.');

  const residuals=observations(text,/(?:Initial|Final)\s+residual\s*=\s*([^\s,;]+)/gi);
  const fatalObserved=/FOAM FATAL|Foam::sigFpe::sigHandler|Floating point exception\s*\(core dumped\)|Segmentation fault/i.test(text);
  const residualFailure=residuals.some(x=>x.value===null)||fatalObserved;
  let residualsFinite=residualFailure?false:solverLog?.truncated||!residuals.length?null:true;
  const alphaMin=observations(text,/min\(\s*alpha\.water\s*\)\s*=\s*([^\s,;]+)/gi);
  const alphaMax=observations(text,/max\(\s*alpha\.water\s*\)\s*=\s*([^\s,;]+)/gi);
  const alphaTolerance=1e-6;
  const invalidAlpha=[...alphaMin,...alphaMax].some(x=>x.value===null)||alphaMin.some(x=>x.value< -alphaTolerance)||alphaMax.some(x=>x.value>1+alphaTolerance);
  let alphaBounded=invalidAlpha?false:solverLog?.truncated||!alphaMin.length||!alphaMax.length?null:true;
  const deltaT=observations(text,/^\s*deltaT\s*=\s*([^\s,;]+)\s*$/gm);
  let invalidDeltaT=deltaT.some(x=>x.value===null||x.value<=0);
  let actualDeltaTS=range(deltaT.map(x=>x.value).filter(x=>x!==null&&x>0));
  // Long runs exceed the in-memory tail: stream the complete log so history-wide checks are real, not blank.
  let fullScan=null;
  if(solverLog?.truncated){
    try{fullScan=await scanFullLog(join(base,'log.'+application));}catch(error){warnings.push('Full solver log scan failed: '+error.message);}
    if(fullScan){
      residualsFinite=fullScan.residualInvalid||fullScan.fatal?false:fullScan.residualCount?true:null;
      const invalid=fullScan.alphaInvalid||fullScan.alphaMin< -alphaTolerance||fullScan.alphaMax>1+alphaTolerance;
      alphaBounded=invalid?false:fullScan.alphaMinCount&&fullScan.alphaMaxCount?true:null;
      invalidDeltaT=fullScan.deltaT.invalid;
      if(fullScan.deltaT.count)actualDeltaTS={minimum:fullScan.deltaT.minimum,maximum:fullScan.deltaT.maximum,last:actualDeltaTS?.last??null,count:fullScan.deltaT.count};
    }
  }
  if(residualsFinite!==true)warnings.push('Finite residuals across the full available solver history are not established. Finite residuals alone would not prove convergence.');
  if(alphaBounded!==true)warnings.push('Full-history alpha.water bounds in[0,1] within1e−6 are missing or violated.');
  if(invalidDeltaT)warnings.push('The solver log contains a nonfinite or nonpositive integration time step.');

  const wavePeriodS=manifest.condition?.kind==='calm'?null:Number(manifest.condition?.periodS);
  const wave=Number.isFinite(wavePeriodS)&&wavePeriodS>0;
  const waveDurationSufficient=wave?expectedEndTimeS>=10*wavePeriodS:null;
  const warmup=Number(manifest.numerics.recommendedWarmupS);
  // Calm towing averages the last 60% of the run (and never before the warmup): 30 s runs showed the drag of real hulls
  // settles after ~8-12 s, so a 40 L/U run averaged from 0.4 of its length is within a few percent of the settled value.
  const averagingTargetStartTimeS=wave?Math.max(expectedEndTimeS*.5,5*wavePeriodS,Number.isFinite(warmup)?warmup:0):Math.max(expectedEndTimeS*.4,Number.isFinite(warmup)?warmup:0);
  let forces=null,forceSampleCount=0,lastForceTimeS=null;
  if(forceLocation?.restartSegments>1)warnings.push('Multiple force restart directories exist. Only the latest numeric start segment was read; older data were not merged or substituted.');
  if(forceLocation&&!forceLocation.path)warnings.push('The latest force restart directory has no dimensional force file. Older segments were not substituted.');
  if(forceFile?.truncated)warnings.push('Force history exceeds64MB and was not partially parsed. Download the raw data or export a bounded history.');
  if(forceFile?.text) {
    try {
      const series=parseForceData(forceFile.text,{sourceFile:forceFile.path});
      forceSampleCount=series.samples.length;lastForceTimeS=series.samples[series.samples.length-1]?.timeS??null;
      if(wave&&waveDurationSufficient!==true)throw new Error('Wave run is shorter than10 peak periods; a post-startup force statistic is withheld.');
      const start=Math.max(averagingTargetStartTimeS,series.samples[0]?.timeS??0);
      const end=Math.min(expectedEndTimeS,lastForceTimeS??expectedEndTimeS);
      forces=summarizeForces(series,{startTimeS:start,endTimeS:end,minSamples:20});
      warnings.push(...forces.warnings);
    } catch(error){warnings.push('Force statistics unavailable: '+error.message);}
  } else if(!forceFile)warnings.push('No dimensional force output was found in the latest hullForces segment.');
  const forceCoverageComplete=lastForceTimeS!==null&&lastForceTimeS>=expectedEndTimeS-completionTolerance;
  if(!forceCoverageComplete)warnings.push('The dimensional force history does not reach the requested final time.');

  let motion=null,motionSampleCount=0;
  const freeMotion=manifest.mode==='free-motion';
  if(motionLocation?.restartSegments>1)warnings.push('Only the latest rigid-body motion restart segment was read; no segment merging was attempted.');
  if(motionFile?.truncated)warnings.push('Motion history exceeds64MB and was not partially parsed.');
  if(motionFile?.text&&typeof parseMotionData==='function') {
    try {
      const reference=manifest.load?.solverCgM;
      const series=parseMotionData(motionFile.text,{sourceFile:motionFile.path,...(Array.isArray(reference)?{referenceCentreOfMassM:reference}:{}),
        ...(manifest.motion?.initialOrientation?{initialOrientation:manifest.motion.initialOrientation}:{}),
        ...(manifest.motion?.rollAxis?{rollAxis:manifest.motion.rollAxis}:{})});
      motionSampleCount=series.samples.length;
      if(wave&&waveDurationSufficient!==true)throw new Error('Wave run is shorter than10 peak periods; post-startup motion extrema are withheld.');
      const selected=series.samples.filter(s=>s.timeS>=averagingTargetStartTimeS&&s.timeS<=expectedEndTimeS);
      if(selected.length<20)throw new Error(`Only${selected.length} motion samples occur after startup; at least20 are required.`);
      const max=(key)=>selected.reduce((a,s)=>Math.max(a,Math.abs(s[key])),0);
      const first=selected[0].timeS,last=selected[selected.length-1].timeS,mid=(first+last)/2;
      const rollRmsDeg=timeWeightedRms(selected,'rollDeg'),heaveRmsM=timeWeightedRms(selected,'heaveM');
      const firstHalfRollRmsDeg=timeWeightedRms(selected,'rollDeg',first,mid),secondHalfRollRmsDeg=timeWeightedRms(selected,'rollDeg',mid,last);
      const rmsScale=Math.max(firstHalfRollRmsDeg??0,secondHalfRollRmsDeg??0);
      const rollRmsRelativeDrift=rmsScale>.01&&Number.isFinite(firstHalfRollRmsDeg)&&Number.isFinite(secondHalfRollRmsDeg)?Math.abs(firstHalfRollRmsDeg-secondHalfRollRmsDeg)/rmsScale:null;
      const rollRmsDriftTolerance=.1,rollRmsDriftWithinTolerance=rollRmsRelativeDrift===null?null:rollRmsRelativeDrift<=rollRmsDriftTolerance;
      motion={source:'OpenFOAM',sourceFile:motionFile.path,format:series.format,sampleCount:selected.length,totalSampleCount:series.samples.length,
        averagingStartTimeS:selected[0].timeS,averagingEndTimeS:selected[selected.length-1].timeS,
        rollRmsDeg,heaveRmsM,firstHalfRollRmsDeg,secondHalfRollRmsDeg,rollRmsRelativeDrift,rollRmsDriftTolerance,rollRmsDriftWithinTolerance,
        maxAbsRollDeg:max('rollDeg'),maxAbsPitchDeg:max('pitchDeg'),maxAbsYawDeg:max('yawDeg'),maxAbsHeaveM:max('heaveM'),
        minimumHeaveM:selected.reduce((a,s)=>Math.min(a,s.heaveM),Infinity),maximumHeaveM:selected.reduce((a,s)=>Math.max(a,s.heaveM),-Infinity),
        heaveReference:series.heaveReference,referenceCentreOfMassM:series.referenceCentreOfMassM,
        orientationReference:series.orientationReference??null,initialOrientation:series.initialOrientation??null,rollReference:series.rollReference??null,rollAxis:series.rollAxis??null,
        warnings:series.warnings,validation:'unverified'};
      warnings.push(...series.warnings);
      if(rollRmsDriftWithinTolerance!==true)warnings.push('Post-startup RMS roll is not stationary within 10%, or the response is too small for a reliable relative-drift diagnostic.');
    } catch(error){warnings.push('Motion statistics unavailable: '+error.message);}
  } else if(freeMotion)warnings.push('Free-motion run has no supported sixDoFRigidBodyState history. No motion values were substituted.');

  let waves=null;
  if(wave){
    try{
      const gaugeLocation=await latestOutput(base,'waveGauges',['position.dat']);
      const gaugeFile=gaugeLocation?.path?await boundedFile(base,gaugeLocation.path,RESULT_LIMIT):null;
      remember(gaugeFile,'wave-gauge-history');
      if(gaugeFile?.text){
        waves=analyseWaveGauges(gaugeFile.text,{startS:averagingTargetStartTimeS,endS:expectedEndTimeS,targetHeightM:Number(manifest.condition?.heightM),targetPeriodS:wavePeriodS,wavelengthM:Number(manifest.waves?.waveLengthM),direction:manifest.waves?.propagationDirection??null});
        if(waves?.withinTolerance===false)warnings.push(`Achieved waves differ from the requested regular wave: ${waves.heightMethod==='mean of gauges'?'height':'incoming (incident) wave height'} ${(100*waves.heightRatio).toFixed(0)}% and period ${(100*waves.periodRatio).toFixed(0)}% of target (tolerance ±${100*WAVE_HEIGHT_TOLERANCE}% height, ±${100*WAVE_PERIOD_TOLERANCE}% period).${waves.reflectionCoefficient!==null?` The hull reflects/radiates ${(100*waves.reflectionCoefficient).toFixed(0)}% of the incoming wave back toward the wave-maker.`:' Without incident/reflected separation the reading includes waves the hull reflects and radiates.'} Check the gauge histories.`);
      }else warnings.push('No wave-gauge history was found; the achieved wave height was not verified.');
    }catch(error){warnings.push('Wave gauge analysis failed: '+error.message);}
  }
  // Rim / deck-edge immersion: conservative relative-motion estimate at the side of the hull. Open (printed) hulls are
  // simulated with a virtual lid at the rim, so water that would come over the side is reported here instead.
  let rimImmersion=null;
  if(wave&&motion&&Number.isFinite(hydro?.freeboardM)){
    const halfBeam=(manifest.geometry.maxM[1]-manifest.geometry.minM[1])/2,rollRad=(motion.maxAbsRollDeg??0)*Math.PI/180;
    const heaveAmp=Number.isFinite(motion.heaveRmsM)?Math.SQRT2*motion.heaveRmsM:0,waveAmp=(waves?.heightM??Number(manifest.condition?.heightM)??0)/2;
    const demandM=Math.sin(rollRad)*halfBeam+heaveAmp+waveAmp;
    rimImmersion={freeboardM:hydro.freeboardM,demandM,margin:hydro.freeboardM-demandM,risk:demandM>=hydro.freeboardM};
    if(rimImmersion.risk)warnings.push(`The side of the hull (rim or deck edge) would dip under the water: roll, heave and wave together reach about ${(demandM*1000).toFixed(1)} mm against ${(hydro.freeboardM*1000).toFixed(1)} mm of freeboard. An open hull would take on water; treat this run as a swamping risk.`);
  }
  const forceHistoryDrift=forces?.driftWithinTolerance??null;
  const quality={waveAchieved:wave?(waves?.withinTolerance??null):null,meshOkay,detailedMeshOkay,completedTime,alphaBounded,residualsFinite,forceHistoryDrift,forceCoverageComplete,motionRmsDrift:motion?.rollRmsDriftWithinTolerance??null,
    timeStepsValid:invalidDeltaT?false:deltaT.length?true:null,waveDurationSufficient,
    convergence:'not-demonstrated',physicalValidation:'not-performed',rankable:false};
  const responseHistoryStable=freeMotion?motion?.rollRmsDriftWithinTolerance===true:forceHistoryDrift===true;
  const numericalReviewComplete=meshOkay===true&&detailedMeshOkay===true&&completedTime&&alphaBounded===true&&residualsFinite===true&&responseHistoryStable&&forceCoverageComplete&&!!forces&&(!freeMotion||!!motion)&&!invalidDeltaT;
  warnings.push('A completed solver run and finite histories are not experimental validation. Mesh, time-step and domain convergence remain to be demonstrated; this run is not eligible for automatic placement.');
  return {
    schemaVersion:1,source:'OpenFOAM',status:numericalReviewComplete?'completed-unverified':'incomplete-unverified',caseId:manifest.caseId,
    geometryHash:geometryHash??null,protocolHash:protocolHash??null,manifest,hydro,forces,motion,waves,rimImmersion,quality,
    solverRun:{application,solverVersion:manifest.solver.version,actualMeshCells,lastSolverTimeS,expectedEndTimeS,endMarkerObserved,forceSampleCount,motionSampleCount,lastForceTimeS,actualDeltaTS,
      averagingTargetStartTimeS,alphaObservations:{minimum:alphaMin.filter(x=>x.value!==null).reduce((m,x)=>Math.min(m,x.value),Infinity)===Infinity?null:alphaMin.filter(x=>x.value!==null).reduce((m,x)=>Math.min(m,x.value),Infinity),maximum:alphaMax.filter(x=>x.value!==null).reduce((m,x)=>Math.max(m,x.value),-Infinity)===-Infinity?null:alphaMax.filter(x=>x.value!==null).reduce((m,x)=>Math.max(m,x.value),-Infinity),minCount:alphaMin.length,maxCount:alphaMax.length,tolerance:alphaTolerance},
      logCoverage:solverLog?.truncated?(fullScan?'complete-file-streamed':'tail-only'):solverLog?'complete-file':'missing',fullLogLines:fullScan?.lines??null},
    raw:{files:files.sort(),fileDetails:fileDetails.sort((a,b)=>a.path.localeCompare(b.path))},warnings:[...new Set(warnings)],
  };
}
