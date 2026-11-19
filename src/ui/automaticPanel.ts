import {buildXlsx,type Sheet,type Cell} from '../xlsx';
import type {CfdSelection} from './cfdPanel';
import {cfdLeaderboard} from '../cfd/leaderboard';

type RecordValue=Record<string,unknown>;
const record=(v:unknown):RecordValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:{};
const list=(v:unknown):RecordValue[]=>Array.isArray(v)?v.map(record):[];
const finite=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
/** Escaped text with line-break points after underscores. */
const breakable=(v:string)=>esc(v).replace(/_/g,'_<wbr>');
/** Study mode as shown to people. */
export const speedLabel=(speed:unknown)=>speed==='quick'?'Quick':speed==='mesh-check'?'Mesh check (verification)':'Full';
const text=(v:unknown)=>v===undefined||v===null?'':typeof v==='string'?v:JSON.stringify(v);
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const display=(v:unknown,d=3)=>finite(v)===null?'—':(v as number).toFixed(d);
/** Numbers from the most refined finished run while a test is still running (shown as provisional). */
function provisional(c:RecordValue):{metrics:RecordValue,phase:string|null}{
  const runs=list(c.runs);
  for(const phase of ['fine','medium','coarse']){
    const run=runs.find(r=>r.phase===phase&&r.status==='completed'&&r.result);if(!run)continue;
    const res=record(run.result),forces=record(res.forces),motion=record(res.motion),hydro=record(res.hydro),waves=record(res.waves),rim=record(res.rimImmersion);
    return {phase,metrics:{meanDragN:forces.meanDragN,rollRmsDeg:motion.rollRmsDeg,maxRollDeg:motion.maxAbsRollDeg,initialBuoyancyN:hydro.buoyancyN,waveHeightRatio:waves.heightRatio,wavePeriodRatio:waves.periodRatio,waveAchieved:waves.withinTolerance,rimImmersionRisk:rim.risk}};
  }
  return {metrics:{},phase:null};
}
/** One small chip per solver run of a test: done, failed, waiting for a node, or live percent. */
function runChips(c:RecordValue):string{
  const runs=list(c.runs).filter(r=>typeof r.phase==='string');if(!runs.length)return '';
  return `<span class="auto-runs">${runs.map(r=>{
    const live=record(r.live),st=String(r.status??''),pct=finite(live.percent);
    const [cls,label]=st==='completed'?['done','✓']:st==='skipped'?['skip','skipped']:['failed','blocked','interrupted','cancelled'].includes(st)?['bad','✗']
      :String(live.slurmState)==='PENDING'||live.status==='queued'?['wait','waiting for a node']:live.status==='solving'&&pct!==null&&pct>0?['live',`${Math.round(pct)}%`]:['live','meshing'];
    return `<span class="auto-run-chip ${cls}" title="${esc(String(live.stage??st))}">${esc(String(r.phase))} ${esc(label)}</span>`;}).join('')}</span>`;
}
const scaled=(v:unknown,scale:number)=>finite(v)===null?null:(v as number)*scale;
const terminal=(status:unknown)=>['completed','failed','cancelled','interrupted'].includes(String(status));

export const AUTO_LOADS=[150,250,350] as const;
export const AUTO_TESTS=[{id:'calm',label:'Calm tow'},{id:'medium',label:'Medium waves'},{id:'high',label:'High waves'}] as const;
export const AUTO_CONDITION_IDS=AUTO_LOADS.flatMap(g=>AUTO_TESTS.map(t=>`${g}g-${t.id}`));
export type AutoSpeed='quick'|'full';
export interface AutoChoice {speed:AutoSpeed;cores:number|null;conditions:string[]}
export const DEFAULT_AUTO_CHOICE:AutoChoice={speed:'quick',cores:null,conditions:['250g-calm']};
const CHOICE_KEY='hull-test-bench.auto-choice.v1';
/** Solver runs the study will start: Quick = 1 per condition; Full = 3 per calm test (coarse/medium/time-step), 1 per wave test. */
export function plannedSolves(choice:AutoChoice){return choice.conditions.reduce((n,id)=>n+(choice.speed==='quick'?1:String(id).endsWith('calm')?3:1),0);}
export function normaliseChoice(value:unknown):AutoChoice{
  const v=record(value),known=new Set(AUTO_CONDITION_IDS);
  const conditions=Array.isArray(v.conditions)?[...new Set(v.conditions.map(String).filter(id=>known.has(id)))]:DEFAULT_AUTO_CHOICE.conditions;
  const cores=typeof v.cores==='number'&&Number.isInteger(v.cores)&&v.cores>0?v.cores:null;
  return {speed:v.speed==='full'?'full':'quick',cores,conditions:AUTO_CONDITION_IDS.filter(id=>conditions.includes(id))};
}
function loadChoice():AutoChoice{try{const raw=localStorage.getItem(CHOICE_KEY);return raw?normaliseChoice(JSON.parse(raw)):{...DEFAULT_AUTO_CHOICE};}catch{return {...DEFAULT_AUTO_CHOICE};}}
function saveChoice(choice:AutoChoice){try{localStorage.setItem(CHOICE_KEY,JSON.stringify(choice));}catch{/* per-browser convenience only */}}
export function formatDuration(seconds:unknown):string{
  const s=finite(seconds);if(s===null)return '—';
  if(s<60)return `${Math.max(0,Math.round(s))} s`;
  if(s<3600)return `${Math.round(s/60)} min`;
  const h=Math.floor(s/3600),m=Math.round((s-h*3600)/60);return m?`${h} h ${m} min`:`${h} h`;
}

/** Only send the selected CAD and which tests to run. The server owns the shared test protocol and its assumptions. */
export function buildAutomaticStudyRequest(selection:CfdSelection,choice?:AutoChoice):{name:string;trianglesMm:number[];conditionIds?:string[];speed?:AutoSpeed;cores?:number} {
  if(!selection.trianglesMm.length||selection.trianglesMm.length%9!==0)throw new Error('Choose a complete triangular STL first.');
  if(!selection.sizeMm.every(v=>Number.isFinite(v)&&v>0))throw new Error('Check the STL dimensions and orientation first.');
  if(selection.sizeMm.some(v=>v>250.0001))throw new Error('The hull exceeds the 250 × 250 × 250 mm build volume. Correct its size or STL units first.');
  if(selection.trianglesMm.some(v=>!Number.isFinite(v)))throw new Error('The STL contains invalid coordinates.');
  const base={name:selection.name,trianglesMm:Array.from(selection.trianglesMm)};
  if(!choice)return base;
  if(!choice.conditions.length)throw new Error('Tick at least one test to run.');
  return {...base,conditionIds:[...choice.conditions],speed:choice.speed,...(choice.cores?{cores:choice.cores}:{})};
}

