import { buildXlsx, type Sheet } from "../xlsx";
import { compareRefinements, type RefinementRun } from "../cfd/results";
import {estimateMassProperties,type CadMassProperties,type MassDistribution,type PointMassPayload} from "../cfd/massProperties";

export interface CfdSelection {
  id: number | string;
  name: string;
  trianglesMm: Float32Array;
  sizeMm: [number, number, number];
  massG: number;
  speedMps: number;
  waveHeightMm?: number;
  wavePeriodS?: number;
  cgM?: [number, number, number];
}
export interface CfdFormInput {
  mode: "calm" | "head-waves" | "beam-waves";
  geometryMode: "closed-envelope" | "open-surface" | "printed-shell";
  massG: number;
  cgMm: [number, number, number];
  measuredMassCg: boolean;
  inertiaKgM2?: [number, number, number];
  inertiaMeasured: boolean;
  minimumWallThicknessMm?: number;
  speedMps: number;
  waveHeightMm: number;
  wavePeriodS: number;
  mesh: "coarse" | "medium" | "fine";
  timeStepS: number;
  durationS: number;
  maxCells?: number;
  domainScale?: number;
  cgSource?:'measured'|'cad-estimate';
  cgDistribution?:MassDistribution;
  cgAssumptionsConfirmed?:boolean;
  cgPayloads?:{name:string;massG:number;positionMm:[number,number,number]}[];
}
export interface CfdJobRequest {
  name: string;
  trianglesMm: number[];
  mode: CfdFormInput["mode"];
  geometryMode: CfdFormInput["geometryMode"];
  massKg: number;
  cgM: [number, number, number];
  measurementsConfirmed: true;
  inertiaKgM2?: [number, number, number];
  inertiaMeasured?: boolean;
  inertiaSource?:'measured'|'cad-estimate';
  minimumWallThicknessM?: number;
  speedMps: number;
  waveHeightM?: number;
  wavePeriodS?: number;
  mesh: CfdFormInput["mesh"];
  timeStepS: number;
  durationS: number;
  maxCells?: number;
  domainScale?: number;
  cgSource:'measured'|'cad-estimate';
  assumptionsConfirmed?:boolean;
  cgEstimate?:{distribution:MassDistribution;payloads:PointMassPayload[]};
}

function defaultDistribution(mode:CfdFormInput['geometryMode']):MassDistribution {
  return mode==='printed-shell'?'material':'shell';
}
function payloadsFromUi(payloads:CfdFormInput['cgPayloads']):PointMassPayload[] {
  return (payloads??[]).flatMap(p=>{
    if(!Number.isFinite(p.massG)||p.massG<0)throw new Error(`${p.name} mass must be zero or positive.`);
    if(p.massG===0)return [];
    if(!p.positionMm.every(Number.isFinite))throw new Error(`Enter the X, Y and Z position of ${p.name.toLowerCase()}.`);
    return [{name:p.name,massKg:p.massG/1000,positionM:p.positionMm.map(v=>v/1000) as [number,number,number]}];
  });
}

/** A CAD estimate uses actual material/surface geometry, plus explicitly positioned point masses. */
export function estimateCfdCg(selection:CfdSelection,f:Pick<CfdFormInput,'geometryMode'|'massG'|'cgDistribution'|'cgPayloads'>):CadMassProperties {
  if(!Number.isFinite(f.massG)||f.massG<=0)throw new Error('Enter a positive total loaded mass.');
  const payloads=payloadsFromUi(f.cgPayloads),hullMassKg=f.massG/1000-payloads.reduce((n,p)=>n+p.massKg,0);
  if(hullMassKg<=0)throw new Error('Ballast and cargo must weigh less than the total loaded mass; some mass must remain for the CAD hull.');
  return estimateMassProperties({trianglesMm:selection.trianglesMm,geometryMode:f.geometryMode,distribution:f.cgDistribution??defaultDistribution(f.geometryMode),hullMassKg,payloads});
}

