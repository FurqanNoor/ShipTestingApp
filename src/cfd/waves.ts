/** Native OpenCFD v2312 regular waves. Advancing-wave/current cases are deliberately unsupported. */
import { type CfdCasePackage, type CfdManifest, type Vec3, CALM_REFERENCE_FUNCTION, foamHeader, foamNumber, foamVector } from './case';
import {diagonalizeInertia,type Matrix3} from './massProperties';

export interface WaveCaseSettings {
  kind:'head-waves'|'beam-waves';
  /** Wave-maker amplitude gain from empty-tank calibration (default 1): compensates the systematic height loss of the grid. */
  generationGain?:number;
  /** Regular crest-to-trough height H, not significant irregular-sea height Hs. */
  heightM:number;
  /** Regular wave period in initially still water. */
  periodS:number;
  /** Optional repeat measurements must agree with the underlying case manifest. */
  massKg?:number;
  cgM?:Vec3;
  /** Principal moments about the supplied loaded CG, kg mÂ². Pair with inertiaOrientation. */
  inertiaKgM2?:Vec3;
  inertiaMeasured?:boolean;
  inertiaSource?:'measured'|'cad-estimate';
  /** Columns are principal axes in the placed model frame; identity for manual body-axis moments. */
  inertiaOrientation?:Matrix3;
  inertiaAssumptions?:string[];
  /** Full inertia about loaded CG, in placed model/world axes; preferred for CAD estimates. */
  inertiaTensorKgM2?:Matrix3;
  /** Free rotation direction in the placed solver/world frame; initial longitudinal hull axis. */
  rollAxis?:Vec3;
}
export interface WaveMetadata {
  model:'StokesI';
  heightDefinition:'regular crest-to-trough';
  periodDefinition:'still-water regular period';
  originalIrregularPresetEquivalent:false;
  inletPatch:'inlet'|'starboard';
  absorptionPatch:'outlet'|'port';
  /** Damping zone that absorbs waves before the far wall (deep-water shallowWaterAbsorption was unstable). */
  sponge?:{lengthM:number;wavelengths:number;zones:number;maxRateS:number;minM:Vec3;maxM:Vec3};
  generation?:{method:'relaxation-zone';gain:number;lengthM:number;wavelengths:number;maxRateS:number;kinematics:string;rampTimeS:number};
  propagationDirection:Vec3;
  waveLengthM:number;
  waterDepthM:number;
  meanCurrentMps:0;
  boundaryHeightCells:number;
  boundaryWavelengthCells:number;
  backgroundCells:number;
  freeSurfaceVerticalCells:number;
  waveResolutionVerified:false;
  reflectedWaveFraction:number|null;
  sources:string[];
}
export interface MotionMetadata {
  degreesOfFreedom:['heave-Z','roll-X'|'roll-about-hull-axis'];
  inertiaKgM2:Vec3;
  inertiaMeasured:boolean;
  inertiaSource:'measured'|'cad-estimate';
  inertiaAssumptions:string[];
  /** Native initial body orientation. Physical points transform by Q * initialQ.T. */
  initialOrientation:Matrix3;
  rollAxis:Vec3;
  inertiaTensorKgM2:Matrix3;
  inertiaFrame:'constrained-roll-body-frame';
  inertiaProjection:'effective inertia a^T I a for the only free rotation';
  effectiveRollInertiaKgM2:number;
  principalMomentsKgM2:Vec3;
  principalOrientation:Matrix3;
  initialCentreOfMassM:Vec3;
  stateFile:string;
  angles:'radians';
  meshMotion:'morphing';
}
export type WaveCasePackage=CfdCasePackage&{manifest:CfdManifest&{waves:WaveMetadata;motion?:MotionMetadata}};

export const WAVE_METHOD_SOURCES=[
  'https://doc.openfoam.com/2312/tools/processing/models/wave-models/regular/rtm/stokesI/',
  'https://api.openfoam.com/2312/waveVelocityFvPatchVectorField_8C_source.html',
  'https://api.openfoam.com/2312/waveModel_8C_source.html',
  'https://api.openfoam.com/2312/StokesIWaveModel_8C_source.html',
  'https://api.openfoam.com/2312/sixDoFRigidBodyMotionLineConstraint_8C_source.html',
  'https://api.openfoam.com/2312/sixDoFRigidBodyMotionAxisConstraint_8C_source.html',
  'https://api.openfoam.com/2312/sixDoFRigidBodyState_8C_source.html',
] as const;

function positive(v:number,name:string) {
  if(!Number.isFinite(v)||v<=0)throw new Error(`${name} must be finite and positive.`);
}
function checkedOrientation(value:Matrix3|undefined):Matrix3 {
  const q:Matrix3=value??[[1,0,0],[0,1,0],[0,0,1]];
  if(!Array.isArray(q)||q.length!==3||q.some(row=>!Array.isArray(row)||row.length!==3||row.some(v=>!Number.isFinite(v))))throw new Error('Principal inertia orientation must be a finite 3 Ã— 3 matrix.');
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){
    const product=q.reduce((sum,row)=>sum+row[i]*row[j],0);
    if(Math.abs(product-(i===j?1:0))>1e-8)throw new Error('Principal inertia orientation must be orthonormal.');
  }
  const determinant=q[0][0]*(q[1][1]*q[2][2]-q[1][2]*q[2][1])-q[0][1]*(q[1][0]*q[2][2]-q[1][2]*q[2][0])+q[0][2]*(q[1][0]*q[2][1]-q[1][1]*q[2][0]);
  if(Math.abs(determinant-1)>1e-8)throw new Error('Principal inertia orientation must be a right-handed proper rotation.');
  return q.map(row=>[...row]) as Matrix3;
}

/**
 * The native axis constraint projects BODY angular momentum. A frame aligned to
 * the sole allowed rotation and its effective axial inertia give the exact
 * reduced rotational kinetic energy, even when that axis is not principal.
 * Off-axis angular momentum is supplied by the constrained reaction moments.
 */