/** Export partial and completed studies without substituting values for missing solver output. */
export function automaticStudySheets(value:unknown):Sheet[] {
  const study=record(value),plan=record(study.plan),conditions=list(study.conditions);
  const results:Cell[][]=[['Condition','Total mass (g)','Test','Wave H (mm)','Period (s)','Status','Numerical sensitivity passed','Mean towing resistance (N)','Roll RMS (deg)','Maximum roll (deg)','Initial buoyancy (N)','Initial GM (mm)','Initial freeboard (mm)','Achieved wave height (% of target)','Achieved wave period (% of target)','Issue']];
  const checks:Cell[][]=[['Condition','Check','Passed','Relative change','Threshold','Reason']];
  const assumptions:Cell[][]=[['Field','Value'],['Study',text(study.id)],['Speed',record(study.options).speed==='quick'?'Quick (1 coarse solve per test, shortened run; rough)':'Full (calm: coarse, medium mesh, half time step; waves: one run as in Quick)'],['Design',text(study.name)],['Status',text(study.status)],['Protocol',text(plan.protocol)],['Geometry',text(plan.geometryMode)],['Mass distribution',text(plan.distribution)],['Mass source','Standard test loads, not measured ship weights'],['CG and inertia source','CAD estimates under the recorded distribution'],['Physical validation','Not performed; numerical agreement is not an accuracy certificate'],['Ranking','No validated placement assigned'],['Wall-resolution length (m)',finite(plan.minimumWallThicknessM)],...(['geometryNotes','assumptions'] as const).flatMap(key=>(Array.isArray(plan[key])?plan[key] as unknown[]:[]).map(v=>[key==='assumptions'?'Assumption':'Geometry note',text(v)] as Cell[]))];
  const runs:Cell[][]=[['Condition','Phase','Job','Status','Field','Value']];
  for(const condition of conditions){
    const result=record(condition.result),metrics=record(result.metrics);
    results.push([text(condition.label??condition.id),scaled(condition.massKg,1000),text(condition.mode),scaled(condition.waveHeightM,1000),finite(condition.wavePeriodS),text(condition.status),result.quick===true?'Not checked (quick run)':result.numericalSensitivityPassed===true?'Yes':result.numericalSensitivityPassed===false?'No':'Not established',condition.mode==='calm'?finite(metrics.meanDragN):null,finite(metrics.rollRmsDeg),finite(metrics.maxRollDeg),finite(metrics.initialBuoyancyN),scaled(metrics.initialGmM,1000),scaled(metrics.freeboardM,1000),scaled(metrics.waveHeightRatio,100),scaled(metrics.wavePeriodRatio,100),[text(record(condition.hint).title),text(condition.error)].filter(Boolean).join(': ')]);
    for(const check of list(result.checks))checks.push([text(condition.label??condition.id),text(check.name),check.passed===true?'Yes':check.passed===false?'No':'Not established',finite(check.relativeChange),finite(check.threshold),text(check.reason)]);
    for(const run of list(condition.runs)){
      const output=record(run.result),manifest=record(output.manifest),load=record(manifest.load),motion=record(manifest.motion);
      const fields:RecordValue={error:run.error,geometryHash:output.geometryHash??manifest.sourceHash,protocolHash:output.protocolHash??manifest.protocolKey,load,motion,condition:manifest.condition,numerics:manifest.numerics,mesh:manifest.mesh,quality:output.quality,forces:output.forces,motionResults:output.motion};
      for(const [field,v] of Object.entries(fields))if(v!==undefined)runs.push([text(condition.label??condition.id),text(run.phase),text(run.jobId),text(run.status),field,typeof v==='number'?v:text(v)]);
    }
  }
  return [
    {name:'Automatic test results',rows:results,widths:[34,18,19,18,15,18,25,28,22,25,24,22,25,22,22,70],freezeRows:1},
    {name:'Numerical checks',rows:checks,widths:[34,32,20,22,20,100],freezeRows:1},
    {name:'Assumptions',rows:assumptions,widths:[35,130],freezeRows:1},
    {name:'Solver run metadata',rows:runs,widths:[34,18,40,18,26,130],freezeRows:1},
  ];
}

/** Wall-clock time of day for an ISO timestamp, e.g. "14:35" (adds the weekday when not today). */
export function clockTime(iso:unknown,now=new Date()):string{
  if(typeof iso!=='string')return '';
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';
  const time=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toDateString()===now.toDateString()?time:`${d.toLocaleDateString([],{weekday:'short'})} ${time}`;
}
/** Review label: names the first failed Full-mode check (e.g. "Mesh sensitivity 33% (limit 5%)") instead of a bare "Review needed". */
export function reviewText(result:Record<string,unknown>):string{
  if(result.quick===true)return 'Quick result (rough)';
  if(result.numericalSensitivityPassed===true)return 'Sensitivity checks passed';
  const failed=list(result.checks).find(c=>c.passed!==true);
  if(!failed)return 'Review needed';
  const change=finite(failed.relativeChange),limit=finite(failed.threshold);
  return change!==null?`${text(failed.name)} ${Math.round(100*Math.abs(change))}%${limit!==null?` (limit ${Math.round(100*limit)}%)`:''}`:`Check failed: ${text(failed.name)}`;
}
/** One comparison sheet across every hull study (competition entries side by side). */
export function allStudiesSheet(studies:unknown[]):Sheet{
  const rows:Cell[][]=[['Hull','Study started','Speed','Condition','Total mass (g)','Test','Wave H (mm)','Period (s)','Status','Mean towing resistance (N)','Roll RMS (deg)','Maximum roll (deg)','Heave RMS (mm)','Initial buoyancy (N)','Initial GM (mm)','Initial freeboard (mm)','Achieved wave height (% of target)','Rim/deck edge dips under','Mesh cells','Review','Issue','Study ID']];
  for(const value of studies){
    const study=record(value),speed=speedLabel(record(study.options).speed);
    for(const c of list(study.conditions)){
      const result=record(c.result),m=record(result.metrics),hint=record(c.hint);
      const review=hint.verdict==='stability-failure'?'Stability failure':hint.verdict==='sinks'?'Sinks under this load':c.status==='completed'?reviewText(result):text(c.status);
      rows.push([text(study.name),text(study.createdAt),speed,text(c.label??c.id),scaled(c.massKg,1000),c.mode==='calm'?'Calm tow':'Beam waves',scaled(c.waveHeightM,1000),finite(c.wavePeriodS),text(c.status),c.mode==='calm'?finite(m.meanDragN):null,finite(m.rollRmsDeg),finite(m.maxRollDeg),scaled(m.heaveRmsM,1000),finite(m.initialBuoyancyN),scaled(m.initialGmM,1000),scaled(m.freeboardM,1000),scaled(m.waveHeightRatio,100),m.rimImmersionRisk===true?'Yes':m.rimImmersionRisk===false?'No':'',finite(m.actualMeshCells),review,[text(hint.title),text(c.error)].filter(Boolean).join(': '),text(study.id)]);
    }
  }
  return {name:'All hulls',rows,widths:[28,22,10,30,14,12,12,10,14,22,14,16,14,18,14,18,20,18,14,24,70,38],freezeRows:1};
}