/** Convert UI values to SI and preserve measured versus estimated CG provenance. */
export function buildCfdRequest(selection: CfdSelection, f: CfdFormInput): CfdJobRequest {
  if (!selection.trianglesMm.length || selection.trianglesMm.length % 9 !== 0) throw new Error("Choose a complete triangular STL first.");
  if (Array.from(selection.trianglesMm).some(v => !Number.isFinite(v))) throw new Error("The STL contains invalid coordinates.");
  if (!selection.sizeMm.every(v => Number.isFinite(v) && v > 0)) throw new Error("The hull must have positive length, beam and depth.");
  if (selection.sizeMm.some(v => v > 250.0001)) throw new Error("The hull exceeds the 250 × 250 × 250 mm build volume. Correct its size before CFD.");
  const cgSource=f.cgSource??'measured';
  if(!['measured','cad-estimate'].includes(cgSource))throw new Error('Choose measured or CAD-estimated CG.');
  if (!f.measuredMassCg) throw new Error(cgSource==='measured'?"Confirm measured loaded mass and centre of gravity before running CFD.":"Confirm the loaded mass and accept the CAD CG assumptions before running CFD.");
  if (!Number.isFinite(f.massG) || f.massG <= 0) throw new Error("Enter a positive loaded mass in grams.");
  if(cgSource==='cad-estimate'&&f.cgAssumptionsConfirmed!==true)throw new Error('Accept the CAD mass-distribution assumptions before using estimated CG.');
  const estimate=cgSource==='cad-estimate'?estimateCfdCg(selection,f):null;
  const cgM=estimate?estimate.cgM:f.cgMm.map(v=>v/1000) as [number,number,number];
  if (!cgM.every(Number.isFinite)) throw new Error("Enter the measured X, Y and Z coordinates of the loaded centre of gravity.");
  if (cgM[0] < 0 || cgM[0] > selection.sizeMm[0]/1000 || Math.abs(cgM[1]) > selection.sizeMm[1]/2000 || cgM[2] < 0) throw new Error("Check the CG coordinates: X from stern, Y from centreline, Z above keel.");
  if (!["calm", "head-waves", "beam-waves"].includes(f.mode)) throw new Error("Choose a supported CFD test.");
  if (!["closed-envelope", "open-surface", "printed-shell"].includes(f.geometryMode)) throw new Error("Choose the actual CAD geometry type.");
  if (!["coarse", "medium", "fine"].includes(f.mesh)) throw new Error("Choose a mesh level.");
  if (!Number.isFinite(f.speedMps) || f.speedMps < 0 || f.speedMps > 3) throw new Error("Enter a model speed from 0 to 3 m/s.");
  if (f.mode === "calm" && f.speedMps === 0) throw new Error("Resistance tests require a positive towing speed.");
  if (f.mode === "head-waves" && f.speedMps !== 0) throw new Error("This OpenFOAM wave setup supports head-wave forces at zero tow speed only. Use calm water for towing resistance.");
  if (!Number.isFinite(f.timeStepS) || f.timeStepS <= 0 || f.timeStepS > .01) throw new Error("Choose a time step above zero and no greater than 0.01 s.");
  if (!Number.isFinite(f.durationS) || f.durationS <= 0 || f.durationS > 600) throw new Error("Choose a duration above zero and no greater than 600 s.");
  if (f.geometryMode === "printed-shell" && (!Number.isFinite(f.minimumWallThicknessMm) || f.minimumWallThicknessMm! <= 0)) throw new Error("Enter the minimum printed wall thickness so the mesh can resolve it.");
  if (f.mode !== "calm" && (!Number.isFinite(f.waveHeightMm) || f.waveHeightMm <= 0 || !Number.isFinite(f.wavePeriodS) || f.wavePeriodS <= 0)) throw new Error("Enter a positive regular wave height and period.");
  const estimatedInertia=f.mode==='beam-waves'&&!!estimate&&!f.inertiaMeasured;
  if (f.mode === "beam-waves"&&!estimatedInertia) {
    if (!f.inertiaMeasured || !f.inertiaKgM2?.every(v => Number.isFinite(v) && v > 0)) throw new Error("Free roll requires measured positive moments of inertia in kg·m².");
    const [ix,iy,iz] = f.inertiaKgM2;
    if (ix > iy + iz || iy > ix + iz || iz > ix + iy) throw new Error("The moments of inertia violate the triangle inequalities. Check units and measurements.");
  }
  return {
    name: selection.name,
    trianglesMm: Array.from(selection.trianglesMm),
    mode: f.mode, geometryMode: f.geometryMode,
    massKg: f.massG / 1000,
    cgM,
    cgSource,
    ...(estimate?{assumptionsConfirmed:true,cgEstimate:{distribution:estimate.distribution,payloads:estimate.payloads}}:{}),
    measurementsConfirmed: true,
    ...(f.mode === "beam-waves" ? estimatedInertia?{inertiaSource:'cad-estimate' as const,inertiaMeasured:false}:{ inertiaKgM2: f.inertiaKgM2, inertiaMeasured: true,inertiaSource:'measured' as const } : {}),
    ...(f.geometryMode === "printed-shell" ? { minimumWallThicknessM: f.minimumWallThicknessMm! / 1000 } : {}),
    maxCells: f.maxCells ?? 750000, domainScale: f.domainScale ?? 1,
    speedMps: f.mode === "beam-waves" ? 0 : f.speedMps,
    ...(f.mode === "calm" ? {} : { waveHeightM: f.waveHeightMm / 1000, wavePeriodS: f.wavePeriodS }),
    mesh: f.mesh, timeStepS: f.timeStepS, durationS: f.durationS,
  };
}