export function constrainedRollInertia(tensor:Matrix3,axis:Vec3) {
  const principal=diagonalizeInertia(tensor);
  if(principal.momentsKgM2.some(v=>v<=0))throw new Error('Free-roll inertia must have positive principal moments.');
  if(!Array.isArray(axis)||axis.length!==3||axis.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...axis)-1)>1e-8)throw new Error('The free-roll axis must be a finite unit vector in model/world coordinates.');
  const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const reference:Vec3=Math.abs(axis[2])<.9?[0,0,1]:[0,1,0];
  const y=cross(reference,axis),length=Math.hypot(...y);for(let i=0;i<3;i++)y[i]/=length;
  const z=cross(axis,y),orientation:Matrix3=[[axis[0],y[0],z[0]],[axis[1],y[1],z[1]],[axis[2],y[2],z[2]]];
  checkedOrientation(orientation);
  const diagonal=([axis,y,z].map(a=>a.reduce((sum,v,i)=>sum+v*tensor[i].reduce((s,t,j)=>s+t*a[j],0),0))) as Vec3;
  return {orientation,diagonal,effectiveRollInertiaKgM2:diagonal[0],principal};
}
function textFile(pkg:CfdCasePackage,path:string):string {
  const text=pkg.files[path];if(typeof text!=='string')throw new Error(`The base case is missing a text ${path}.`);return text;
}
/** Known generator dictionaries only: replace one brace-delimited named block. */
function block(text:string,name:string,body:string):string {
  const re=new RegExp(`(^|\\n)[ \\t]*${name}\\s*\\{`,'m'),m=re.exec(text);
  if(!m)throw new Error(`Cannot find ${name} in a generated OpenFOAM dictionary.`);
  const open=m.index+m[0].lastIndexOf('{');let depth=1,end=open+1;
  while(depth&&end<text.length){if(text[end]==='{')depth++;else if(text[end]==='}')depth--;end++;}
  if(depth)throw new Error(`Unbalanced ${name} dictionary.`);
  return text.slice(0,m.index)+(m[1]?'\n':'')+`    ${name}\n    {\n${body}\n    }`+text.slice(end);
}
function entry(text:string,name:string,value:string):string {
  const re=new RegExp(`(^|\\n)([ \\t]*)${name}\\s+[^;]*;`,'m');
  if(!re.test(text))throw new Error(`Cannot find generated ${name} entry.`);
  return text.replace(re,(_,line,indent)=>`${line}${indent}${name} ${value};`);
}
function appendFunction(text:string,body:string):string {
  const m=/(^|\n)functions\s*\{/.exec(text);if(!m)throw new Error('The base controlDict has no functions dictionary.');
  const open=m.index+m[0].lastIndexOf('{');let depth=1,end=open+1;
  while(depth&&end<text.length){if(text[end]==='{')depth++;else if(text[end]==='}')depth--;end++;}
  if(depth)throw new Error('Unbalanced functions dictionary.');
  return text.slice(0,end-1)+body+'\n'+text.slice(end-1);
}

/** Solve finite-depth linear dispersion Ï‰Â² = g k tanh(k h) by monotonic bisection. */
export function regularWaveLength(periodS:number,depthM:number,gravity=9.81):number {
  positive(periodS,'Wave period');positive(depthM,'Water depth');positive(gravity,'Gravity');
  const target=(2*Math.PI/periodS)**2;
  let lo=0,hi=Math.max(target/gravity,Math.sqrt(target/(gravity*depthM)));
  while(gravity*hi*Math.tanh(hi*depthM)<target)hi*=2;
  for(let i=0;i<90;i++){const k=(lo+hi)/2;if(gravity*k*Math.tanh(k*depthM)<target)lo=k;else hi=k;}
  return 2*Math.PI/((lo+hi)/2);
}

/**
 * Near-hull cells may be at most this many times wider than tall. The wave band uses very flat cells
 * (a few per wave height, tens per wavelength). Snapping the hull or refinement transitions inside cells
 * that flat produced faces beyond the 65-degree non-orthogonality gate, which stopped every wave case at checkMesh.
 */
export const NEAR_HULL_MAX_ASPECT=4;
/**
 * Wave absorption. Native shallowWaterAbsorption assumes shallow water; these tanks are deep (kh ~ 4-8), and in
 * empty-tank tests every wave case diverged when the wave front reached it. The generator keeps its active absorption
 * (switching it off destabilised the inlet in the same tests). The far side is now a slip wall behind a
 * density-weighted sponge layer over SPONGE_WAVELENGTHS wavelengths whose damping rate ramps smoothly to
 * SPONGE_STRENGTH x the wave angular frequency.
 */
export const SPONGE_WAVELENGTHS=1.5,SPONGE_STRENGTH=2;
export const WAVE_DEPTH_WAVELENGTHS=.6,BEAM_X_MARGIN=.5,BEAM_Y_GAP_WAVELENGTHS=.5;
/**
 * Wave generation. The native boundary wave-maker (waveVelocity/waveAlpha, StokesI) proved unstable in 2D empty-tank
 * tests at this model scale: with active absorption its shallow-water correction ran away (uniform outflow growing from
 * t=0 until the floor corner cell drained); without it, air velocities at the paddle spiked to 20-120 m/s. Waves are
 * instead generated in a relaxation zone GEN_WAVELENGTHS long next to a slip wall: an exprField evaluates linear
 * finite-depth (Stokes I) kinematics each step and a density-weighted acousticDampingSource relaxes U toward it with a
 * rate ramping to GEN_STRENGTH x omega at the wall. The same zone absorbs waves reflected or radiated back toward it.
 */
export const GEN_WAVELENGTHS=1,GEN_STRENGTH=5;

/**
 * A graded background resolves propagation, rather than refining only the hull. Around the hull, a column of
 * cells is split horizontally only (snappyHexMesh directional refinement) until cells are near-isotropic.
 * The column spans the hull and the interface band, and ends vertically where background cells are tall
 * enough that its edge transitions stay orthogonal.
 */
/** Sponge cells grow by this ratio per cell toward the far wall (fewer cells; stretching also damps waves). */
export const SPONGE_CELL_GROWTH=1.1;
type AxisSection={length:number;cells:number;expansion:number};
/** Smooth geometric transition (growth <= 15%/cell) between a fine and a coarse spacing over at most `length`. */
function transition(length:number,fine:number,coarse:number,towardFine:boolean):AxisSection[]{
  if(length<=1e-12)return [];
  if(!(coarse>fine*1.05))return [{length,cells:Math.max(1,Math.ceil(length/Math.max(fine,coarse))),expansion:1}];
  const q=1.15,E=coarse/fine,T=fine*(E-1)/(q-1),graded=Math.min(length,T),ratio=graded<T?1+graded*(q-1)/fine:E;
  const t={length:graded,cells:Math.max(1,Math.ceil(Math.log(ratio)/Math.log(q))),expansion:towardFine?1/ratio:ratio};
  const rest=length-graded,u=rest>1e-12?{length:rest,cells:Math.max(1,Math.ceil(rest/coarse)),expansion:1}:null;
  return towardFine?[...(u?[u]:[]),t]:[t,...(u?[u]:[])];
}
/** Coarse far field, smoothly graded to a fine strip [a,b] around the hull. No hanging nodes. */
function hullAxis(lo:number,hi:number,a:number,b:number,coarse:number,fine:number):AxisSection[]{
  const A=Math.max(lo,a),B=Math.min(hi,b);
  return [...transition(A-lo,fine,coarse,true),{length:B-A,cells:Math.max(1,Math.ceil((B-A)/fine)),expansion:1},...transition(hi-B,fine,coarse,false)];
}
const axisSpec=(sections:AxisSection[])=>{
  const L=sections.reduce((t,x)=>t+x.length,0),n=sections.reduce((t,x)=>t+x.cells,0);
  return {cells:n,spec:sections.length===1&&sections[0].expansion===1?'1':`(${sections.map(x=>`(${foamNumber(x.length/L)} ${foamNumber(x.cells/n)} ${foamNumber(x.expansion)})`).join(' ')})`};
};

/**
 * Wave grid. The far field resolves wave propagation (a few cells per wave height, tens per wavelength). Around the hull
 * the background is graded smoothly to near-square cells (at most NEAR_HULL_MAX_ASPECT x the band cell height), so
 * snappyHexMesh surface refinement down to the hull/wall target only creates transitions between near-square cells.
 * (Refining flat band cells produced faces up to 83 deg non-orthogonal; refining a whole column to wall resolution
 * needed tens of millions of cells for printed-shell hulls.)
 */
function waveBackground(b:CfdManifest,height:number,wavelength:number,moving:boolean,spongeLength=0,genLength=0) {
  const [x0,y0,z0]=b.domain.minM,[x1,y1,z1]=b.domain.maxM;
  const [hx0,hy0]=b.geometry.minM,[hx1,hy1]=b.geometry.maxM;
  const L=hx1-hx0,B=hy1-hy0,D=b.geometry.maxM[2]-b.geometry.minM[2];
  // Quick fidelity: a deliberately light wave grid for fast screening; heights are calibrated by the wave-maker gain.
  // Full-mode grids refine systematically by sqrt(2) per level in every wave direction (ITTC three-grid study).
  // The quick grid is the coarse level of the automatic Full study, so Full checks whether the Quick answer has converged.
  const grid=b.mesh.fidelity==='quick'?{height:4,lambda:20,hull:12}:{height:6,lambda:30,hull:20};
  const refine=b.mesh.level==='coarse'?1:b.mesh.level==='medium'?Math.SQRT2:2;
  const settings={height:grid.height*refine,lambda:grid.lambda*refine,hull:grid.hull*refine};
  const along=wavelength/settings.lambda,across=L/settings.hull,dz=height/settings.height;
  const target=b.mesh.finestCellM;
  // Near-hull background spacing: a power-of-two multiple of the hull target (so refinement lands on it exactly),
  // no flatter than NEAR_HULL_MAX_ASPECT x dz and no coarser than the far field.
  const cap=Math.min(NEAR_HULL_MAX_ASPECT*dz,along,across);
  const surfaceLevel=Math.max(0,Math.floor(Math.log2(cap/target)+1e-9));
  const fine=Math.min(cap,target*2**surfaceLevel),finest=fine/2**surfaceLevel;
  const margin=Math.max(.15*L,4*fine);
  const sxC=moving?across:along,syC=moving?along:across;
  const xs:AxisSection[]=hullAxis(x0,x1,hx0-margin,hx1+margin,sxC,fine),ys:AxisSection[]=hullAxis(y0,y1,hy0-margin,hy1+margin,syC,fine);
  // Generation zone (up-wave) at the far-field spacing; sponge (down-wave) growing SPONGE_CELL_GROWTH per cell.
  const s0=moving?syC:sxC,r=SPONGE_CELL_GROWTH;
  const nS=spongeLength>0?Math.max(1,Math.ceil(Math.log(1+spongeLength*(r-1)/s0)/Math.log(r))):0,E=nS?r**(nS-1):1;
  const nG=genLength>0?Math.max(1,Math.ceil(genLength/s0)):0;
  const gen=nG?[{length:genLength,cells:nG,expansion:1}]:[],sponge=nS?[{length:spongeLength,cells:nS,expansion:E}]:[];
  const X=axisSpec(moving?xs:[...sponge.map(s=>({...s,expansion:1/s.expansion})),...xs,...gen]);
  const Y=axisSpec(moving?[...gen,...ys,...sponge]:ys);
  const nx=X.cells,ny=Y.cells;
  const X0=moving?x0:x0-spongeLength,X1=moving?x1:x1+genLength,Y0=moving?y0-genLength:y0,Y1=moving?y1+spongeLength:y1;
  const low=-2*height,high=2*height;
  if(low<=z0||high>=z1)throw new Error('The four-wave-height interface band does not fit the water/air domain. Enlarge the domain.');
  function outer(thickness:number){let count=0,sum=0,cell=dz;while(sum<thickness){sum+=cell;cell*=1.18;count++;}return {count,ratio:1.18**Math.max(0,count-1)};}
  const bottom=outer(low-z0),top=outer(z1-high),middle=Math.ceil((high-low)/dz);
  const baseCells=nx*ny*(bottom.count+middle+top.count);
  // Surface refinement estimate: refined layers over the hull area (both wall faces for printed shells).
  const area=2*(L*B+L*D+B*D)*(b.geometry.kind==='printed-material'?2:1);
  const surfaceCells=surfaceLevel>0?Math.ceil(3*area/finest**2):0;
  const cells=baseCells+surfaceCells;
  if(cells>b.mesh.maxCells*.95)throw new Error(`The ${b.mesh.level} wave grid requires about ${cells.toLocaleString('en-GB')} cells (${baseCells.toLocaleString('en-GB')} background + ${surfaceCells.toLocaleString('en-GB')} near the hull surface). Increase the mesh budget above ${Math.ceil(cells/0.95).toLocaleString('en-GB')} cells or run this case on a larger CFD workstation. No unresolved wave grid was substituted.`);
  const levels=[z0,low,high,z1],points:Vec3[]=levels.flatMap(z=>[[X0,Y0,z],[X1,Y0,z],[X1,Y1,z],[X0,Y1,z]] as Vec3[]);
  const block=(k:number,nz:number,grade:number)=>`hex (${[0,1,2,3,4,5,6,7].map(i=>i+4*k).join(' ')}) (${nx} ${ny} ${nz}) simpleGrading (${X.spec} ${Y.spec} ${foamNumber(grade)})`;
  const side=(a:number,c:number)=>[0,1,2].map(k=>`(${4*k+a} ${4*k+c} ${4*(k+1)+c} ${4*(k+1)+a})`).join(' ');
  const dictionary=foamHeader('blockMeshDict','dictionary','system')+`scale 1;\nvertices (${points.map(foamVector).join('\n')});\nblocks (${block(0,bottom.count,1/bottom.ratio)} ${block(1,middle,1)} ${block(2,top.count,top.ratio)});\nedges ();\nboundary\n(\n inlet { type patch; faces (${side(1,2)}); }\n outlet { type patch; faces (${side(3,0)}); }\n port { type patch; faces (${side(2,3)}); }\n starboard { type patch; faces (${side(0,1)}); }\n bottom { type patch; faces ((0 3 2 1)); }\n atmosphere { type patch; faces ((12 13 14 15)); }\n);\nmergePatchPairs ();\n`;
  return {dictionary,cells,baseCells,surfaceCells,nx,ny,nz:bottom.count+middle+top.count,dz,along,fine,surfaceLevel,finest,spongeCells:nS,generationCells:nG};
}

/**
 * Copy a zero-current base case and replace its boundary conditions with genuine native waves.
 * This creates solver inputs. It does not mark the solver, wave absorption or resolution verified.
 */
export function extendCaseWithWaves(base:CfdCasePackage,settings:WaveCaseSettings):WaveCasePackage {
  if(base.manifest.solver.distribution!=='OpenCFD'||base.manifest.solver.version!=='2312'||base.manifest.solver.application!=='interFoam')throw new Error('Wave cases are pinned to OpenCFD OpenFOAM v2312 interFoam.');
  if(base.manifest.condition.kind!=='calm'||base.manifest.mode!=='fixed-resistance')throw new Error('Extend an unmodified calm fixed-hull base case only.');
  if(!['head-waves','beam-waves'].includes(settings.kind))throw new Error('Choose head-waves or beam-waves.');
  if(!Number.isFinite(base.manifest.speedMps)||Math.abs(base.manifest.speedMps)>1e-12)throw new Error('Advancing waves are unsupported: native StokesI waveVelocity does not superpose the towing current. Generate a zero-speed base case; no fake current correction is applied.');
  positive(settings.heightM,'Regular wave height');positive(settings.periodS,'Regular wave period');
  const b0=base.manifest,g=b0.physics.gravityMps2,fullDepth=-b0.domain.minM[2];
  positive(fullDepth,'Still-water depth');
  // Wave tank depth: deep-water waves do not feel the floor below ~half a wavelength. The calm-towing domain (3 hull
  // lengths deep) made the wave-maker's active absorption drive a growing velocity in the deep floor cells (empty-tank
  // runs diverged at the inlet floor corner). Keep >= WAVE_DEPTH_WAVELENGTHS wavelengths and >= keel + half a hull length.
  const keelDepth=Math.max(0,-b0.geometry.minM[2]),hullLength=b0.geometry.maxM[0]-b0.geometry.minM[0];
  const depth=Math.min(fullDepth,Math.max(WAVE_DEPTH_WAVELENGTHS*regularWaveLength(settings.periodS,fullDepth,g),keelDepth+.5*hullLength));
  // Beam waves travel across the hull (y). Along the hull (x) the calm-towing domain (5 lengths ahead, 2 behind) only
  // adds cells: keep BEAM_X_MARGIN hull lengths each side, closed by slip planes (equivalent to symmetry planes here).
  const beam=settings.kind==='beam-waves';
  const xMin=beam?Math.max(b0.domain.minM[0],b0.geometry.minM[0]-BEAM_X_MARGIN*hullLength):b0.domain.minM[0];
  const xMax=beam?Math.min(b0.domain.maxM[0],b0.geometry.maxM[0]+BEAM_X_MARGIN*hullLength):b0.domain.maxM[0];
  // Across the hull (wave direction) keep BEAM_Y_GAP_WAVELENGTHS (>= half a hull length) of open water between the
  // hull and the generation zone, and the same before the sponge: less travel means less numerical wave decay.
  const gapY=Math.max(BEAM_Y_GAP_WAVELENGTHS*regularWaveLength(settings.periodS,depth,g),.5*hullLength);
  const yMin=beam?Math.max(b0.domain.minM[1],b0.geometry.minM[1]-gapY):b0.domain.minM[1];
  const yMax=beam?Math.min(b0.domain.maxM[1],b0.geometry.maxM[1]+gapY):b0.domain.maxM[1];
  const b:CfdManifest={...b0,domain:{...b0.domain,minM:[xMin,yMin,-depth],maxM:[xMax,yMax,b0.domain.maxM[2]],belowKeelClearanceM:depth-keelDepth}};
  const wavelength=regularWaveLength(settings.periodS,depth,g),steepness=Math.PI*settings.heightM/wavelength;
  if(steepness>.15||settings.heightM/depth>.1)throw new Error('This first-order Stokes wave is too steep or shallow for the generated linear-wave baseline. Use and validate a nonlinear wave model.');
  if(settings.heightM/2>=b.domain.maxM[2])throw new Error('The wave crest reaches the atmosphere boundary. Enlarge and verify the air domain.');
  if(settings.massKg!==undefined&&(!Number.isFinite(settings.massKg)||Math.abs(settings.massKg-b.load.massKg)>Math.max(1e-9,b.load.massKg*1e-7)))throw new Error('Wave mass must match the base case measured mass.');
  if(settings.cgM!==undefined&&(settings.cgM.length!==3||settings.cgM.some((v,i)=>!Number.isFinite(v)||Math.abs(v-b.load.cgM[i])>1e-9)))throw new Error('Wave CG must match the base case supplied CG.');
  const moving=settings.kind==='beam-waves';
  const inertiaSource=settings.inertiaSource??'measured',estimatedInertia=inertiaSource==='cad-estimate';
  if(moving&&!['measured','cad-estimate'].includes(inertiaSource))throw new Error('Choose measured or explicitly CAD-estimated mass inertia.');
  if(moving&&estimatedInertia&&(settings.inertiaMeasured===true||!settings.inertiaTensorKgM2&&!settings.inertiaOrientation||!settings.inertiaAssumptions?.length||settings.inertiaAssumptions.some(s=>typeof s!=='string'||!s.trim())))throw new Error('CAD-estimated inertia requires its full tensor or principal orientation and explicit mass assumptions; it must not be labelled measured.');
  if(moving&&(!estimatedInertia&&settings.inertiaMeasured!==true||!settings.inertiaTensorKgM2&&(!settings.inertiaKgM2||settings.inertiaKgM2.length!==3||settings.inertiaKgM2.some(v=>!Number.isFinite(v)||v<=0))))throw new Error('Free roll requires positive mass moments of inertia about the supplied loaded CG, in kg mÂ²: measured inputs or explicitly CAD-estimated full mass inertia.');
  const suppliedOrientation=checkedOrientation(settings.inertiaOrientation);
  const rollAxis:Vec3=settings.rollAxis??[1,0,0];
  if(!Array.isArray(rollAxis)||rollAxis.length!==3||rollAxis.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...rollAxis)-1)>1e-8)throw new Error('The free-roll axis must be a finite unit vector in model/world coordinates.');
  const inertiaTensor:Matrix3=settings.inertiaTensorKgM2??suppliedOrientation.map((row,i)=>row.map((_,j)=>(settings.inertiaKgM2??[1,1,1]).reduce((sum,value,k)=>sum+suppliedOrientation[i][k]*value*suppliedOrientation[j][k],0))) as Matrix3;
  const projection=constrainedRollInertia(inertiaTensor,rollAxis),inertiaOrientation=projection.orientation,solverInertia=projection.diagonal;
  if(moving&&settings.inertiaKgM2){
    const [ix,iy,iz]=settings.inertiaKgM2;
    if(ix>iy+iz+1e-12||iy>ix+iz+1e-12||iz>ix+iy+1e-12)throw new Error('The supplied mass moments violate rigid-body inertia triangle inequalities.');
  }
  const files={...base.files};
  // Extend the far (down-wave) side of the domain by the sponge length; the hull and inlet side are unchanged.
  const spongeLength=SPONGE_WAVELENGTHS*wavelength,genLength=GEN_WAVELENGTHS*wavelength;
  const domainMin:Vec3=[...b.domain.minM] as Vec3,domainMax:Vec3=[...b.domain.maxM] as Vec3;
  if(moving){domainMax[1]+=spongeLength;domainMin[1]-=genLength;}else{domainMin[0]-=spongeLength;domainMax[0]+=genLength;}
  const spongeMin:Vec3=moving?[domainMin[0]-1,b.domain.maxM[1],domainMin[2]-1]:[domainMin[0],domainMin[1]-1,domainMin[2]-1];
  const spongeMax:Vec3=moving?[domainMax[0]+1,domainMax[1]+1,domainMax[2]+1]:[b.domain.minM[0],domainMax[1]+1,domainMax[2]+1];
  const waveGrid=waveBackground(b,settings.heightM,wavelength,moving,spongeLength,genLength);
  {
    // The water fill must cover the extended domain, or the sponge region starts dry and collapses like a dam break.
    const sf=textFile(base,'system/setFieldsDict'),pad=1;
    const filled=sf.replace(/box \([^)]*\) \([^)]*\);/,`box ${foamVector([domainMin[0]-pad,domainMin[1]-pad,domainMin[2]-pad])} ${foamVector([domainMax[0]+pad,domainMax[1]+pad,0])};`);
    if(filled===sf)throw new Error('Internal error: the water fill region could not be extended to the wave domain.');
    files['system/setFieldsDict']=filled;
  }
  files['system/blockMeshDict']=waveGrid.dictionary;
  // The hull is snapped onto the near-isotropic column cells (no isotropic surface refinement: it would run
  // before directional refinement, inside the flat band cells). The calm-case waterline box is dropped.
  {
    // Surface refinement from the near-square background down to the hull/wall target; the calm-case waterline box is dropped.
    const snappy=textFile(base,'system/snappyHexMeshDict'),lv=waveGrid.surfaceLevel;
    const tuned=snappy.replace(/features \(\{ file "hull\.eMesh"; level \d+; \}\);/,`features ({ file "hull.eMesh"; level ${lv}; });`)
      .replace(/hull \{ level \(\d+ \d+\);/,`hull { level (${lv} ${lv});`)
      // The calm case's inside point lies far ahead of the hull; the wave tank is smaller. Use open water beside the hull.
      .replace(/locationInMesh \([^)]*\);/,`locationInMesh ${foamVector(moving?[(b.geometry.minM[0]+b.geometry.maxM[0])/2,(b.domain.minM[1]+b.geometry.minM[1])/2,-Math.min(b.load.draftM/2,hullLength/4)]:[(b.domain.maxM[0]+b.geometry.maxM[0])/2,0,-Math.min(b.load.draftM/2,hullLength/4)])};`)
      .replace(/hullWaterline \{ mode inside; levels \(\(1e15 \d+\)\); \}/,'hullWaterline { mode inside; levels ((1e15 0)); }');
    if(!/locationInMesh \(/.test(tuned)||!tuned.includes(`hull { level (${lv} ${lv});`)||!tuned.includes('levels ((1e15 0))'))throw new Error('Internal error: wave hull refinement could not be applied to snappyHexMeshDict.');
    files['system/snappyHexMeshDict']=tuned;
  }
  const inlet=moving?'starboard':'inlet',outlet=moving?'port':'outlet';
  let waveTargetExpression='';
  const n=foamNumber,v=foamVector,ramp=3*settings.periodS;
  const k=2*Math.PI/wavelength,kh=k*depth;
  const groupSpeed=.5*(2*Math.PI/settings.periodS)/k*(1+(kh>30?0:2*kh/Math.sinh(2*kh)));
  const distance=moving?-b.domain.minM[1]+b.load.cgM[1]:b.domain.maxM[0]-b.load.cgM[0];
  const warmup=Math.max(10*settings.periodS,distance/groupSpeed+5*settings.periodS);
  const quick=b.mesh.fidelity==='quick',measuredPeriods=quick?8:15;
  const duration=Math.max(b.numerics.durationS,warmup+measuredPeriods*settings.periodS);
  if(duration>600)throw new Error('Wave propagation plus measurement requires more than the supported 600-second case duration.');
  const stepsPerPeriod=quick?100:200;
  const dt=Math.min(b.numerics.initialDeltaTS,settings.periodS/stepsPerPeriod),maxDt=Math.min(b.numerics.maxDeltaTS,settings.periodS/stepsPerPeriod);
  let u=textFile(base,'0/U'),alpha=textFile(base,'0/alpha.water'),p=textFile(base,'0/p_rgh');
  u=entry(u,'internalField','uniform (0 0 0)');
  for(const patch of ['inlet','outlet','port','starboard']){
    u=block(u,patch,'        type slip;');
    alpha=block(alpha,patch,'        type zeroGradient;');
    p=block(p,patch,'        type fixedFluxPressure; value uniform 0;');
  }
  // Both ends are slip walls: the relaxation zone generates the waves and the sponge absorbs them.
  {
    // Density-weighted sponge (native acousticDampingSource: source = rho*w*f*blend*(URef-U)), so air is not over-damped.
    // Its blend ramps smoothly (cosine) with distance from a centre; a centre 100 m up-wave makes the ramp planar
    // across the tank (curvature error < 3 mm over the domain).
    const far=100,omega=2*Math.PI/settings.periodS,w=20,frequency=SPONGE_STRENGTH*omega/w;
    const centre:Vec3=moving?[0,b.domain.minM[1]-far,0]:[b.domain.maxM[0]+far,0,0];
    const r1=moving?b.domain.maxM[1]-centre[1]:centre[0]-b.domain.minM[0],r2=moving?domainMax[1]-centre[1]:centre[0]-domainMin[0];
    files['system/fvOptions']=foamHeader('fvOptions','dictionary','system')+`sponge\n{\n    type acousticDampingSource;\n    selectionMode all;\n    centre ${foamVector(centre)};\n    radius1 ${foamNumber(r1)};\n    radius2 ${foamNumber(r2)};\n    frequency ${foamNumber(frequency)};\n    w ${w};\n    URef UZero;\n}\n`;
    files['0/UZero']=foamHeader('UZero','volVectorField','0')+'dimensions [0 1 -1 0 0 0 0];\ninternalField uniform (0 0 0);\nboundaryField\n{\n    ".*" { type calculated; value uniform (0 0 0); }\n}\n';
  }
  if(moving)u=block(u,'hull','        type movingWallVelocity; value uniform (0 0 0);');
  files['0/U']=u;files['0/alpha.water']=alpha;files['0/p_rgh']=p;
  {
    // Relaxation-zone wave-maker: UWave holds linear finite-depth (Stokes I) kinematics below the theoretical surface
    // (zero above), cosine-ramped over rampTime; the zone relaxes U toward it, strongest at the wall.
    const gain=settings.generationGain??1;
    if(!(gain>=.5&&gain<=2))throw new Error('Wave-maker gain must be between 0.5 and 2.');
    const omega=2*Math.PI/settings.periodS,a=gain*settings.heightM/2,far=100,w=20;
    const wallCoord=moving?domainMin[1]:domainMax[0];
    const s0=moving?`(pos().y() - (${n(wallCoord)}))`:`((${n(wallCoord)}) - pos().x())`;
    const phase=`(${n(k)}*${s0} - ${n(omega)}*time())`;
    const rampF=`(time() < ${n(ramp)} ? 0.5*(1 - cos(${n(Math.PI)}*time()/${n(ramp)})) : 1)`;
    const eta=`(${n(a)}*${rampF}*cos(${phase}))`;
    const uh=`${n(a*omega)}*${rampF}*cosh(${n(k)}*(pos().z() + ${n(depth)}))/${n(Math.sinh(kh))}*cos(${phase})`;
    const uz=`${n(a*omega)}*${rampF}*sinh(${n(k)}*(pos().z() + ${n(depth)}))/${n(Math.sinh(kh))}*sin(${phase})`;
    const target=moving?`vector(0, ${uh}, ${uz})`:`vector(-(${uh}), 0, ${uz})`;
    waveTargetExpression=`(pos().z() <= ${eta}) ? ${target} : vector(0, 0, 0)`;
    const centre:Vec3=moving?[0,wallCoord+genLength+far,0]:[wallCoord-genLength-far,0,0];
    files['system/fvOptions']+=`\nwavemaker\n{\n    type acousticDampingSource;\n    selectionMode all;\n    centre ${foamVector(centre)};\n    radius1 ${n(far)};\n    radius2 ${n(far+genLength)};\n    frequency ${n(GEN_STRENGTH*omega/w)};\n    w ${w};\n    URef UWave;\n}\n`;
    files['0/UWave']=foamHeader('UWave','volVectorField','0')+'dimensions [0 1 -1 0 0 0 0];\ninternalField uniform (0 0 0);\nboundaryField\n{\n    ".*" { type calculated; value uniform (0 0 0); }\n}\n';
  }
  // The calm outlet absorber (and its reference velocity) does not belong in a wave tank; its own sponge replaces it.
  let control=textFile(base,'system/controlDict').replace(CALM_REFERENCE_FUNCTION,'');
  delete files['0/UTow'];
  control=entry(control,'endTime',n(duration));control=entry(control,'deltaT',n(dt));control=entry(control,'maxDeltaT',n(maxDt));
  // Quick runs extend a short base case; keep ~20 field writes rather than hundreds.
  const writeInterval=quick?duration/20:b.numerics.writeIntervalS;
  if(quick)control=entry(control,'writeInterval',n(writeInterval));
  // A free-floating hull keeps two outer PIMPLE correctors in quick mode, for coupling stability. Its flow Courant cap is 1
  // (the interface Courant cap stays 0.5): a real catamaran wave run gave identical heave to 0.001 mm and 22% less time
  // than with 0.5 (verification/any-stl-robustness).
  if(quick&&moving){
    control=entry(control,'maxCo',n(Math.min(b.numerics.maxCo,1)));
    files['system/fvSolution']=textFile(base,'system/fvSolution').replace('nOuterCorrectors 1; nCorrectors 3','nOuterCorrectors 2; nCorrectors 2');
  }
  // Runtime loading is explicit; no custom unverified dynamic C++ boundary is generated.
  // exprField mixes metres and plain numbers; OpenFOAM's dimension consistency check is switched off for this case only.
  control=control.replace(/(^|\n)functions\s*\{/,`\nDebugSwitches\n{\n    dimensionSet 0;\n}\nfunctions\n{\n    readReferenceFields\n    {\n        type readFields; libs ("libfieldFunctionObjects.so");\n        fields (UZero UWave);\n    }\n    waveTarget\n    {\n        type exprField; libs ("libfieldFunctionObjects.so");\n        field UWave;\n        action modify;\n        autowrite false;\n        executeControl timeStep; writeControl none;\n        expression "${waveTargetExpression}";\n    }`);
  const probeDistance=Math.min(wavelength/4,distance/3),cg=b.load.solverCgM;
  const probeA:Vec3=moving?[cg[0],cg[1]-probeDistance,0]:[cg[0]+probeDistance,cg[1],0];
  const probeB:Vec3=moving?[cg[0],cg[1]-2*probeDistance,0]:[cg[0]+2*probeDistance,cg[1],0];
  control=appendFunction(control,`    waveGauges\n    {\n        type interfaceHeight; libs ("libfieldFunctionObjects.so");\n        alpha alpha.water;\n        locations (${v(probeA)} ${v(probeB)});\n        direction (0 0 1);\n        writeControl timeStep; writeInterval 1;\n    }`);
  if(moving){
    const L=b.geometry.maxM[0]-b.geometry.minM[0];
    // The morphing zone must end inside the tank. With outerDistance 0.75 L it crossed the end walls (0.5 L from bow and
    // stern): rolling then moved the wall cells, pumping ~23 m/s of spurious air just above the surface there, which set a
    // 0.25 ms Courant-limited step (verification/wave-morph-zone). Keep it within 90% of the nearest end wall or wave gap.
    const outerDistance=Math.min(.75*L,.9*BEAM_X_MARGIN*L,.9*gapY);
    // Body-fluid coupling: accelerationRelaxation 0.4 with damping 0.9 (was 0.7 / 1). A light, very stiff hull (a 150 g
    // twin-pod SWATH, GM 0.53 m, roll period ~0.16 s) made the partitioned coupling diverge: roll rate 1e95 rad/s by 0.8 s.
    // With 0.4 / 0.9 the same case runs stably (verification on Roihu, 2026-11-18).
    files['constant/dynamicMeshDict']=foamHeader('dynamicMeshDict','dictionary','constant')+`dynamicFvMesh dynamicMotionSolverFvMesh;\nmotionSolverLibs ("libsixDoFRigidBodyMotion.so");\nmotionSolver sixDoFRigidBodyMotion;\nsixDoFRigidBodyMotionCoeffs\n{\n    patches (hull);\n    innerDistance ${n(L*.05)};\n    outerDistance ${n(outerDistance)};\n    centreOfMass ${v(cg)};\n    orientation (${inertiaOrientation.flat().map(n).join(' ')});\n    initialOrientation (${inertiaOrientation.flat().map(n).join(' ')});\n    mass ${n(b.load.massKg)};\n    momentOfInertia ${v(solverInertia)};\n    rho rho;\n    report yes;\n    accelerationRelaxation 0.4;\n    accelerationDamping 0.9;\n    solver { type Newmark; }\n    constraints\n    {\n        heaveOnly\n        {\n            sixDoFRigidBodyMotionConstraint line;\n            centreOfRotation ${v(cg)};\n            direction (0 0 1);\n        }\n        rollOnly\n        {\n            sixDoFRigidBodyMotionConstraint axis;\n            axis (1 0 0);\n        }\n    }\n}\n`;
    const patches=['inlet','outlet','port','starboard','bottom','atmosphere','hull'];
    files['0/pointDisplacement']=foamHeader('pointDisplacement','pointVectorField','0')+`dimensions [0 1 0 0 0 0 0];\ninternalField uniform (0 0 0);\nboundaryField\n{\n${patches.map(p=>`    ${p} { type ${p==='hull'?'calculated':'fixedValue'}; value uniform (0 0 0); }`).join('\n')}\n}\n`;
    control=appendFunction(control,'    rigidBodyState\n    {\n        type sixDoFRigidBodyState; libs ("libsixDoFRigidBodyState.so");\n        angleFormat radians;\n        writeControl timeStep; writeInterval 1;\n    }');
  }
  files['system/controlDict']=control;
  const manifest:WaveCasePackage['manifest']={
    ...b,load:{...b.load,cgM:[...b.load.cgM],solverCgM:[...cg]},
    mode:moving?'free-motion':'fixed-resistance',
    condition:{kind:settings.kind,heightM:settings.heightM,periodS:settings.periodS,rampTimeS:ramp,headingDeg:moving?90:180},
    numerics:{...b.numerics,...(quick&&moving?{maxCo:Math.min(b.numerics.maxCo,1)}:{}),writeIntervalS:writeInterval,durationS:duration,initialDeltaTS:dt,maxDeltaTS:maxDt,recommendedWarmupS:warmup},
    domain:{...b.domain,minM:domainMin,maxM:domainMax,spongeLengthM:spongeLength},
    conventions:{...b.conventions,flowDirection:[0,0,0]},
    mesh:{...b.mesh,baseCells:[waveGrid.nx,waveGrid.ny,waveGrid.nz],estimatedBaseCells:waveGrid.cells,surfaceLevels:[waveGrid.surfaceLevel,waveGrid.surfaceLevel],finestCellM:Math.min(waveGrid.finest,waveGrid.dz),nearHullSpacingM:waveGrid.fine},
    waves:{model:'StokesI',heightDefinition:'regular crest-to-trough',periodDefinition:'still-water regular period',originalIrregularPresetEquivalent:false,inletPatch:inlet,absorptionPatch:outlet,generation:{method:'relaxation-zone',gain:settings.generationGain??1,lengthM:genLength,wavelengths:GEN_WAVELENGTHS,maxRateS:GEN_STRENGTH*2*Math.PI/settings.periodS,kinematics:'linear finite-depth (Stokes I)',rampTimeS:ramp},sponge:{lengthM:spongeLength,wavelengths:SPONGE_WAVELENGTHS,zones:1,maxRateS:SPONGE_STRENGTH*2*Math.PI/settings.periodS,minM:spongeMin,maxM:spongeMax},propagationDirection:moving?[0,1,0]:[-1,0,0],waveLengthM:wavelength,waterDepthM:depth,meanCurrentMps:0,boundaryHeightCells:settings.heightM/waveGrid.dz,boundaryWavelengthCells:wavelength/waveGrid.along,backgroundCells:waveGrid.cells,freeSurfaceVerticalCells:Math.round(4*settings.heightM/waveGrid.dz),waveResolutionVerified:false,reflectedWaveFraction:null,sources:[...WAVE_METHOD_SOURCES]},
    verification:{status:'not-run',required:[...b.verification.required,'empty-tank wave gauges: achieved regular H, T, dispersion and phase','global inlet/free-surface wave-grid refinement; near-hull refinement alone is insufficient','incident/reflected-wave separation and absorption/domain sensitivity','repeat statistics after wave travel, ramp and transient decay',...(moving?['verify loaded mass, CG and inertia distribution; calm free-floating equilibrium','mesh-motion quality, heave/roll time-step convergence and complete motion state history']:[])]},
    notes:[...b.notes,
      'Regular Stokes-I waves at zero current only. This is not the original irregular Bretschneider sea, even when a numeric Hs preset is reused as regular height H.',
      'Native waveVelocity does not add a towing current. Nonzero-speed advancing-wave cases are rejected rather than silently changing the requested physics.',
      'Native shallow-water active absorption is an initial boundary treatment, not a guarantee of negligible reflection in this domain. Measure reflection using empty-tank gauges and vary boundaries.',
      `Graded wave background: ${waveGrid.cells} cells; ${n(settings.heightM/waveGrid.dz)} vertical cells per height and ${n(wavelength/waveGrid.along)} cells per wavelength before hull refinement. These requested resolutions are starting levels for a global wave propagation convergence study; no achieved-wave validation is implied.`,
      moving?(estimatedInertia?'The complete mass inertia tensor is estimated from CAD and stated payload assumptions, not measured. The only free rotation uses effective axial inertia a^T I a about the longitudinal hull axis; other rotation components are constraint reactions.':'Mass moments are supplied as measured values. The only free rotation uses their effective axial inertia in the recorded constrained-roll frame.'): 'No free-motion inertia is used.',
      moving?`Only heave +Z and rotation about the initial longitudinal hull axis ${v(rollAxis)} are free; all other translations and rotations are constrained. No empirical roll damping is imposed: viscous/capillary forces are solved by interFoam. Morphing mesh may fail at large heel and must be quality-checked throughout.`:'Fixed hull in zero-speed head waves: the X force is a wave-load measurement, not advancing-ship resistance or free pitch/heave response.',
      'Force-object moment reference remains the initial CG. sixDoF internally uses its moving centre of rotation; distinguish those references when post-processing moments.',
    ],
    ...(moving?{motion:{degreesOfFreedom:['heave-Z',Math.abs(rollAxis[0]-1)<1e-10&&Math.abs(rollAxis[1])+Math.abs(rollAxis[2])<1e-10?'roll-X':'roll-about-hull-axis'] as MotionMetadata['degreesOfFreedom'],inertiaKgM2:[...solverInertia] as Vec3,inertiaMeasured:!estimatedInertia,inertiaSource,inertiaAssumptions:estimatedInertia?[...settings.inertiaAssumptions!]:[],initialOrientation:inertiaOrientation.map(row=>[...row]) as Matrix3,rollAxis:[...rollAxis] as Vec3,inertiaTensorKgM2:inertiaTensor.map(row=>[...row]) as Matrix3,inertiaFrame:'constrained-roll-body-frame' as const,inertiaProjection:'effective inertia a^T I a for the only free rotation' as const,effectiveRollInertiaKgM2:projection.effectiveRollInertiaKgM2,principalMomentsKgM2:projection.principal.momentsKgM2,principalOrientation:projection.principal.orientation,initialCentreOfMassM:[...cg] as Vec3,stateFile:'postProcessing/rigidBodyState/0/sixDoFRigidBodyState.dat',angles:'radians' as const,meshMotion:'morphing' as const}}:{}),
  };
  files['README.txt']=`${textFile(base,'README.txt')}\nWAVE CASE\n${moving?`Zero-speed regular beam waves; ${estimatedInertia?'CAD-estimated':'measured'} inertia for free heave and roll.`:'Zero-speed regular head waves; hull fixed. This is not advancing-ship drag.'}\nRun with the same Allrun. Native wave models are loaded from libwaveModels.so.\n\nWave height H is regular crest-to-trough, not irregular-sea Hs. Before interpreting any force or motion, refine the global wave inlet/free-surface mesh, run an empty-tank propagation/reflection study, and converge time and domain. Background mesh presets here are a smoke-test starting point, not a resolved wave mesh. Native absorption does not prove reflection independence.\n\nWarmup at least ${n(warmup)} seconds; requested total duration ${n(duration)} seconds includes ${measuredPeriods} additional wave periods. Inspect actual signal stationarity; these are minimum scheduling rules, not guarantees.\n${moving?`Motion state: postProcessing/rigidBodyState/0/sixDoFRigidBodyState.dat, radians and SI coordinates. Inertia source: ${inertiaSource}. The full tensor, its principal system and the effective scalar roll inertia a^T I a are recorded in the manifest. Both native orientation and initialOrientation align the computational first axis with the initial longitudinal hull axis, preserving the physical initial CAD pose. Native axis constraint (1 0 0) acts in that computational body frame. This is a reduced heave-plus-roll model, not unconstrained rotational dynamics. Only heave-Z and rotation about ${v(rollAxis)} are free. Large motion can invalidate the morphing mesh.\n`:''}`;
  files['manifest.json']=JSON.stringify(manifest,null,2)+'\n';
  return {files,manifest};
}