/** Hackathon ranking sheet: drag + roll + stability from the CFD results, with fairness status per hull. */
export function rankingSheet(studies:unknown[]):Sheet{
  const {rows,reference,conditionIds}=cfdLeaderboard(studies);
  const out:Cell[][]=[['Place','Hull','Status','Mean calm drag (mN)','Mean max roll (deg)','Mean initial GM (mm)','Failed tests (sinks/capsizes)','Drag score','Roll score','Stability score','Total score','Settings','Note']];
  for(const r of rows)out.push([r.place,r.name,r.status==='ranked'?'Ranked':r.status==='incomplete'?'Incomplete':'Different settings',r.dragMN,r.rollDeg,r.gmMm,r.failures,r.scoreDrag,r.scoreRoll,r.scoreStability,r.total,r.settingsLabel,r.note]);
  out.push([]);
  out.push(['Rules','Only hulls tested with identical settings and the same tests are ranked together.'+(reference?` Reference settings: ${reference.speed==='quick'?'Quick':'Full'}, ${reference.backend}, ${reference.cores??'?'} cores, setup ${reference.protocol}. Tests: ${conditionIds.join(', ')}.`:'')]);
  out.push(['','The best hull in each category scores 100 and the rest in proportion (drag and roll: lower is better; stability = initial GM: higher is better). Total = average. Hulls that sink or capsize in any test rank below all hulls without failures. CFD numbers are unvalidated screening results.']);
  return {name:'Ranking',rows:out,widths:[8,28,18,18,18,18,16,12,12,14,12,48,80],freezeRows:1};
}
function rankingHtml(studies:unknown[]):string{
  const {rows,reference}=cfdLeaderboard(studies);
  if(!rows.length)return '';
  const n=(v:number|null,d=1)=>v===null?'—':v.toFixed(d);
  const status=(r:(typeof rows)[number])=>r.status==='ranked'?(r.failures?`<small class="auto-rank-bad">${r.failures} failed</small>`:''):`<small class="auto-rank-bad">${r.status==='incomplete'?'Incomplete':'Different settings'}</small>`;
  const ranked=rows.filter(r=>r.status==='ranked').length,waiting=rows.filter(r=>r.status==='incomplete').length,provisional=!!(waiting&&ranked);
  return `<details class="cfd-advanced auto-ranking" open><summary>Hackathon ranking (${provisional?`provisional: ${ranked} of ${ranked+waiting} hulls finished`:`${ranked} ranked`})</summary>${provisional?`<p class="cfd-note auto-rank-bad">Points are relative to the best finished hull in each column, so they change as the other hulls finish.</p>`:''}<div class="auto-table-wrap"><table class="auto-queue-table auto-rank-table"><thead><tr><th>#</th><th>Hull</th><th>Calm drag<br>mN</th><th>Max roll<br>deg</th><th>GM<br>mm</th><th>Score</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.place===1&&rows.length>1&&!provisional?'auto-rank-first':''}" title="${esc(r.note||r.settingsLabel)}"><td>${r.place??'—'}</td><td><b>${breakable(r.name)}</b>${status(r)}</td><td>${n(r.dragMN,2)}<small>${n(r.scoreDrag,0)} pts</small></td><td>${n(r.rollDeg)}<small>${n(r.scoreRoll,0)} pts</small></td><td>${n(r.gmMm)}<small>${n(r.scoreStability,0)} pts</small></td><td><b>${n(r.total,0)}</b></td></tr>`).join('')}</tbody></table></div><p class="cfd-note">${reference?`Ranked together: ${esc(reference.speed==='quick'?'Quick':'Full')} · ${esc(reference.backend==='cluster'?'cluster':'this computer')} · ${reference.cores??'?'} cores · setup ${esc(reference.protocol)}. `:''}Score = average of calm drag, max roll and stability (GM), one third each; the best hull in each category gets 100 points and the rest in proportion. A hull that sinks or capsizes in any test ranks below all hulls without failures. Hover a row for details. CFD results are screening values, not validated measurements.</p></details>`;
}

export interface AutomaticPanelOptions {
  button?:HTMLElement|null;
  getSelection:()=>CfdSelection|null;
  /** Every uploaded hull, for queueing the same tests on all competition entries. */
  getAll?:()=>CfdSelection[];
  openAdvanced:()=>void;
}

/** One-button shared protocol. The detailed manual controls remain available separately. */
export function attachAutomaticPanel(options:AutomaticPanelOptions){
  const dialog=document.createElement('dialog');
  dialog.className='cfd-dialog automatic-dialog';
  dialog.setAttribute('aria-label','Automatic OpenFOAM hull tests');
  document.body.appendChild(dialog);
  let selected:CfdSelection|null=null,study:RecordValue|null=null,available=false,alive=true,submitting=false;
  let timer=0,checking=false;
  let choice=loadChoice(),maxCores=1,defaultCores=1,backend:'local'|'cluster'='local',clusterHost='';
  let stream:EventSource|null=null,streamJob:string|null=null,logLines=0;
  const LOG_LIMIT=2000;
  let estimate:RecordValue|null=null,estimateKey='',estimateTimer=0,estimateSeq=0;
  let queue:RecordValue|null=null,studies:RecordValue[]=[],queueTimer=0,queueBusy=false;
  const seenStatus=new Map<string,string>(),baseTitle=document.title;
  const get=<T extends HTMLElement>(id:string)=>dialog.querySelector<T>(`#${id}`)!;
  const button=options.button;
  async function api(path:string,init?:RequestInit):Promise<RecordValue>{
    const response=await fetch(path,{...init,headers:{'Content-Type':'application/json',...init?.headers}});
    let data:RecordValue;
    try{data=record(await response.json());}catch{throw new Error('Start the downloaded app with npm run cfd, then open its local URL. The hosted preview cannot run OpenFOAM.');}
    if(!response.ok)throw new Error(String(data.error??data.message??`Request failed (${response.status})`));
    return data;
  }
  function error(message:string){get('auto-error').textContent=message;}
  const estimateFor=(id:string)=>list(estimate?.conditions).find(c=>c.id===id)??null;
  const designVerdict=(e:RecordValue|null)=>!!e&&e.blocked===true&&['sinks','stability-failure'].includes(String(record(e.hint).verdict));
  const runnable=()=>choice.conditions.filter(id=>estimateFor(id)?.blocked!==true||designVerdict(estimateFor(id)));
  const selectedEstimateS=()=>{if(!estimate)return null;let t=0;for(const id of runnable()){const e=estimateFor(id);if(!e)return null;const p=finite(e.predictedS)??0;t=backend==='cluster'?Math.max(t,p):t+p;}return t;};
  function setActions(){
    const count=runnable().length,blocked=choice.conditions.length-count,queueActive=!!queue&&finite(queue.studies)!==null&&(queue.studies as number)>0;
    const est=selectedEstimateS(),runBtn=get<HTMLButtonElement>('auto-run');
    runBtn.disabled=!selected||!available||submitting||!count;
    runBtn.textContent=submitting?'Preparing tests…':count?`${queueActive?'Add to queue':'Run'}: ${count} test${count===1?'':'s'} (${choice.speed==='quick'?'Quick':'Full'})${est!==null?` · ≈ ${formatDuration(est)}`:''}`:blocked?'Ticked tests cannot run':'Tick a test to run';
    const all=options.getAll?.()??[],batch=dialog.querySelector<HTMLButtonElement>('#auto-batch');
    if(batch){batch.hidden=all.length<2;batch.disabled=!available||submitting||!count;batch.textContent=`Queue these tests for all ${all.length} loaded hulls`;}
  }
  function download(bytes:Uint8Array,name:string,mime:string){
    const url=URL.createObjectURL(new Blob([bytes as unknown as BlobPart],{type:mime})),a=document.createElement('a');a.href=url;a.download=name;a.click();window.setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function etaText(value:RecordValue):string{
    const eta=record(value.eta);
    if(terminal(value.status))return '';
    if(value.status==='queued'&&finite(value.queuePosition)!==null){
      const starts=finite(eta.startsInS);return `Queued #${value.queuePosition}${starts!==null?` · starts in ≈ ${formatDuration(starts)}`:''}${finite(eta.remainingS)!==null?` · takes ≈ ${formatDuration(eta.remainingS)}`:''}`;
    }
    if(eta.estimating===true||finite(eta.remainingS)===null)return 'Estimating time…';
    return `≈ ${formatDuration(eta.remainingS)} left${eta.finishAt?` · done around ${clockTime(eta.finishAt)}`:''}${typeof eta.slowest==='string'&&eta.slowest?` · slowest: ${eta.slowest}`:''}`;
  }
  function renderStudy(){
    if(!dialog.open)return;
    if(!study){get('auto-study').innerHTML='';return;}
    const plan=record(study.plan),progress=record(study.progress),conditions=list(study.conditions),active=!terminal(study.status);
    const total=finite(progress.solvesMaximum)??60,done=finite(progress.solvesFinished)??0,conditionCount=finite(progress.conditionsTotal)??conditions.length,finished=finite(progress.conditionsFinished)??0;
    const notes=[...(Array.isArray(plan.geometryNotes)?plan.geometryNotes:[]),...(Array.isArray(plan.assumptions)?plan.assumptions:[])];
    const assumptionsOpen=get('auto-study').querySelector<HTMLDetailsElement>('details')?.open===true;
    const unfinished=conditions.filter(c=>['failed','interrupted','cancelled'].includes(String(c.status))).length;
    const speed=speedLabel(record(study.options).speed),eta=etaText(study),overall=finite(record(study.overall).percent);
    get('auto-study').innerHTML=`<div class="auto-study-heading"><div><b>${breakable(String(study.name??'Hull study'))}</b><span>${esc(speed)} · ${esc(study.status)} · ${esc(study.stage??'')}</span>${eta?`<span class="auto-eta">${esc(eta)}</span>`:''}</div><div class="auto-study-actions">${active?`<button type="button" class="btn small" id="auto-cancel">${study.status==='queued'?'Remove from queue':'Stop tests'}</button>`:''}${!active&&unfinished?`<button type="button" class="btn small" id="auto-rerun">Re-run ${unfinished} unfinished test${unfinished===1?'':'s'}</button>`:''}</div></div><progress aria-label="Computing done" value="${overall??done}" max="${overall!==null?100:Math.max(total,1)}"></progress><p class="cfd-note">${overall!==null?`${Math.round(overall)}% of the computing done · `:''}${finished} / ${conditionCount} tests finished · ${done} / ${total} solver runs. Numbers appear as soon as the first run of a test finishes (marked provisional until every check is done). Failed or unsuitable tests are recorded and skipped.</p>${study.error?`<p class="cfd-error">${esc(study.error)}</p>`:''}<div class="auto-table-wrap"><table class="auto-results"><caption>Actual solver results · no validated placement assigned</caption><thead><tr><th>Test</th><th>Resistance</th><th>Roll RMS</th><th>Wave achieved</th><th>Initial buoyancy</th><th>Review</th></tr></thead><tbody>${conditions.map(c=>{
      const outcome=record(c.result),early=provisional(c),final=Object.keys(record(outcome.metrics)).length>0,metrics=final?record(outcome.metrics):early.metrics,hint=record(c.hint);
      const verdict=String(hint.verdict??'');
      const review=verdict==='stability-failure'?'Stability failure':verdict==='sinks'?'Sinks under this load':!final&&early.phase?`Provisional · ${early.phase} mesh`:c.status==='completed'?reviewText(outcome):String(c.status??'pending');
      const swamp=metrics.rimImmersionRisk===true?'<small class="auto-row-error">⚠ Rim/deck edge dips under: would take on water</small>':'';
      const problem=hint.title?`<small class="auto-row-error"><b>${esc(hint.title)}.</b> ${esc(hint.hint)}</small><details class="auto-raw"><summary>Technical detail</summary><small>${esc(c.error??'')}</small></details>`:c.error?`<small class="auto-row-error">${esc(c.error)}</small>`:'';
      return `<tr><td><b>${esc(c.label??c.id)}</b>${c.status==='running'||c.status==='pending'?runChips(c):''}${problem}</td><td>${c.mode==='calm'?(finite(metrics.meanDragN)!==null?`${display((metrics.meanDragN as number)*1000,2)} <small>mN</small>`:'—'):'—'}</td><td>${finite(metrics.rollRmsDeg)!==null?`${display(metrics.rollRmsDeg,2)}°`:'—'}</td><td>${c.mode==='calm'?'—':finite(metrics.waveHeightRatio)!==null?`<span class="${metrics.waveAchieved===false?'auto-row-error':''}" title="Measured at the wave gauges: height ${display((metrics.waveHeightRatio as number)*100,0)}%, period ${display((finite(metrics.wavePeriodRatio)??NaN)*100,0)}% of the requested wave. Measured as the incoming wave, separated from the waves the hull reflects and radiates (older results: plain gauge mean, which reads high beside a strongly reflecting hull). ⚠ marks readings outside ±10% height / ±5% period.">${display((metrics.waveHeightRatio as number)*100,0)}% H${metrics.waveAchieved===false?' ⚠':''}</span>`:'—'}</td><td>${finite(metrics.initialBuoyancyN)!==null?`${display(metrics.initialBuoyancyN,3)} <small>N</small>`:"—"}</td><td><span class="auto-review ${outcome.numericalSensitivityPassed===true?'passed':''}">${esc(review)}</span>${swamp}</td></tr>`;
    }).join('')}</tbody></table></div><div class="cfd-downloads"><button type="button" class="btn small" id="auto-excel">Download Excel</button><button type="button" class="btn small" id="auto-json">Download JSON</button></div><details class="cfd-advanced"><summary>Automatic settings and assumptions</summary><p class="cfd-note">Geometry: ${esc(plan.geometryMode??'see recorded runs')} · mass model: ${esc(plan.distribution??'CAD estimate')}${typeof plan.minimumWallThicknessM==='number'?` · sampled wall-resolution length ${display(plan.minimumWallThicknessM*1000,2)} mm`:''}.</p><ul class="auto-assumptions">${notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>${conditions.some(c=>list(c.runs).some(r=>typeof r.jobId==='string'))?`<p class="cfd-note">Individual solver cases:</p><div class="auto-cases">${conditions.flatMap(c=>list(c.runs).filter(r=>typeof r.jobId==='string').map(r=>`<a href="/api/cfd/jobs/${encodeURIComponent(String(r.jobId))}/download" download>${esc(c.label??c.id)} · ${esc(r.phase)}</a>`)).join('')}</div>`:''}</details><p class="cfd-note">Numerical agreement checks sensitivity to mesh, time step and boundaries. Physical accuracy still depends on the real mass distribution and tow/wave measurements.</p>`;
    const details=get('auto-study').querySelector<HTMLDetailsElement>('details.cfd-advanced');if(details)details.open=assumptionsOpen;
    dialog.querySelector('#auto-cancel')?.addEventListener('click',async()=>{if(!study)return;const id=String(study.id);get<HTMLButtonElement>('auto-cancel').disabled=true;try{study=await api(`/api/cfd/studies/${encodeURIComponent(id)}/cancel`,{method:'POST',body:'{}'});renderStudy();void refreshQueue();}catch(e){error((e as Error).message);}});
    dialog.querySelector('#auto-rerun')?.addEventListener('click',async()=>{if(!study)return;get<HTMLButtonElement>('auto-rerun').disabled=true;try{askNotify();study=await api(`/api/cfd/studies/${encodeURIComponent(String(study.id))}/rerun`,{method:'POST',body:'{}'});streamJob=null;renderStudy();void poll();void refreshQueue();}catch(e){error((e as Error).message);}});
    get('auto-excel').addEventListener('click',()=>{if(study)download(buildXlsx(automaticStudySheets(study)),`hull-tests-${String(study.id)}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');});
    get('auto-json').addEventListener('click',()=>{if(study)download(new TextEncoder().encode(JSON.stringify(study,null,2)),`hull-tests-${String(study.id)}.json`,'application/json');});
    setActions();followStudy();
  }
  /** Stream the running solver's log; after the study ends keep showing the last job's log. */
  function followStudy(){
    if(!study||!dialog.open)return;
    const runs:RecordValue[]=list(study.conditions).flatMap(c=>list(c.runs).map(r=>({...r,label:c.label??c.id})));
    const activeId=typeof study.activeJobId==='string'?study.activeJobId:null;
    const target=activeId??[...runs].reverse().find(r=>typeof r.jobId==='string')?.jobId as string|undefined;
    const run=runs.find(r=>r.jobId===target);
    const progress=record(study.progress),index=(finite(progress.solvesFinished)??0)+(activeId?1:0);
    get('auto-live-title').textContent=run?`${String(run.label)} · ${String(run.phase)}${activeId?` · run ${index} of ${finite(progress.solvesMaximum)??'?'}`:''}`:'Live solver log';
    if(target)connect(target);
  }
  function clearLog(){const pre=get('auto-live-log');pre.textContent='';logLines=0;}
  function addLines(lines:unknown,skipped=0){
    if(!Array.isArray(lines)||!lines.length)return;
    const pre=get('auto-live-log'),follow=get<HTMLInputElement>('auto-follow').checked;
    const chunk=document.createElement('span');
    let plain:string[]=[];
    const flush=()=>{if(plain.length){chunk.append(plain.join('\n')+'\n');plain=[];}};
    if(skipped>0)plain.push(`… ${skipped} fast lines skipped …`);
    for(const raw of lines){
      const line=String(raw),stage=/^HULL_CFD_STAGE:(\w+)/.exec(line);
      if(stage||/FOAM FATAL|FATAL ERROR|^Stage \w+ failed|OpenFOAM stopped|^\s*Error\b|Floating point exception|Segmentation fault/.test(line)){
        flush();const mark=document.createElement('b');mark.className=stage?'auto-log-stage':'auto-log-error';
        mark.textContent=(stage?`▶ ${stage[1]}`:line)+'\n';chunk.append(mark);
      }else plain.push(line);
    }
    flush();pre.append(chunk);logLines+=lines.length;
    while(logLines>LOG_LIMIT&&pre.firstChild){const first=pre.firstChild as HTMLElement;logLines-=(first.textContent??'').split('\n').length-1;first.remove();}
    if(follow)pre.scrollTop=pre.scrollHeight;
  }
  function showState(value:unknown){
    const s=record(value),p=record(s.progress);
    get('auto-live').hidden=false;
    get('auto-live-stage').textContent=`${String(s.status??'')} · ${String(s.stage??'')}${typeof s.cores==='number'?` · ${s.cores} CPU core${s.cores===1?'':'s'}`:''}`;
    const solving=p.step==='interFoam'||finite(p.simTimeS)!==null;
    const bar=get<HTMLProgressElement>('auto-live-progress');
    if(solving&&finite(p.percent)!==null){bar.value=p.percent as number;}else bar.removeAttribute('value');
    if(s.status==='completed')bar.value=100;
    const stat=(k:string,v:string)=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
    get('auto-live-stats').innerHTML=[
      stat('Simulated time',finite(p.simTimeS)!==null?`${(p.simTimeS as number).toFixed(3)} / ${display(p.endTimeS,2)} s`:'meshing…'),
      stat('Progress',solving?`${display(p.percent,1)} %`:'—'),
      stat('Time left (this run)',s.status==='completed'?'done':formatDuration(p.etaS)),
      stat('Solving for',formatDuration(p.elapsedS)),
      stat('Time step',finite(p.deltaTS)!==null?`${((p.deltaTS as number)*1000).toPrecision(3)} ms`:'—'),
      stat('Max Courant',display(p.courantMax,2)),
      stat('Mesh cells',finite(p.cells)!==null?(p.cells as number).toLocaleString('en-GB'):'—'),
    ].join('');
    if(s.error)get('auto-live-stage').textContent+=` · ${String(s.error)}`;
  }
  function disconnect(){stream?.close();stream=null;streamJob=null;}
  function connect(jobId:string){
    if(streamJob===jobId||typeof EventSource==='undefined')return;
    disconnect();streamJob=jobId;clearLog();
    const source=new EventSource(`/api/cfd/jobs/${encodeURIComponent(jobId)}/stream`);stream=source;
    const parse=(e:Event)=>{try{return record(JSON.parse((e as MessageEvent).data));}catch{return {};}};
    source.addEventListener('init',e=>{const d=parse(e);clearLog();addLines(d.lines);showState(d);});
    source.addEventListener('lines',e=>{const d=parse(e);addLines(d.lines,finite(d.skipped)??0);});
    source.addEventListener('state',e=>showState(parse(e)));
    // The server closes finished streams; stop EventSource from reconnecting in a loop.
    source.addEventListener('end',e=>{showState(parse(e));source.close();if(stream===source)stream=null;void poll();});
  }
  function renderPicker(){
    const box=dialog.querySelector('#auto-pick');if(!box)return;
    box.querySelectorAll<HTMLInputElement>('input[data-cond]').forEach(i=>{
      const id=i.dataset.cond!,e=estimateFor(id),note=box.querySelector<HTMLElement>(`[data-est="${id}"]`);
      i.checked=choice.conditions.includes(id);
      const cell=i.closest('td');cell?.classList.toggle('blocked',e?.blocked===true);
      if(note){
        if(!estimate)note.textContent=selected&&available?'…':'';
        else if(!e)note.textContent='';
        else if(e.blocked===true){const max=/at most about (\d+) g/.exec(String(e.error??''));note.textContent=max?`Sinks (max ≈ ${max[1]} g)`:record(e.hint).verdict==='stability-failure'?'Capsizes (fails)':record(e.hint).title?String(record(e.hint).title):'cannot run';note.title=`${String(record(e.hint).hint??'')}\n\n${String(e.error??'')}`.trim();}
        else{note.textContent=`≈ ${formatDuration(e.predictedS)}`;note.title=list(e.runs).map(r=>r.error?`${r.phase}: ${String(record(r.hint).title??r.error)}`:`${r.phase}: ~${Number(r.cells).toLocaleString('en-GB')} cells, ${display(r.simulatedS,1)} s simulated, ≈ ${formatDuration(r.predictedS)}`).join('\n');if(e.laterPhaseError)note.textContent+=' ⚠';}
      }
    });
    box.querySelectorAll<HTMLInputElement>('input[name="auto-speed"]').forEach(i=>{i.checked=i.value===choice.speed;});
    const cores=get<HTMLSelectElement>('auto-cores'),wanted=Math.min(choice.cores??defaultCores,maxCores);
    cores.innerHTML=Array.from({length:maxCores},(_,i)=>i+1).map(n=>`<option value="${n}"${n===wanted?' selected':''}>${n}${n===defaultCores?' (recommended)':''}</option>`).join('');
    const ids=runnable(),solves=plannedSolves({...choice,conditions:ids}),waves=ids.filter(id=>!id.endsWith('-calm')).length,est=selectedEstimateS();
    const blocked=choice.conditions.filter(id=>estimateFor(id)?.blocked===true&&!designVerdict(estimateFor(id)));
    const verdicts=choice.conditions.filter(id=>designVerdict(estimateFor(id)));
    const partial=ids.filter(id=>estimateFor(id)?.laterPhaseError);
    const parts:string[]=[];
    const where=backend==='cluster'?`on ${clusterHost||'the cluster'}`:'on this computer';
    if(ids.length)parts.push(`${ids.length} test${ids.length===1?'':'s'} → up to ${solves} solver run${solves===1?'':'s'}, ${backend==='cluster'?'all at once on the cluster':'one at a time'}.`);
    if(est!==null&&ids.length)parts.push(`Estimated time: ≈ ${formatDuration(est)} ${backend==='cluster'?`on ${clusterHost||'the cluster'} (${wanted} cores per test, plus any wait for free nodes)`:`on ${wanted} core${wanted===1?'':'s'}`}${estimate?.calibrated===true?` (calibrated ${where})`:` (rough until the first run ${where} finishes; it learns from every run)`}.`);
    else if(ids.length&&selected&&available)parts.push('Estimating time…');
    const fixes=Array.isArray(estimate?.repairNotes)?(estimate!.repairNotes as unknown[]).map(String):[];
    if(fixes.length)parts.push(`CAD automatically cleaned up: ${fixes.join(' ')}`);
    if(blocked.length)parts.push(`${blocked.length} ticked test${blocked.length===1?'':'s'} will be skipped: ${blocked.map(id=>`${String(estimateFor(id)?.label??id)} (${String(record(estimateFor(id)?.hint).title??'cannot run')})`).join(', ')}.`);
    if(verdicts.length)parts.push(`${verdicts.length} ticked test${verdicts.length===1?'':'s'} will be recorded as a design failure without simulation (the hull sinks or capsizes under that load).`);
    if(partial.length)parts.push(`⚠ ${partial.length} test${partial.length===1?'':'s'} cannot complete every Full-mode check (e.g. a finer mesh exceeds the cell budget); hover the ⚠ for details.`);
    parts.push(choice.speed==='quick'?'Quick: one coarse solve per test with a shorter simulated window. Rough numbers for screening, no convergence checks.':'Full: coarse, medium and fine meshes (each about 1.4× finer) plus time-step and domain checks on the coarse mesh. Slower, but it checks the numbers.');
    if(waves)parts.push('Wave tests take much longer than calm tows.');
    get('auto-plan-note').textContent=choice.conditions.length?parts.join(' '):'Tick at least one test.';
    setActions();
  }
  /** Preflight every test for the current hull and speed and estimate its run time (server prepares, never runs). */
  function refreshEstimate(){
    clearTimeout(estimateTimer);
    if(!selected||!available)return;
    const cores=Math.min(choice.cores??defaultCores,maxCores),key=`${selected.id}|${selected.trianglesMm.length}|${choice.speed}|${cores}`;
    if(key===estimateKey&&estimate)return;
    estimateKey=key;estimate=null;renderPicker();
    const seq=++estimateSeq,sel=selected;
    estimateTimer=window.setTimeout(async()=>{
      try{const data=await api('/api/cfd/estimate',{method:'POST',body:JSON.stringify({name:sel.name,trianglesMm:Array.from(sel.trianglesMm),speed:choice.speed,cores})});if(seq!==estimateSeq||!alive)return;estimate=data;renderPicker();}
      catch(e){if(seq===estimateSeq){estimate=null;get('auto-plan-note').textContent=`Could not check these tests: ${(e as Error).message}`;}}
    },250);
  }
  function bindPicker(){
    const box=get('auto-pick');
    const update=(next:AutoChoice)=>{choice=normaliseChoice(next);saveChoice(choice);renderPicker();refreshEstimate();};
    box.querySelectorAll<HTMLInputElement>('input[data-cond]').forEach(i=>i.addEventListener('change',()=>{
      const set=new Set(choice.conditions);if(i.checked)set.add(i.dataset.cond!);else set.delete(i.dataset.cond!);update({...choice,conditions:[...set]});
    }));
    box.querySelectorAll<HTMLInputElement>('input[name="auto-speed"]').forEach(i=>i.addEventListener('change',()=>{if(i.checked)update({...choice,speed:i.value==='full'?'full':'quick'});}));
    get<HTMLSelectElement>('auto-cores').addEventListener('change',e=>update({...choice,cores:Number((e.target as HTMLSelectElement).value)}));
    box.querySelectorAll<HTMLElement>('[data-pick]').forEach(b=>b.addEventListener('click',()=>{
      const pick=b.dataset.pick,conditions=pick==='all'?AUTO_CONDITION_IDS:pick==='calm'?AUTO_CONDITION_IDS.filter(id=>id.endsWith('-calm')):pick?.startsWith('load:')?AUTO_CONDITION_IDS.filter(id=>id.startsWith(pick.slice(5)+'g-')):pick?.startsWith('test:')?AUTO_CONDITION_IDS.filter(id=>id.endsWith('-'+pick.slice(5))):[];
      update({...choice,conditions:pick==='none'?[]:[...conditions]});
    }));
  }
  /* ---------- Queue, history, notifications ---------- */
  function askNotify(){try{if(typeof Notification!=='undefined'&&Notification.permission==='default')void Notification.requestPermission();}catch{/* optional */}}
  function notify(title:string,body:string){try{if(typeof Notification!=='undefined'&&Notification.permission==='granted')new Notification(title,{body,tag:'hull-test-bench'});}catch{/* optional */}}
  function updateTitle(){
    const activeStudy=studies.find(s=>s.status==='running'),n=finite(queue?.studies)??0;
    if(!activeStudy||!n){document.title=baseTitle;return;}
    const p=record(record(activeStudy.activeJob).progress),left=finite(queue?.remainingS);
    document.title=`▶ ${finite(p.percent)!==null?`${Math.round(p.percent as number)}% · `:''}${left!==null?`${formatDuration(left)} left · `:''}${baseTitle}`;
  }
  function checkFinished(){
    for(const s of studies){
      const id=String(s.id),prev=seenStatus.get(id),now=String(s.status);seenStatus.set(id,now);
      if(prev&&!terminal(prev)&&terminal(now)){
        const cs=list(s.conditions),ok=cs.filter(c=>c.status==='completed').length;
        notify(`${String(s.name)}: tests ${now}`,`${ok} of ${cs.length} tests completed${cs.length-ok?`, ${cs.length-ok} not`:''}.`);
        if(!(finite(queue?.studies)??0))notify('All hull tests finished','The test queue is empty. Download the combined Excel from the queue panel.');
      }
    }
  }
  function renderQueue(){
    const box=dialog.querySelector<HTMLElement>('#auto-queue');if(!box||!dialog.open)return;
    // On the cluster several hulls run at once (activeIds); locally one does (activeId).
    const running=Array.isArray(queue?.activeIds)?(queue!.activeIds as unknown[]).map(String):[String(queue?.activeId??'')];
    const activeIds=[...new Set([...running,...(Array.isArray(queue?.queuedIds)?(queue!.queuedIds as unknown[]).map(String):[])])].filter(Boolean);
    const byId=new Map(studies.map(s=>[String(s.id),s]));
    const upcoming=activeIds.map(id=>byId.get(id)).filter(Boolean) as RecordValue[];
    const history=studies.filter(s=>terminal(s.status)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,30);
    if(!upcoming.length&&!history.length){box.innerHTML='';return;}
    const left=finite(queue?.remainingS);
    const row=(s:RecordValue)=>{
      const p=record(s.progress),cs=list(s.conditions),ok=cs.filter(c=>c.status==='completed').length,speed=speedLabel(record(s.options).speed),viewing=study&&String(study.id)===String(s.id);
      const bad=cs.filter(c=>['failed','blocked'].includes(String(c.status))).length,stopped=cs.filter(c=>['cancelled','interrupted'].includes(String(c.status))).length;
      const state=terminal(s.status)?`Finished · ${[`${ok} completed`,bad?`${bad} failed`:'',stopped?`${stopped} stopped`:''].filter(Boolean).join(', ')}`:`${String(s.status)}${finite(record(s.overall).percent)!==null&&s.status==='running'?` · ${Math.round(record(s.overall).percent as number)}%`:''} · ${finite(p.solvesFinished)??0}/${finite(p.solvesMaximum)??'?'} runs`;
      return `<tr class="${viewing?'viewing':''}"><td><b>${breakable(String(s.name??'Hull'))}</b><small>${cs.length} test${cs.length===1?'':'s'} · ${speed}</small></td><td>${esc(state)}<small>${esc(etaText(s))}</small></td><td class="auto-queue-actions"><button type="button" class="btn small" data-view="${esc(s.id)}">${viewing?'Showing':'View'}</button>${terminal(s.status)?'':`<button type="button" class="btn small" data-cancel="${esc(s.id)}">${s.status==='queued'?'Remove':'Stop'}</button>`}</td></tr>`;
    };
    const html=`<div class="auto-queue-head"><div><b>Test queue</b><span>${upcoming.length?`${upcoming.length} hull${upcoming.length===1?'':'s'} running or waiting${left!==null?` · ≈ ${formatDuration(left)} left · all done around ${clockTime(queue?.finishAt)}`:' · estimating…'}`:'Nothing running'}</span></div>${upcoming.length?'<button type="button" class="btn small" id="auto-stop-all">Stop everything</button>':''}</div>${upcoming.length?`<div class="auto-table-wrap"><table class="auto-queue-table"><tbody>${upcoming.map(row).join('')}</tbody></table></div>`:''}${history.length?`<details class="cfd-advanced auto-history"${upcoming.length?'':' open'}><summary>Finished (${history.length})</summary><div class="auto-table-wrap"><table class="auto-queue-table"><tbody>${history.map(row).join('')}</tbody></table></div></details>`:''}${rankingHtml(studies)}<div class="cfd-downloads"><button type="button" class="btn small" id="auto-all-excel">Download all hulls (Excel)</button></div>`;
    // Re-render only on change, so buttons are not replaced under the pointer during polling.
    if(box.dataset.html===html)return;
    const historyOpen=box.querySelector<HTMLDetailsElement>('details.auto-history')?.open;
    box.innerHTML=html;box.dataset.html=html;
    const history2=box.querySelector<HTMLDetailsElement>('details.auto-history');if(history2&&historyOpen!==undefined)history2.open=historyOpen;
    box.querySelectorAll<HTMLElement>('[data-view]').forEach(b=>b.addEventListener('click',()=>{streamJob=null;void loadStudy(b.dataset.view!);}));
    box.querySelectorAll<HTMLElement>('[data-cancel]').forEach(b=>b.addEventListener('click',async()=>{(b as HTMLButtonElement).disabled=true;try{await api(`/api/cfd/studies/${encodeURIComponent(b.dataset.cancel!)}/cancel`,{method:'POST',body:'{}'});await refreshQueue();if(study&&String(study.id)===b.dataset.cancel)void loadStudy(b.dataset.cancel!);}catch(e){error((e as Error).message);}}));
    dialog.querySelector('#auto-stop-all')?.addEventListener('click',async()=>{if(!window.confirm('Stop the running test and remove every queued hull?'))return;try{await api('/api/cfd/queue/cancel',{method:'POST',body:'{}'});await refreshQueue();if(study)void loadStudy(String(study.id));}catch(e){error((e as Error).message);}});
    get('auto-all-excel').addEventListener('click',()=>{const rows=studies.filter(s=>list(s.conditions).length);download(buildXlsx([rankingSheet(rows),allStudiesSheet(rows),...(study?automaticStudySheets(study).slice(1,3):[])]),`hull-tests-all-${new Date().toISOString().slice(0,10)}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');});
  }
  /** Polls the queue while anything runs, even with the dialog closed, for the tab title and notifications. */
  async function refreshQueue(){
    clearTimeout(queueTimer);
    if(!alive||queueBusy)return;
    queueBusy=true;
    try{const data=await api('/api/cfd/studies');studies=list(data.studies);queue=record(data.queue);checkFinished();updateTitle();renderQueue();setActions();}
    catch{/* service offline: status line already explains */}
    finally{queueBusy=false;const busy=(finite(queue?.studies)??0)>0;if(alive&&(busy||dialog.open))queueTimer=window.setTimeout(()=>void refreshQueue(),dialog.open?3000:10000);}
  }
  async function poll(){
    clearTimeout(timer);
    if(!alive||!dialog.open||!study||checking||terminal(study.status))return;
    checking=true;
    try{study=await api(`/api/cfd/studies/${encodeURIComponent(String(study.id))}`);if(!alive)return;renderStudy();}
    catch(e){error((e as Error).message);}
    finally{checking=false;if(alive&&dialog.open&&study&&!terminal(study.status))timer=window.setTimeout(()=>void poll(),2500);}
  }
  async function loadStudy(id:string){
    try{study=await api(`/api/cfd/studies/${encodeURIComponent(id)}`);error('');renderStudy();void poll();}catch(e){error((e as Error).message);}
  }
  async function refreshStatus(){
    try{
      const status=await api('/api/cfd/status');
      if(!alive||!dialog.open)return;
      available=status.available===true;backend=status.backend==='cluster'?'cluster':'local';clusterHost=String(status.host??'');
      maxCores=Math.max(1,finite(status.maxCores)??1);defaultCores=Math.min(maxCores,Math.max(1,finite(status.defaultCores)??maxCores));renderPicker();
      dialog.querySelectorAll<HTMLInputElement>('input[name="auto-backend"]').forEach(i=>{i.checked=i.value===backend;});
      get('auto-cores-label').hidden=backend==='cluster';
      get('auto-run-note').textContent=backend==='cluster'?'On the cluster every test (and every Full-mode check) runs at the same time on its own compute node, and several hulls can run side by side. Results come back automatically. You can close this window; keep this app running until the tests finish.':'Tests run one after another, never all at once. You can keep adding hulls to the queue, close this window, stop at any time and export partial results. Your browser can notify you when tests finish.';
      get('auto-service').textContent=available?(backend==='cluster'?`OpenFOAM ready · runs on ${clusterHost} · ${maxCores} cores per test, all tests in parallel`:`OpenFOAM ready · runs locally in Docker · ${maxCores} CPU cores available`):String(status.message??'Start Docker and install the pinned OpenFOAM image.');
      get('auto-service').className=`cfd-service ${available?'ready':'offline'}`;
      get('auto-local').hidden=available;
      refreshEstimate();
      await refreshQueue();
      if(!alive||!dialog.open)return;
      // Show the running study; a repeated filename does not prove that a historical result belongs to this geometry.
      if(!study){const candidate=studies.find(s=>s.status==='running');if(candidate)study=candidate;}
      renderStudy();void poll();
    }catch(e){if(!alive||!dialog.open)return;available=false;get('auto-service').textContent='Local OpenFOAM service unavailable';get('auto-service').className='cfd-service offline';get('auto-local').hidden=false;error((e as Error).message);}
    finally{if(alive&&dialog.open)setActions();}
  }
  async function submit(sel:CfdSelection){
    const conditions=runnable();
    const request=buildAutomaticStudyRequest(sel,{...choice,conditions,cores:Math.min(choice.cores??defaultCores,maxCores)});
    return api('/api/cfd/studies',{method:'POST',body:JSON.stringify(request)});
  }
  async function run(){
    if(!selected||submitting||!available)return;
    error('');submitting=true;setActions();askNotify();
    try{const created=await submit(selected);if(!alive)return;if(!study||terminal(study.status)||created.status==='running'){study=created;streamJob=null;}renderStudy();void poll();await refreshQueue();}
    catch(e){error((e as Error).message);}
    finally{submitting=false;if(alive&&dialog.open)setActions();}
  }
  /** Queue the same ticked tests for every loaded hull (competition entries), one study per hull. */
  async function runAll(){
    const all=options.getAll?.()??[];if(submitting||!available||all.length<2)return;
    if(!window.confirm(`Queue ${runnable().length} test${runnable().length===1?'':'s'} (${choice.speed==='quick'?'Quick':'Full'}) for each of ${all.length} hulls? ${backend==='cluster'?'They run side by side on the cluster.':'They run one after another.'}`))return;
    error('');submitting=true;setActions();askNotify();
    const failures:string[]=[];
    for(const sel of all){
      try{buildAutomaticStudyRequest(sel);await submit(sel);}
      catch(e){failures.push(`${sel.name}: ${(e as Error).message}`);}
    }
    submitting=false;await refreshQueue();
    if(!study||terminal(study.status)){const running=studies.find(s=>s.status==='running');if(running){study=running;streamJob=null;renderStudy();void poll();}}
    if(failures.length)error(`Not queued: ${failures.join(' · ')}`);
    setActions();
  }
  /* ---------- Cluster (Slurm over SSH) settings ---------- */
  const CLUSTER_FIELDS=['host','user','account','partition','remoteDir','cores','hours','memoryGb','concurrentStudies','sshKey'] as const;
  let installTimer=0;
  function clusterStatusText(data:RecordValue){
    const check=record(data.check),install=record(data.install),problems=Array.isArray(data.problems)?data.problems.map(String):[];
    const parts:string[]=[];
    if(problems.length)parts.push(problems.join(' '));
    const cert=record(data.certificate);
    if(cert.required===true||cert.exists===true)parts.push(cert.valid===true?`✓ ${String(cert.message??'')}`:`⚠ ${String(cert.message??'SSH certificate missing.')}`);
    if(data.check===null||data.check===undefined)parts.push('Not tested yet: press Test connection.');
    else if(check.ok!==true)parts.push(`Connection failed: ${String(check.error??'unknown error')}`);
    else{
      parts.push(`Connected to ${String(check.host||'the cluster')}.`);
      if(check.slurm!==true)parts.push('Slurm (sbatch) was not found there.');
      if(check.apptainer!==true)parts.push('Apptainer was not found there.');
      if(check.remoteDirOk!==true)parts.push('The cluster folder could not be created; check the path and project.');
      parts.push(check.solverInstalled===true?'Solver installed ✓':'Solver not installed yet: press Install solver.');
      const parts2=Array.isArray(check.partitions)?check.partitions.map(String):[];if(parts2.length)parts.push(`Partitions (name, time limit, cores per node): ${parts2.slice(0,8).join(' · ')}`);
    }
    if(install.state==='running')parts.push(String(install.message??'Installing…'));
    else if(install.state==='failed')parts.push(`Install failed: ${String(install.message??'')}`);
    else if(install.state==='done')parts.push(String(install.message??''));
    return parts.join(' ');
  }
  function showCluster(data:RecordValue){
    const form=dialog.querySelector<HTMLFormElement>('#auto-cluster');if(!form)return;
    const config=record(data.config);
    if(data.config)for(const k of CLUSTER_FIELDS){const input=form.elements.namedItem(k) as HTMLInputElement|null;if(input&&document.activeElement!==input)input.value=config[k]===undefined||config[k]===null?'':String(config[k]);}
    get('auto-cluster-status').textContent=clusterStatusText(data);
    clearTimeout(installTimer);
    if(record(data.install).state==='running')installTimer=window.setTimeout(()=>void clusterCall('/api/cfd/cluster'),5000);
  }
  async function clusterCall(path:string,init?:RequestInit){
    try{const data=await api(path,init);if(!alive)return null;showCluster(data);return data;}
    catch(e){get('auto-cluster-status').textContent=(e as Error).message;return null;}
  }
  function clusterForm():Record<string,unknown>{
    const form=get<HTMLFormElement>('auto-cluster'),out:Record<string,unknown>={};
    for(const k of CLUSTER_FIELDS){const v=(form.elements.namedItem(k) as HTMLInputElement).value.trim();out[k]=['cores','hours','memoryGb','concurrentStudies'].includes(k)?Number(v||0):v;}
    return out;
  }
  async function setBackend(next:'local'|'cluster'){
    const data=await clusterCall('/api/cfd/cluster',{method:'POST',body:JSON.stringify({enabled:next==='cluster'})});
    if(next==='cluster'&&data&&(Array.isArray(data.problems)&&data.problems.length||record(data.check).solverInstalled!==true)){get<HTMLFormElement>('auto-cluster').hidden=false;get('auto-cluster-toggle').setAttribute('aria-expanded','true');}
    estimateKey='';estimate=null;await refreshStatus();
  }
  function bindCluster(){
    const form=get<HTMLFormElement>('auto-cluster'),toggle=get('auto-cluster-toggle');
    toggle.addEventListener('click',()=>{form.hidden=!form.hidden;toggle.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)void clusterCall('/api/cfd/cluster');});
    dialog.querySelectorAll<HTMLInputElement>('input[name="auto-backend"]').forEach(i=>i.addEventListener('change',()=>{if(i.checked)void setBackend(i.value==='cluster'?'cluster':'local');}));
    form.addEventListener('submit',e=>{e.preventDefault();void clusterCall('/api/cfd/cluster',{method:'POST',body:JSON.stringify(clusterForm())}).then(()=>{estimateKey='';void refreshStatus();});});
    get('auto-cluster-check').addEventListener('click',async()=>{
      get('auto-cluster-status').textContent='Saving and connecting…';
      await clusterCall('/api/cfd/cluster',{method:'POST',body:JSON.stringify(clusterForm())});
      await clusterCall('/api/cfd/cluster/check',{method:'POST'});estimateKey='';void refreshStatus();
    });
    get('auto-cluster-install').addEventListener('click',async()=>{
      get('auto-cluster-status').textContent='Starting the solver download on the cluster…';
      await clusterCall('/api/cfd/cluster',{method:'POST',body:JSON.stringify(clusterForm())});
      await clusterCall('/api/cfd/cluster/install',{method:'POST'});void clusterCall('/api/cfd/cluster');
    });
  }
  function close(){clearTimeout(timer);clearTimeout(installTimer);disconnect();dialog.close();}
  function open(){
    if(!alive)return;
    const next=options.getSelection(),sameGeometry=selected&&next&&selected.id===next.id&&selected.trianglesMm.length===next.trianglesMm.length&&selected.trianglesMm.every((v,i)=>v===next.trianglesMm[i]);
    selected=next?{...next,trianglesMm:next.trianglesMm.slice()}:null;
    if(study&&terminal(study.status)&&!sameGeometry)study=null;
    dialog.innerHTML=`<div class="cfd-title"><div><small>OPENFOAM TESTS</small><h2>Test your hull</h2></div><button type="button" class="btn small" id="auto-close" aria-label="Close automatic tests">Close</button></div><div class="cfd-content"><div id="auto-service" class="cfd-service">Checking OpenFOAM…</div><div class="auto-backend" role="radiogroup" aria-label="Where to run"><span>Run on</span><label><input type="radio" name="auto-backend" value="local"> This computer</label><label><input type="radio" name="auto-backend" value="cluster"> Cluster (CSC Roihu)</label><button type="button" class="btn small" id="auto-cluster-toggle" aria-expanded="false">Cluster settings</button></div><form id="auto-cluster" class="auto-cluster" hidden autocomplete="off"><p class="cfd-note"><b>One-time setup.</b> 1) Create an SSH key on this computer: <code>ssh-keygen -t ed25519</code> (press Enter for no passphrase). 2) Add the contents of <code>~/.ssh/id_ed25519.pub</code> to your account in MyCSC (my.csc.fi → SSH public keys) and wait a few minutes. 3) Fill in your CSC username and project, press <b>Save</b>, <b>Test connection</b>, then <b>Install solver</b> (once, 5–20 min).</p><div class="auto-cluster-grid"><label>Host<input name="host" placeholder="roihu.csc.fi"></label><label>CSC username<input name="user" placeholder="username"></label><label>Project (billing)<input name="account" placeholder="project_2001234"></label><label>Partition<input name="partition" placeholder="small"></label><label>Folder on the cluster<input name="remoteDir" placeholder="/scratch/project_2001234/hulltests"></label><label>Cores per test<input name="cores" type="number" min="1" max="512"></label><label>Max hours per run<input name="hours" type="number" min="1" max="336"></label><label>Memory per run, GB (0 = default)<input name="memoryGb" type="number" min="0" max="4096"></label><label>Hulls at once<input name="concurrentStudies" type="number" min="1" max="200"></label><label>SSH key file (optional)<input name="sshKey" placeholder="C:\Users\you\.ssh\id_ed25519"></label></div><div class="auto-cluster-actions"><button type="submit" class="btn small">Save</button><button type="button" class="btn small" id="auto-cluster-check">Test connection</button><button type="button" class="btn small" id="auto-cluster-install">Install solver</button></div><p class="cfd-note" id="auto-cluster-status" role="status"></p></form><p class="auto-selection">${selected?`<b>${esc(selected.name)}</b><span>${selected.sizeMm.map(n=>display(n,1)).join(' × ')} mm · your oriented STL</span>`:'Select an STL hull in the workbench first.'}</p><div class="auto-protocol"><div><strong>3 loads</strong><span>150 · 250 · 350 g total</span></div><div><strong>2 waves + calm</strong><span>Medium and high, scaled to hull length</span></div><div><strong>0.30 m/s</strong><span>Calm towing · fresh water</span></div></div><p class="cfd-note">Geometry, CAD CG and inertia, wall-resolution length, waves and solver settings are selected automatically. The same programme runs for every design.</p><p class="auto-distribution">The test loads follow a uniform CAD mass distribution. Infill, equipment and real cargo positions cannot be recovered from an STL; use advanced settings when those measurements are available.</p><fieldset class="auto-pick" id="auto-pick"><legend>Choose what to run</legend><div class="auto-speed"><label><input type="radio" name="auto-speed" value="quick"><b>Quick</b><span>1 solve per test · calm on the finer mesh, waves on the standard mesh · about 1 h per batch on the cluster · for ranking</span></label><label><input type="radio" name="auto-speed" value="full"><b>Full</b><span>Calm: coarse + finer mesh + half time step (drag checks) · waves: one run each, as Quick · all at once on the cluster, about 1 h per hull</span></label></div><div class="auto-table-wrap"><table class="auto-grid"><thead><tr><th scope="col">Load</th>${AUTO_TESTS.map(t=>`<th scope="col"><button type="button" class="auto-link" data-pick="test:${t.id}" title="Select ${t.label} for all loads">${t.label}</button></th>`).join('')}</tr></thead><tbody>${AUTO_LOADS.map(g=>`<tr><th scope="row"><button type="button" class="auto-link" data-pick="load:${g}" title="Select every test at ${g} g">${g} g</button></th>${AUTO_TESTS.map(t=>`<td><label class="auto-check"><input type="checkbox" data-cond="${g}g-${t.id}" aria-label="${g} g · ${t.label}"></label><small class="auto-est" data-est="${g}g-${t.id}"></small></td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="auto-pick-tools"><button type="button" class="btn small" data-pick="calm">Calm tows only</button><button type="button" class="btn small" data-pick="all">All ${AUTO_CONDITION_IDS.length}</button><button type="button" class="btn small" data-pick="none">Clear</button><label class="auto-cores" id="auto-cores-label">CPU cores per solve <select id="auto-cores"><option>1</option></select></label></div><p class="cfd-note" id="auto-plan-note"></p></fieldset><div class="auto-main-actions"><button type="button" class="btn primary" id="auto-run" disabled>Run tests</button><button type="button" class="btn small" id="auto-batch" hidden>Queue for all hulls</button><button type="button" class="btn small" id="auto-advanced">Advanced settings</button></div><p class="cfd-note" id="auto-run-note">Tests run one after another, never all at once. You can keep adding hulls to the queue, close this window, stop at any time and export partial results. Your browser can notify you when tests finish.</p><div id="auto-local" hidden><p class="cfd-note">OpenFOAM needs the local app and Docker. <a href="/download.html">Setup guide</a> · <a href="/downloads/Hull-Test-Bench-OpenFOAM.zip" download>Download updated app</a></p></div><p id="auto-error" class="cfd-error" role="alert"></p><section id="auto-live" class="auto-live" hidden aria-label="Live solver output"><div class="auto-live-head"><div><b id="auto-live-title">Live solver log</b><span id="auto-live-stage"></span></div><label class="auto-follow"><input type="checkbox" id="auto-follow" checked> Auto-scroll</label></div><progress id="auto-live-progress" max="100" aria-label="Current solve progress"></progress><dl class="auto-live-stats" id="auto-live-stats"></dl><pre id="auto-live-log" class="auto-live-log" tabindex="0" aria-label="Live solver log"></pre></section><section id="auto-study" aria-label="Automatic test progress"></section><section id="auto-queue" class="auto-queue" aria-label="Test queue and history"></section></div>`;
    get('auto-close').addEventListener('click',close);
    get('auto-run').addEventListener('click',()=>void run());
    get('auto-batch').addEventListener('click',()=>void runAll());
    get('auto-advanced').addEventListener('click',()=>{close();options.openAdvanced();});
    bindPicker();bindCluster();estimateKey='';estimate=null;renderPicker();streamJob=null;
    if(!dialog.open)dialog.showModal();renderStudy();void refreshStatus();
  }
  button?.addEventListener('click',open);
  dialog.addEventListener('close',()=>{clearTimeout(timer);disconnect();void refreshQueue();});
  void refreshQueue();
  return {open,close,destroy:()=>{alive=false;clearTimeout(timer);clearTimeout(queueTimer);clearTimeout(estimateTimer);disconnect();document.title=baseTitle;button?.removeEventListener('click',open);dialog.remove();}};
}