type JsonObject = Record<string, unknown>;
interface CfdJob extends JsonObject {
  id: string;
  status: string;
  stage?: string;
  logTail?: string[];
  error?: string;
  result?: JsonObject;
}
export interface CfdPanelOptions {
  button?: HTMLElement;
  bindButton?:boolean;
  getSelection: () => CfdSelection | null;
  notify?: (message: string) => void;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const num = (v: unknown,d=4) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—";
function obj(v: unknown): JsonObject { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {}; }
function pick(v: JsonObject,...keys:string[]) { for (const k of keys) if (v[k] !== undefined) return v[k]; return undefined; }

function cgSourceLabel(load:JsonObject):string {
  return load.cgSource==='cad-estimate'?'CAD estimate · not measured':load.cgSource==='measured'||load.cgMeasured===true?'Measured CG':'CG source not recorded';
}

/** Keep the physical load assumptions visible alongside exported solver readings. */
export function cfdCgSheet(request:unknown,load:unknown):Sheet {
  const req=obj(request),l=obj(load),spec=obj(req.cgEstimate),cg=Array.isArray(l.cgM)?l.cgM:Array.isArray(req.cgM)?req.cgM:[];
  const payloads=(Array.isArray(spec.payloads)?spec.payloads:[]).map(obj);
  const numeric=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const total=numeric(l.massKg??req.massKg),added=payloads.reduce((sum,p)=>sum+(numeric(p.massKg)??0),0);
  const assumptions=Array.isArray(l.cgAssumptions)?l.cgAssumptions:Array.isArray(req.cgAssumptions)?req.cgAssumptions:[];
  return {name:'Mass and CG',widths:[42,55,22,22,22],freezeRows:1,rows:[
    ['Field','Value','X (m)','Y (m)','Z (m)'],
    ['CG source',cgSourceLabel({...req,...l})],
    ['Loaded mass (kg)',total],
    ['Mass source',l.massSource==='protocol-default'||req.massSource==='protocol-default'?'Standard imposed protocol load · not measured':'Measured total mass'],
    ['Loaded CG (model axes)',null,...cg.map(numeric)],
    ['Axes','X from stern; Y from centreline; Z above keel'],
    ...(req.cgSource==='cad-estimate'||l.cgSource==='cad-estimate'?[
      ['CAD distribution',String(spec.distribution??'see case cg-estimate.json')],
      ['Mass following CAD distribution (kg)',total===null?null:total-added],
      ['Added point masses (kg)',added],
      ['Assumptions accepted',req.assumptionsConfirmed===true||l.cgAssumptionsConfirmed===true?'Yes':'Not recorded'],
      ...payloads.map(p=>[String(p.name??'Added mass'),numeric(p.massKg),...(Array.isArray(p.positionM)?p.positionM:[]).map(numeric)]),
      ...assumptions.map(a=>['CG assumption',String(a)]),
      ['Limitation','Uniform CAD material/thickness; infill and unlisted equipment are not inferred.'],
    ]:[]),
  ]};
}

/** A local-service control panel. CFD readings never enter the approximate leaderboard. */
export function attachCfdPanel(options: CfdPanelOptions) {
  const dialog = document.createElement("dialog");
  dialog.className = "cfd-dialog";
  dialog.setAttribute("aria-label","OpenFOAM hull testing");
  document.body.appendChild(dialog);
  let selected:CfdSelection|null=null;
  let serviceAvailable=false;
  let activeId:string|null=null;
  let pollTimer=0;
  let polling=false;
  let alive=true;
  const finished:CfdJob[]=[];
  const jobNames=new Map<string,string>();
  let cgCache:{geometryMode:CfdFormInput['geometryMode'];distribution:MassDistribution;model:CadMassProperties}|null=null;
  let cgTimer=0;
  const button=options.bindButton===false?null:options.button??document.getElementById("cfd");
  const get = <T extends HTMLElement>(id:string) => dialog.querySelector<T>(`#${id}`)!;
  async function api(path:string, init?:RequestInit):Promise<JsonObject> {
    const response=await fetch(path,{...init,headers:{"Content-Type":"application/json",...init?.headers}});
    let data:JsonObject;
    try { data=await response.json() as JsonObject; } catch { throw new Error("The local OpenFOAM service is unavailable. Start this app with npm run cfd, then open its local URL."); }
    if(!response.ok)throw new Error(String(data.error??data.message??`Request failed (${response.status})`));
    return data;
  }
  function form() : CfdFormInput {
    const value=(id:string)=>get<HTMLInputElement>(id).valueAsNumber;
    return {
      maxCells:value("cfd-cells"),domainScale:value("cfd-domain"),
      mode:get<HTMLSelectElement>("cfd-mode").value as CfdFormInput["mode"],geometryMode:get<HTMLSelectElement>("cfd-geometry").value as CfdFormInput["geometryMode"],
      massG:value("cfd-mass"),cgMm:[value("cfd-cgx"),value("cfd-cgy"),value("cfd-cgz")],measuredMassCg:get<HTMLInputElement>("cfd-measured").checked,
      cgSource:get<HTMLSelectElement>("cfd-cg-source").value as 'measured'|'cad-estimate',
      cgDistribution:get<HTMLSelectElement>("cfd-cg-distribution").value as MassDistribution,
      cgAssumptionsConfirmed:get<HTMLInputElement>("cfd-measured").checked,
      cgPayloads:['ballast','cargo'].map((id,i)=>({name:i===0?'Ballast / equipment':'Cargo / luggage',massG:get<HTMLInputElement>(`cfd-${id}-mass`).value===''?0:value(`cfd-${id}-mass`),positionMm:[value(`cfd-${id}-x`),value(`cfd-${id}-y`),value(`cfd-${id}-z`)] as [number,number,number]})),
      inertiaKgM2:[value("cfd-ix"),value("cfd-iy"),value("cfd-iz")],inertiaMeasured:get<HTMLInputElement>("cfd-inertia-measured").checked,
      minimumWallThicknessMm:value("cfd-wall"),speedMps:value("cfd-speed"),waveHeightMm:value("cfd-height"),wavePeriodS:value("cfd-period"),
      mesh:get<HTMLSelectElement>("cfd-mesh").value as CfdFormInput["mesh"],timeStepS:value("cfd-dt"),durationS:value("cfd-duration"),
    };
  }
  function error(message:string) { get("cfd-error").textContent=message; }
  function configureCgDistribution() {
    const mode=get<HTMLSelectElement>('cfd-geometry').value as CfdFormInput['geometryMode'],select=get<HTMLSelectElement>('cfd-cg-distribution');
    const previous=select.value;
    select.innerHTML=mode==='printed-shell'?'<option value="material">Uniform printed material</option>':mode==='open-surface'?'<option value="shell">Uniform thin wall · no virtual deck mass</option>':'<option value="shell">Uniform thin shell</option><option value="solid">Uniform solid body</option>';
    if(mode==='closed-envelope'&&['solid','shell'].includes(previous))select.value=previous;
    select.disabled=mode!=='closed-envelope';
  }
  function refreshCg() {
    if(!selected)return;
    const source=get<HTMLSelectElement>('cfd-cg-source').value,automatic=source==='cad-estimate';
    get('cfd-cad-options').hidden=!automatic;
    get('cfd-cad-options').querySelectorAll<HTMLInputElement>('input').forEach(field=>{field.disabled=!automatic;});
    get<HTMLSelectElement>('cfd-cg-distribution').disabled=!automatic||get<HTMLSelectElement>('cfd-geometry').value!=='closed-envelope';
    get('cfd-mass-confirm-label').textContent=automatic?'I confirmed the total loaded mass and accept the CAD CG assumptions.':'I entered measured loaded mass and CG in the displayed model’s axes.';
    const inertiaCheck=get<HTMLInputElement>('cfd-inertia-measured');
    inertiaCheck.disabled=automatic;
    if(inertiaCheck.parentElement)inertiaCheck.parentElement.hidden=automatic;
    if(automatic)inertiaCheck.checked=false;
    for(const axis of ['x','y','z'])get<HTMLInputElement>(`cfd-i${axis}`).readOnly=automatic;
    for(const axis of ['x','y','z']){const field=get<HTMLInputElement>(`cfd-cg${axis}`);field.readOnly=automatic;field.required=!automatic;}
    const note=get('cfd-cg-note');note.className='cfd-note cfd-cg-note';
    if(!automatic){note.textContent='Manual mode: enter measured CG. CAD-derived values are estimates, not measurements.';return;}
    try {
      const f=form(),distribution=f.cgDistribution??defaultDistribution(f.geometryMode);
      if(!cgCache||cgCache.geometryMode!==f.geometryMode||cgCache.distribution!==distribution){
        cgCache={geometryMode:f.geometryMode,distribution,model:estimateMassProperties({trianglesMm:selected.trianglesMm,geometryMode:f.geometryMode,distribution,hullMassKg:1})};
      }
      const payloads=payloadsFromUi(f.cgPayloads),payloadMass=payloads.reduce((s,p)=>s+p.massKg,0),total=f.massG/1000,hullMass=total-payloadMass;
      if(!Number.isFinite(total)||total<=0)throw new Error('Enter a positive total loaded mass.');
      if(hullMass<=0)throw new Error('Ballast and cargo must weigh less than the total loaded mass.');
      const cg=cgCache.model.hullCgM.map((v,i)=>(hullMass*v+payloads.reduce((s,p)=>s+p.massKg*p.positionM[i],0))/total);
      ['x','y','z'].forEach((axis,i)=>{get<HTMLInputElement>(`cfd-cg${axis}`).value=(cg[i]*1000).toFixed(2);});
      const diagonal=cgCache.model.diagonalInertiaKgM2.map((unit,i)=>{
        const offset=cgCache!.model.hullCgM.map((v,k)=>v-cg[k]);
        return hullMass*(unit+offset.reduce((s,x,k)=>s+(k===i?0:x*x),0))+payloads.reduce((s,p)=>s+p.massKg*p.positionM.reduce((a,x,k)=>a+(k===i?0:(x-cg[k])**2),0),0);
      });
      ['x','y','z'].forEach((axis,i)=>{get<HTMLInputElement>(`cfd-i${axis}`).value=diagonal[i].toPrecision(6);});
      note.textContent=`CAD estimate · ${distribution==='material'?'uniform printed material':distribution==='solid'?'uniform solid body':'uniform thin wall'}. Hull ${(hullMass*1000).toFixed(1)} g + added masses ${(payloadMass*1000).toFixed(1)} g. Infill and unlisted equipment are not inferred; virtual buoyancy caps add no mass.`;
    }catch(e){
      for(const axis of ['x','y','z'])get<HTMLInputElement>(`cfd-cg${axis}`).value='';
      note.className='cfd-note cfd-cg-note cfd-cg-error';note.textContent='CG estimate unavailable: '+(e as Error).message;
    }
  }
  function scheduleCg(){clearTimeout(cgTimer);cgTimer=window.setTimeout(refreshCg,200);}
  function updateMode() {
    const mode=get<HTMLSelectElement>("cfd-mode").value;
    get("cfd-wave-fields").hidden=mode==="calm";
    get("cfd-inertia-fields").hidden=mode!=="beam-waves";
    const speed=get<HTMLInputElement>("cfd-speed");
    speed.disabled=mode!=="calm";
    if(mode!=="calm")speed.value="0";
    else if(speed.valueAsNumber===0)speed.value=String(selected?.speedMps||.4);
    get("cfd-wall-field").hidden=get<HTMLSelectElement>("cfd-geometry").value!=="printed-shell";
    configureCgDistribution();refreshCg();
  }
  async function status() {
    const target=get("cfd-service");
    target.textContent="Checking local OpenFOAM service…";
    try {
      const data=await api("/api/cfd/status");
      if(!alive||!dialog.open)return;
      serviceAvailable=data.available===true;
      target.className=`cfd-service ${serviceAvailable?"ready":"offline"}`;
      target.textContent=serviceAvailable?`OpenFOAM ${data.version??"2312"} available · local Docker solver`:`OpenFOAM unavailable: ${String(data.message??"check Docker and the solver image")}`;
    } catch(e) {
      serviceAvailable=false;target.className="cfd-service offline";
      target.textContent=(e as Error).message;
    }
    get("cfd-local-links").hidden=serviceAvailable;
    get<HTMLButtonElement>("cfd-run").disabled=!serviceAvailable||!!activeId||!selected;
  }
  function resultHtml(job:CfdJob) {
    const result=obj(job.result),forces=obj(result.forces),motion=obj(result.motion),mesh=obj(result.mesh),quality=obj(result.quality),hydro=obj(result.hydro);
    const meanDrag=pick(forces,"meanDragN","dragMeanN");
    const deviation=pick(forces,"dragStandardDeviationN","dragStdN","standardDeviationDragN","stdDragN");
    const vertical=pick(forces,"meanVerticalForceN","verticalForceN");
    const roll=pick(motion,"maxRollDeg","rollAmplitudeDeg");
    const warnings=[...((Array.isArray(result.warnings)?result.warnings:[]) as unknown[]),...((Array.isArray(forces.warnings)?forces.warnings:[]) as unknown[]),...((Array.isArray(quality.warnings)?quality.warnings:[]) as unknown[])];
    const kind=obj(obj(result.manifest).condition).kind;
    const cgLabel=cgSourceLabel(obj(obj(result.manifest).load));
    const forceLabel=kind==="calm"?"Mean towing resistance":"Mean −X fluid force";
    return `<div class="cfd-results"><div class="cfd-result-title"><b>OpenFOAM output</b><span>Physical validation still required</span></div><p class="cfd-note"><b>${esc(jobNames.get(job.id)??job.name??obj(job.request).name??"Hull identified by recorded geometry hash")}</b> · Geometry ${esc(String(obj(result.manifest).sourceHash??result.geometryHash??"unavailable").slice(0,16))}</p><div class="cfd-metrics"><div><small>${forceLabel}</small><strong>${num(meanDrag,6)} <i>N</i></strong></div><div><small>Force standard deviation</small><strong>${num(deviation,6)} <i>N</i></strong></div><div><small>Vertical fluid force</small><strong>${num(vertical,5)} <i>N</i></strong></div><div><small>Maximum recorded roll</small><strong>${num(roll,3)} <i>°</i></strong></div></div><p class="cfd-note">${esc(mesh.cells??"Unknown")} cells · Job ${esc(job.id)}. Vertical force includes pressure and viscous effects; it is not pure hydrostatic buoyancy.</p><p class="cfd-note"><b>Numerical review:</b> ${esc(result.status??"unverified")} · Mesh safety: ${quality.meshOkay===true?"passed":"not established"}; detailed geometry: ${quality.detailedMeshOkay===true?"passed":"needs review"}; final time: ${quality.completedTime===true?"reached":"not established"}. No validated placement is assigned.</p><p class="cfd-note"><b>Initial hydrostatics:</b> draft ${num(typeof hydro.draftM==="number"?hydro.draftM*1000:null,2)} mm · GM ${num(typeof hydro.gmM==="number"?hydro.gmM*1000:null,2)} mm · buoyancy ${num(hydro.buoyancyN,4)} N · freeboard ${num(typeof hydro.freeboardM==="number"?hydro.freeboardM*1000:null,2)} mm. Fixed-trim initialization using your supplied mass. CG: ${esc(cgLabel)}.</p>${warnings.length?`<ul class="cfd-warnings">${warnings.map(w=>`<li>${esc(w)}</li>`).join("")}</ul>`:""}<div class="cfd-downloads"><button class="btn small" data-cfd-download="excel">CFD Excel</button><button class="btn small" data-cfd-download="json">Result JSON</button><a class="btn small" href="/api/cfd/jobs/${encodeURIComponent(job.id)}/download" download>Case ZIP</a></div>${convergenceHtml(job)}<p class="cfd-note">Run coarse, medium and fine meshes, and repeat with a smaller time step before using forces for placements. Completion alone does not establish convergence.</p></div>`;
  }
  function convergenceHtml(latest:CfdJob) {
    const record=(job:CfdJob):RefinementRun|null=>{
      const r=obj(job.result),m=obj(r.manifest),geometryHash=r.geometryHash??m.sourceHash,protocolHash=r.protocolHash??m.protocolKey;
      const drag=obj(r.forces).meanDragN,cells=obj(r.mesh).cells;
      if(typeof geometryHash!=="string"||!geometryHash||typeof protocolHash!=="string"||!protocolHash||typeof drag!=="number"||!Number.isFinite(drag)||typeof cells!=="number"||!Number.isInteger(cells)||cells<=0)return null;
      return {label:`${String(obj(m.mesh).level??"mesh")} · ${job.id.slice(0,8)}`,geometryHash,protocolHash,meanDragN:drag,cellCount:cells};
    };
    const reference=record(latest);
    if(!reference)return '<p class="cfd-note">Refinement comparison unavailable: verified mesh counts or source/protocol hashes are missing.</p>';
    const raw=[...finished.filter(j=>j.id!==latest.id),latest].map(record).filter((r):r is RefinementRun=>!!r&&r.geometryHash===reference.geometryHash&&r.protocolHash===reference.protocolHash);
    const unique=[...new Map(raw.map(r=>[r.cellCount,r])).values()];
    if(unique.length<2)return '<p class="cfd-note">No matching refinement run yet. Repeat this geometry and physical protocol at another mesh level; results from different conditions are excluded.</p>';
    try {
      const comparison=compareRefinements(unique,{parameter:"mesh",tolerance:.02});
      return `<div class="cfd-refinement"><b>Matching mesh runs · this session</b><table><thead><tr><th>Run</th><th>Actual cells</th><th>Mean −X force (N)</th></tr></thead><tbody>${comparison.orderedRuns.map(r=>`<tr><td>${esc(r.label)}</td><td>${r.cellCount.toLocaleString()}</td><td>${num(r.meanDragN,6)}</td></tr>`).join("")}</tbody></table><p class="cfd-note">Finest-pair change: ${comparison.finestPairRelativeChange===null?"undefined near zero force":`${num(comparison.finestPairRelativeChange*100,2)}%`}. ${unique.length<3?"At least three systematic mesh levels are recommended. ":""}This diagnostic difference is not a GCI error bound or physical validation. Time-step and domain studies remain required.</p></div>`;
    }catch(e){return `<p class="cfd-note">Refinement comparison unavailable: ${esc((e as Error).message)}</p>`;}
  }
  function renderJob(job:CfdJob) {
    const logs=Array.isArray(job.logTail)?job.logTail.slice(-80):[];
    get("cfd-job").innerHTML=`<div class="cfd-job-heading"><b>${esc(job.status)}</b><span>${esc(job.stage??"")}</span>${!["completed","failed","cancelled"].includes(job.status)?'<button class="btn small" data-cfd-cancel>Cancel job</button>':""}</div><p class="cfd-note">Job hull: ${esc(jobNames.get(job.id)??job.name??obj(job.request).name??"see recorded geometry hash")}</p>${job.error?`<p class="cfd-error">${esc(job.error)}</p>`:""}${job.result?resultHtml(job):""}<details class="cfd-log"><summary>Solver log</summary><pre>${esc(logs.join("\n")||"Waiting for solver output…")}</pre></details>`;
    get("cfd-job").querySelector("[data-cfd-cancel]")?.addEventListener("click",async()=>{try{await api(`/api/cfd/jobs/${encodeURIComponent(job.id)}/cancel`,{method:"POST",body:"{}"});await poll();}catch(e){error((e as Error).message);}});
    get("cfd-job").querySelector('[data-cfd-download="json"]')?.addEventListener("click",()=>download(new TextEncoder().encode(JSON.stringify(job.result,null,2)),`openfoam-${job.id}.json`,"application/json"));
    get("cfd-job").querySelector('[data-cfd-download="excel"]')?.addEventListener("click",()=>downloadCfdExcel(job));
  }
  async function poll() {
    if(!activeId||!alive||polling)return;
    clearTimeout(pollTimer);polling=true;
    try {
      const job=await api(`/api/cfd/jobs/${encodeURIComponent(activeId)}`) as CfdJob;
      if(!alive)return;
      if(dialog.open)renderJob(job);
      if(["completed","failed","cancelled"].includes(job.status)) {
        if(job.result)finished.push(job);
        activeId=null;
        if(dialog.open)get<HTMLButtonElement>("cfd-run").disabled=!serviceAvailable||!selected;
        options.notify?.(`OpenFOAM job ${job.status}.`);
      } else pollTimer=window.setTimeout(()=>void poll(),1800);
    } catch(e) {
      if(dialog.open)error((e as Error).message);
      pollTimer=window.setTimeout(()=>void poll(),4000);
    } finally {polling=false;}
  }
  async function submit(ev:Event) {
    ev.preventDefault();error("");
    if(!selected)return error("Choose a hull first.");
    if(activeId)return error("The selected job is still running. Wait or cancel it first.");
    try {
      const request=buildCfdRequest(selected,form());
      get<HTMLButtonElement>("cfd-run").disabled=true;
      const data=await api("/api/cfd/jobs",{method:"POST",body:JSON.stringify(request)});
      if(typeof data.id!=="string")throw new Error("The server did not return a job identifier.");
      activeId=data.id;jobNames.set(data.id,request.name);void poll();
    }catch(e){error((e as Error).message);get<HTMLButtonElement>("cfd-run").disabled=!serviceAvailable;}
  }
  function open() {
    selected=options.getSelection();
    // Keep the geometry being estimated fixed while the modal is open.
    if(selected)selected={...selected,trianglesMm:selected.trianglesMm.slice()};
    cgCache=null;
    const cg=selected?.cgM?.map(v=>v*1000);
    const numberInput=(id:string,label:string,value:number|undefined,unit:string,extra="")=>`<label><span>${label} <small>${unit}</small></span><input id="${id}" type="number" step="any" ${Number.isFinite(value)?`value="${value}"`:""} ${extra}></label>`;
    const cgPanel=`<div class="cfd-cg-heading"><label><span>Centre of gravity</span><select id="cfd-cg-source"><option value="cad-estimate">Calculate from CAD · estimate</option><option value="measured">Enter measured CG</option></select></label><span class="cfd-cg-tag">X from stern · Y from centreline · Z above keel</span></div><div id="cfd-cad-options"><label class="cfd-cg-model"><span>CAD mass distribution</span><select id="cfd-cg-distribution"></select></label><details class="cfd-advanced"><summary>Ballast and cargo not included in the CAD</summary><p class="cfd-note">The loaded mass above includes the hull and these additions. Each addition is treated as a point mass at the position you enter. Any remaining mass follows the CAD distribution.</p>${['ballast','cargo'].map((id,i)=>`<div class="cfd-cg-payload"><b>${i===0?'Ballast / equipment':'Cargo / luggage'}</b><div class="cfd-grid four">${numberInput(`cfd-${id}-mass`,'Mass',0,'g','min=0')}${numberInput(`cfd-${id}-x`,'Position X',undefined,'mm from stern')}${numberInput(`cfd-${id}-y`,'Position Y',undefined,'mm from centreline')}${numberInput(`cfd-${id}-z`,'Position Z',undefined,'mm above keel')}</div></div>`).join('')}</details></div><div class="cfd-grid three">${numberInput('cfd-cgx','CG X',cg?.[0],'mm from stern')}${numberInput('cfd-cgy','CG Y',cg?.[1],'mm from centreline')}${numberInput('cfd-cgz','CG Z',cg?.[2],'mm above keel')}</div><p id="cfd-cg-note" class="cfd-note" aria-live="polite">Calculating CAD CG…</p><label class="cfd-check"><input type="checkbox" id="cfd-measured" required><span id="cfd-mass-confirm-label">I confirmed the total loaded mass and accept the CAD CG assumptions.</span></label>`;
    dialog.innerHTML=`<div class="cfd-title"><div><small>LOCAL CFD WORKFLOW</small><h2>OpenFOAM tests</h2></div><button class="btn small" id="cfd-close" type="button" aria-label="Close OpenFOAM panel">Close</button></div><div class="cfd-content"><div id="cfd-service" class="cfd-service">Checking solver…</div><p class="cfd-note">${selected?`Selected hull: <b>${esc(selected.name)}</b> · ${selected.sizeMm.map(v=>num(v,1)).join(" × ")} mm`:'Choose an STL in the test bench first.'}</p><p class="cfd-note">The quick preview and leaderboard remain estimates. This workflow runs OpenFOAM locally and records its actual output separately. A solve may take minutes to hours. <span id="cfd-local-links"><a href="/downloads/Hull-Test-Bench-OpenFOAM.zip" download>Download the local app</a> · <a href="/download.html">Setup and audit</a></span></p><form id="cfd-form"><div class="cfd-grid"><label><span>CFD test</span><select id="cfd-mode"><option value="calm">Calm-water resistance · fixed hull</option><option value="head-waves">Regular head-wave force · fixed hull, no tow</option><option value="beam-waves">Regular beam waves · free heave and roll</option></select></label><label><span>Actual CAD geometry</span><select id="cfd-geometry"><option value="closed-envelope">Closed outer displacement hull</option><option value="printed-shell">Thin-wall printed boat</option><option value="open-surface">Open exterior surface · virtual cap</option></select></label>${numberInput("cfd-mass","Loaded mass",selected?.massG,"g","min=0.001 required")}${numberInput("cfd-speed","Tow speed",selected?.speedMps??.4,"m/s","min=0 max=3 required")}</div>${cgPanel}<div id="cfd-wall-field" hidden>${numberInput("cfd-wall","Minimum printed wall thickness",undefined,"mm","min=0.01")}</div><div class="cfd-grid" id="cfd-wave-fields" hidden>${numberInput("cfd-height","Regular wave height",selected?.waveHeightMm??7.3,"mm crest to trough","min=0")}${numberInput("cfd-period","Regular wave period",selected?.wavePeriodS??.45,"s","min=0.01")}</div><p class="cfd-note">Wave height here describes one regular wave. It is not the significant height of the preview's irregular sea.</p><div id="cfd-inertia-fields" hidden><p class="cfd-note">CAD mode automatically calculates inertia from the same mass distribution. These read-only values are model-axis components; the solver uses the full tensor projected onto the constrained roll axis. Measured CG mode accepts measured moments with principal axes aligned to model axes.</p><div class="cfd-grid three">${numberInput("cfd-ix","Ixx roll",undefined,"kg·m²","min=0")}${numberInput("cfd-iy","Iyy pitch",undefined,"kg·m²","min=0")}${numberInput("cfd-iz","Izz yaw",undefined,"kg·m²","min=0")}</div><label class="cfd-check"><input type="checkbox" id="cfd-inertia-measured"><span>These moments of inertia were measured for this loaded design.</span></label></div><details class="cfd-advanced"><summary>Mesh and run settings</summary><div class="cfd-grid three"><label><span>Mesh</span><select id="cfd-mesh"><option value="coarse">Coarse · first check</option><option value="medium">Medium</option><option value="fine">Fine</option></select></label>${numberInput("cfd-dt","Initial time step",.0005,"s","min=0.000001 max=0.01 required")}${numberInput("cfd-duration","Simulation duration",10,"s","min=0.01 max=600 required")}${numberInput("cfd-cells","Mesh cell budget",750000,"cells · waves may need millions","min=10000 max=20000000 required")}${numberInput("cfd-domain","Domain clearance scale",1,"×","min=1 max=4 step=0.25 required")}</div><p class="cfd-note">Use the same physical protocol for mesh and time-step comparisons. An unconverged result is not a validated prediction.</p></details><p id="cfd-error" class="cfd-error" role="alert"></p><button type="submit" class="btn primary" id="cfd-run" disabled>${activeId?"Job running…":"Run OpenFOAM test"}</button></form><div id="cfd-job" aria-live="polite"></div><details class="cfd-advanced"><summary>What improves accuracy?</summary><p class="cfd-note">Inspect the surface mesh and checkMesh report. Refine the mesh, reduce the time step and enlarge the domain until forces and motion are insensitive to those choices. Compare representative hulls with physical tow or wave tests. A virtual cap prevents real open-boat flooding; its results must be limited to a dry rim.</p></details></div>`;
    get("cfd-close").addEventListener("click",close);
    get("cfd-form").addEventListener("submit",ev=>void submit(ev));
    get("cfd-mode").addEventListener("change",updateMode);
    get("cfd-geometry").addEventListener("change",()=>{get<HTMLInputElement>('cfd-measured').checked=false;updateMode();});
    get('cfd-cg-source').addEventListener('change',()=>{
      get<HTMLInputElement>('cfd-measured').checked=false;
      if(get<HTMLSelectElement>('cfd-cg-source').value==='measured')for(const a of ['x','y','z']){get<HTMLInputElement>(`cfd-cg${a}`).value='';get<HTMLInputElement>(`cfd-i${a}`).value='';}
      refreshCg();
    });
    get('cfd-cg-distribution').addEventListener('change',()=>{get<HTMLInputElement>('cfd-measured').checked=false;refreshCg();});
    get('cfd-mass').addEventListener('input',scheduleCg);
    get('cfd-cad-options').addEventListener('input',scheduleCg);
    dialog.showModal();updateMode();void status();
    if(activeId)void poll();else if(finished.length)renderJob(finished[finished.length-1]);
  }
  function close() {dialog.close();}
  function download(bytes:Uint8Array,name:string,mime:string) {
    const a=document.createElement("a"),url=URL.createObjectURL(new Blob([bytes as unknown as BlobPart],{type:mime}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function downloadCfdExcel(job:CfdJob) {
    const r=obj(job.result),f=obj(r.forces),q=obj(r.quality),m=obj(r.manifest),motion=obj(r.motion);
    const numeric=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
    const sheets:Sheet[]=[{name:"OpenFOAM results",rows:[["Actual OpenFOAM output — physical validation still required"],["Job",job.id],["Status",job.status],["Solver",String(obj(m.solver).application??"interFoam")],["Version",String(obj(m.solver).version??"2312")],["Mean -X fluid force (N)",numeric(pick(f,"meanDragN","dragMeanN"))],["Drag std (N)",numeric(pick(f,"dragStandardDeviationN","dragStdN","standardDeviationDragN","stdDragN"))],["Vertical fluid force (N)",numeric(pick(f,"meanVerticalForceN","verticalForceN"))],["Maximum recorded roll (deg)",numeric(pick(motion,"maxRollDeg","rollAmplitudeDeg"))],["Source","OpenFOAM; not the approximate preview"],["Validation","Mesh/time-step/domain convergence and physical validation required"]],widths:[45,95]},
      cfdCgSheet(job.request,m.load),
      {name:"Initial hydrostatics",rows:[["Field","Value (SI unless named)"],...Object.entries(obj(r.hydro)).map(([k,v])=>[k,typeof v==="number"||typeof v==="string"?v:JSON.stringify(v)])],widths:[45,110],freezeRows:1},
      {name:"Run metadata",rows:[["Field","Value"],...Object.entries(m).map(([k,v])=>[k,typeof v==="string"||typeof v==="number"?v:JSON.stringify(v)])],widths:[40,120],freezeRows:1},
      {name:"Numerical quality",rows:[["Field","Value"],...Object.entries(q).map(([k,v])=>[k,typeof v==="string"||typeof v==="number"?v:JSON.stringify(v)]),...[...(Array.isArray(f.warnings)?f.warnings:[])].map(v=>["Force warning",String(v)])],widths:[40,120],freezeRows:1}];
    download(buildXlsx(sheets),`openfoam-${job.id}.xlsx`,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  button?.addEventListener("click",open);
  return {open,close,refreshSelection:()=>{const next=options.getSelection();selected=next?{...next,trianglesMm:next.trianglesMm.slice()}:null;cgCache=null;if(dialog.open&&selected)refreshCg();},destroy:()=>{alive=false;clearTimeout(cgTimer);clearTimeout(pollTimer);button?.removeEventListener("click",open);dialog.remove();}};
}
