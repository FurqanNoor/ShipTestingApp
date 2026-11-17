/** OpenCFD OpenFOAM v2312 case generation. No empirical force values are substituted. */
export type Vec3 = [number,number,number];
export type MeshLevel = 'coarse'|'medium'|'fine';
export interface CfdLoad {
  massKg:number;draftM:number;cgM:Vec3;cgMeasured:boolean;
  massSource?:'measured'|'protocol-default';
  massMeasured?:boolean;
  modelCgM?:Vec3;
  cgSource?:'measured'|'cad-estimate';
  cgAssumptions?:string[];
  cgAssumptionsConfirmed?:boolean;
}
export interface CfdCaseInput {
  caseId:string;
  /** Actual, consistently oriented, watertight CAD triangles: X bow+, stern X=0, Y centred, keel Z=0. */
  trianglesMm:ArrayLike<number>;
  sourceHash:string;
  protocolKey:string;
  load:CfdLoad;
  speedMps:number;
  geometryKind?:'printed-material'|'sealed-envelope';
  minimumWallThicknessM?:number;
  /** Closed dry-displacement envelope used ONLY to initialise the open cavity as air. */
  dryEnvelopeTrianglesMm?:ArrayLike<number>;
  mesh?:MeshLevel;
  /** 'quick' trades accuracy for speed: lighter wave background and a shorter observation window. */
  fidelity?:'standard'|'quick';
  durationS?:number;
  timeStepS?:number;
  maxDeltaTS?:number;
  /** Only after the original placed CAD passed size validation. A floating pose can have a larger bounding box. */
  geometryIsPosed?:boolean;
  maxCo?:number;
  maxCells?:number;
  domainScale?:number;
  mode?:'fixed-resistance';
  condition?:{kind:'calm'};
}
export interface CfdManifest {
  schemaVersion:1;
  caseId:string;
  sourceHash:string;
  protocolKey:string;
  units:'SI';
  solver:{distribution:'OpenCFD';version:'2312';application:'interFoam';image:'opencfd/openfoam-run:2312';imageDigest:'sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76'};
  mode:'fixed-resistance'|'free-motion';
  condition:{kind:'calm'|'head-waves'|'beam-waves';heightM?:number;periodS?:number;rampTimeS?:number;headingDeg?:number};
  geometry:{kind:'printed-material'|'sealed-envelope';triangleCount:number;translationM:Vec3;minM:Vec3;maxM:Vec3;minimumWallThicknessM:number|null;dryCavityInitialised:boolean;watertightPreflight:true};
  load:CfdLoad&{solverCgM:Vec3};
  speedMps:number;
  physics:{densityWaterKgM3:number;densityAirKgM3:number;nuWaterM2S:number;nuAirM2S:number;surfaceTensionNpm:number;gravityMps2:number;flowModel:'laminar';contactAngleAssumptionDeg:90};
  domain:{scale:number;minM:Vec3;maxM:Vec3;upstreamClearanceM:number;downstreamClearanceM:number;sideClearanceM:number;belowKeelClearanceM:number;airClearanceM:number;boundaryIndependent:false;spongeLengthM?:number};
  mesh:{level:MeshLevel;fidelity?:'standard'|'quick';nearHullSpacingM?:number;baseCellSizeM:number;baseCells:[number,number,number];estimatedBaseCells:number;surfaceLevels:[number,number];finestCellM:number;maxCells:number;layers:number;wallCellsAtFinest:number|null;resolutionVerified:false};
  numerics:{durationS:number;initialDeltaTS:number;maxDeltaTS:number;maxCo:number;maxAlphaCo:number;writeIntervalS:number;recommendedWarmupS:number};
  conventions:{waterlineZ:0;flowDirection:Vec3;dragFromForce:'negative Fx';heaveAxis:'+Z';rollAxis:'+X';forceFile:string};
  verification:{status:'not-run';required:string[]};
  notes:string[];
}
export interface CfdCasePackage { files:Record<string,string|Uint8Array>;manifest:CfdManifest }

export function foamNumber(n:number):string {
  if(!Number.isFinite(n))throw new Error('OpenFOAM dictionaries require finite numbers.');
  return Math.abs(n)<1e-16?'0':Number(n.toPrecision(12)).toString();
}
export const foamVector=(v:Vec3)=>`(${v.map(foamNumber).join(' ')})`;
export function foamHeader(object:string,klass='dictionary',location?:string):string {
  if(!/^[A-Za-z0-9_.-]+$/.test(object))throw new Error('Invalid OpenFOAM object name.');
  return `/* Generated for OpenCFD OpenFOAM v2312. SI units. */\nFoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${klass};\n${location?`    location "${location}";\n`:''}    object ${object};\n}\n\n`;
}
/** controlDict function that registers the calm outlet absorber's reference velocity; wave cases remove it. */
export const CALM_REFERENCE_FUNCTION='    calmTowReference\n    {\n        type readFields; libs ("libfieldFunctionObjects.so");\n        fields (UTow);\n    }\n';
const dict=(name:string,body:string,location='system')=>foamHeader(name,'dictionary',location)+body+'\n';
const field=(name:string,klass:string,dimensions:string,internal:string,boundary:string)=>foamHeader(name,klass,'0')+`dimensions ${dimensions};\ninternalField ${internal};\nboundaryField\n{\n${boundary}\n}\n`;
function positive(n:number,name:string,allowZero=false) {
  if(!Number.isFinite(n)||(allowZero?n<0:n<=0))throw new Error(`${name} must be finite and ${allowZero?'non-negative':'positive'}.`);
}

/** Topology guard only. Backend must independently validate the actual STL and mesh quality. */
function checkedTriangles(input:ArrayLike<number>,posed=false) {
  if(!input.length||input.length%9||input.length/9>500000)throw new Error('Provide a triangulated hull with 1–500,000 complete faces.');
  const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<input.length;i++) {
    const n=input[i]*.001;if(!Number.isFinite(n))throw new Error('The STL contains a non-finite coordinate.');
    min[i%3]=Math.min(min[i%3],n);max[i%3]=Math.max(max[i%3],n);
  }
  const dims=max.map((v,i)=>v-min[i]) as Vec3;
  if(dims.some(v=>v<=1e-7))throw new Error('The solver needs a three-dimensional hull.');
  if(!posed&&(dims[0]>.2500001||dims[1]>.2500001||dims[2]>.2500001))throw new Error('The solver hull exceeds the 250 × 250 × 250 mm build volume.');
  const eps=Math.max(...dims)*1e-7;
  if(Math.abs(min[0])>eps*2||Math.abs(min[2])>eps*2||Math.abs(min[1]+max[1])>eps*2)throw new Error('Place the actual CAD at stern X=0, centred Y=0 and keel Z=0 before generating a case.');
  const edges=new Map<string,{count:number;orientation:number}>();
  const p=(i:number):Vec3=>[input[i]*.001,input[i+1]*.001,input[i+2]*.001];
  const key=(a:Vec3)=>a.map((v,i)=>Math.round((v-min[i])/eps)).join(',');
  for(let t=0;t<input.length;t+=9) {
    const a=p(t),b=p(t+3),c=p(t+6),u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(Math.hypot(...cross)<eps**2)throw new Error('Remove zero-area faces from the solver STL.');
    const ids=[key(a),key(b),key(c)];
    for(let k=0;k<3;k++) {
      const x=ids[k],y=ids[(k+1)%3],lo=x<y?x:y,hi=x<y?y:x,id=`${lo}|${hi}`,entry=edges.get(id)??{count:0,orientation:0};
      entry.count++;entry.orientation+=x<y?1:-1;edges.set(id,entry);
    }
  }
  // Edges where two parts touch (a pinch) carry 4, 6... uses; they are valid when balanced in both directions.
  if([...edges.values()].some(e=>e.count%2!==0||e.orientation!==0))throw new Error('The solver needs a watertight, consistently oriented actual solid. Repair holes or winding in CAD; a virtual buoyancy cap is not a physical deck.');
  return {min,max,dims};
}

function asciiStl(triangles:ArrayLike<number>,draft:number):string {
  const lines=['solid hull'];
  for(let i=0;i<triangles.length;i+=9) {
    const ps:Vec3[]=[0,3,6].map(o=>[triangles[i+o]*.001,triangles[i+o+1]*.001,triangles[i+o+2]*.001-draft]);
    const a=ps[1].map((v,j)=>v-ps[0][j]),b=ps[2].map((v,j)=>v-ps[0][j]);
    const n:Vec3=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],mag=Math.hypot(...n);
    lines.push(`facet normal ${n.map(v=>foamNumber(v/mag)).join(' ')}`,'outer loop',...ps.map(p=>`vertex ${p.map(foamNumber).join(' ')}`),'endloop','endfacet');
  }
  return lines.join('\n')+'\nendsolid hull\n';
}

/** Genuine fixed-hull, calm-water, two-phase case. Results remain unverified until run and converged. */
export function generateOpenFoamCase(input:CfdCaseInput):CfdCasePackage {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.caseId))throw new Error('Case ID must contain only letters, numbers, underscores and hyphens.');
  if(!/^[a-fA-F0-9]{64}$/.test(input.sourceHash))throw new Error('A SHA-256 source geometry hash is required.');
  if(typeof input.protocolKey!=='string'||!input.protocolKey||input.protocolKey.length>20000)throw new Error('A bounded protocol snapshot key is required.');
  if(input.mode&&input.mode!=='fixed-resistance')throw new Error('The base generator supports a fixed hull only. Use the separately validated motion-case builder for free motion.');
  if(input.condition&&input.condition.kind!=='calm')throw new Error('The base generator supports calm water only. Use the separately validated wave-case builder for waves.');
  const {min,max,dims}=checkedTriangles(input.trianglesMm,input.geometryIsPosed),[L,B,D]=dims;
  positive(input.speedMps,'Speed',true);if(input.speedMps>5)throw new Error('Speed above 5 m/s is outside this model workbench.');
  positive(input.load.massKg,'Total test mass');positive(input.load.draftM,'Equilibrium draft');
  if(input.load.draftM>=D)throw new Error('A floating hull with positive freeboard is required.');
  const cgEstimated=input.load.cgSource==='cad-estimate';
  if(input.load.cgM.length!==3||!input.load.cgM.every(Number.isFinite))throw new Error('A finite centre of gravity in all three axes is required.');
  if(cgEstimated){
    if(input.load.cgMeasured!==false||input.load.cgAssumptionsConfirmed!==true||!input.load.cgAssumptions?.length||!input.load.cgAssumptions.every(s=>typeof s==='string'&&s.trim().length>0))throw new Error('CAD-estimated CG requires explicit accepted mass-distribution assumptions and must not be labelled measured.');
  }else if(input.load.cgMeasured!==true||input.load.cgSource&&input.load.cgSource!=='measured')throw new Error('Measured centre of gravity is required, or select the explicit CAD-estimate workflow.');
  const geometryKind=input.geometryKind??'sealed-envelope';
  if(!['printed-material','sealed-envelope'].includes(geometryKind))throw new Error('Choose actual printed-material or sealed-envelope solver geometry.');
  if(geometryKind==='printed-material'&&(!Number.isFinite(input.minimumWallThicknessM)||input.minimumWallThicknessM!<=0))throw new Error('Enter the minimum physical wall thickness for an open printed hull so its solid wall can be resolved.');
  if(geometryKind==='printed-material'&&!input.dryEnvelopeTrianglesMm)throw new Error('The closed dry-displacement envelope is required to initialise the printed hull cavity as air.');
  if(input.dryEnvelopeTrianglesMm)checkedTriangles(input.dryEnvelopeTrianglesMm,input.geometryIsPosed);
  const mesh=input.mesh??'coarse';
  const fidelity=input.fidelity??'standard';
  if(!['standard','quick'].includes(fidelity))throw new Error('Choose standard or quick fidelity.');
  if(!['coarse','medium','fine'].includes(mesh))throw new Error('Choose coarse, medium or fine mesh.');
  const maxCells=input.maxCells??750000;positive(maxCells,'Maximum mesh cells');if(maxCells>20000000||maxCells<10000)throw new Error('Mesh cell limit must be between 10,000 and 20,000,000.');
  const baseCell=L/8,baseSurface=mesh==='coarse'?3:mesh==='medium'?4:5;
  const wall=input.minimumWallThicknessM??null;
  const requiredWallLevel=wall?Math.ceil(Math.log2(3*baseCell/wall)):0;
  // Each study level must refine beyond the wall-resolved starting mesh.
  // Clamping all levels to one wall minimum would repeat the same mesh three times.
  const surfaceLevel=Math.max(3,requiredWallLevel)+(baseSurface-3);
  if(surfaceLevel>9)throw new Error('Wall thickness requires refinement beyond the supported mesh budget. Supply a resolved surface or a deliberate sealed-envelope geometry.');
  const finestCell=baseCell/2**surfaceLevel;
  // This deliberately conservative surface-cell estimate catches impossible thin-wall budgets early.
  const conservativeNearHullCells=Math.ceil(2*(L*B+L*D+B*D)/finestCell**2*2);
  if(wall&&conservativeNearHullCells>maxCells)throw new Error(`Resolving the printed walls needs approximately ${conservativeNearHullCells.toLocaleString('en-GB')} near-hull cells, above this case's ${maxCells.toLocaleString('en-GB')} cell budget. Increase the budget or use a deliberate exterior sealed envelope; do not silently erase the wall.`);
  const domainScale=input.domainScale??1;positive(domainScale,'Domain scale');if(domainScale<1||domainScale>4)throw new Error('Domain scale must be between 1 and 4; reduce mesh size or increase the case budget when enlarging it.');
  const minDomain:Vec3=[-5*L*domainScale,-B/2-3*L*domainScale,-input.load.draftM-3*L*domainScale];
  const maxDomain:Vec3=[max[0]+2*L*domainScale,B/2+3*L*domainScale,Math.max(L*domainScale,D-input.load.draftM+L/2*domainScale)];
  const cells=maxDomain.map((v,i)=>Math.max(2,Math.ceil((v-minDomain[i])/baseCell))) as [number,number,number];
  const baseCount=cells[0]*cells[1]*cells[2];if(baseCount>maxCells)throw new Error('The base domain exceeds the maximum mesh-cell budget.');
  const duration=input.durationS??Math.max(8,16*L/Math.max(input.speedMps,.05));positive(duration,'Run duration');if(duration>600)throw new Error('A single run is limited to 600 simulated seconds.');
  const quick=fidelity==='quick',maxAlphaCo=quick?.5:.25;
  const maxCo=input.maxCo??.25;positive(maxCo,'Courant limit');if(maxCo>(quick?1:.5))throw new Error(quick?'Use a Courant limit no larger than 1 for quick runs.':'Use a Courant limit no larger than 0.5 for this VOF setup.');
  const dt=input.timeStepS??Math.min(.001,.2*finestCell/Math.max(input.speedMps,.05));positive(dt,'Initial time step');
  const maxDt=input.maxDeltaTS??dt;positive(maxDt,'Maximum time step');
  if(dt>maxDt||maxDt>.01)throw new Error('Initial time step must not exceed the maximum, and the maximum must not exceed 0.01 s.');
  const writeInterval=duration/20;
  const cg=input.load.cgM,solverCg:Vec3=[cg[0],cg[1],cg[2]-input.load.draftM];
  const manifest:CfdManifest={
    schemaVersion:1,caseId:input.caseId,sourceHash:input.sourceHash.toLowerCase(),protocolKey:input.protocolKey,units:'SI',
    solver:{distribution:'OpenCFD',version:'2312',application:'interFoam',image:'opencfd/openfoam-run:2312',imageDigest:'sha256:8d411a033af4a841c98ccaab7a49407812a6d78ba22e501fa1c92b2038d39a76'},mode:'fixed-resistance',condition:{kind:'calm'},
    geometry:{kind:geometryKind,triangleCount:input.trianglesMm.length/9,translationM:[0,0,-input.load.draftM],minM:[min[0],min[1],min[2]-input.load.draftM],maxM:[max[0],max[1],max[2]-input.load.draftM],minimumWallThicknessM:wall,dryCavityInitialised:geometryKind==='printed-material',watertightPreflight:true},
    load:{...input.load,cgSource:cgEstimated?'cad-estimate':'measured',cgAssumptions:cgEstimated?[...input.load.cgAssumptions!]:[],cgM:[...cg],solverCgM:solverCg},speedMps:input.speedMps,
    physics:{densityWaterKgM3:998,densityAirKgM3:1.2,nuWaterM2S:1.004e-6,nuAirM2S:1.5e-5,surfaceTensionNpm:.072,gravityMps2:9.81,flowModel:'laminar',contactAngleAssumptionDeg:90},
    domain:{scale:domainScale,minM:minDomain,maxM:maxDomain,upstreamClearanceM:2*L*domainScale,downstreamClearanceM:5*L*domainScale,sideClearanceM:3*L*domainScale,belowKeelClearanceM:3*L*domainScale,airClearanceM:maxDomain[2]-(D-input.load.draftM),boundaryIndependent:false},
    mesh:{level:mesh,fidelity,baseCellSizeM:baseCell,baseCells:cells,estimatedBaseCells:baseCount,surfaceLevels:[Math.max(1,surfaceLevel-1),surfaceLevel],finestCellM:finestCell,maxCells,layers:0,wallCellsAtFinest:wall?wall/finestCell:null,resolutionVerified:false},
    numerics:{durationS:duration,initialDeltaTS:dt,maxDeltaTS:maxDt,maxCo,maxAlphaCo,writeIntervalS:writeInterval,recommendedWarmupS:Math.min(duration/2,5*L/Math.max(input.speedMps,.05))},
    conventions:{waterlineZ:0,flowDirection:[-1,0,0],dragFromForce:'negative Fx',heaveAxis:'+Z',rollAxis:'+X',forceFile:'postProcessing/hullForces/0/force.dat'},
    verification:{status:'not-run',required:['surfaceCheck: closed, consistently oriented actual solid','mandatory checkMesh topology/meshQuality safety pass; detailed geometry diagnostics separately reviewed','finite solver residuals and bounded alpha.water','final-time completion and force-history stationarity','mass conservation / flux balance','mesh, time-step and domain convergence before ranking']},
    notes:[
      cgEstimated?'CG is calculated from CAD under explicitly accepted mass-distribution assumptions; it is not measured. '+input.load.cgAssumptions!.join(' '):'CG is supplied as measured loaded mass-centre coordinates.',
      'Actual CAD surface is used at a fixed calculated equilibrium draft. No proxy hull or empirical drag is substituted.',
      'This fixed-hull case measures towing resistance and total fluid force at a prescribed pose; it cannot calculate free roll or stability response.',
      'Laminar flow is an explicit baseline for small, untripped models. Transition, roughness and near-wall resolution require sensitivity checks or measurements.',
      'Water-air surface tension is enabled with a 90-degree implicit wetting assumption. Real printed-material contact angle is unknown.',
      'The initial domain is a starting proposal only. Side/bottom slip boundaries and outlet can still affect results; numerical domain independence has not been established.',
      'Coarse mesh is a solver smoke test, not an accuracy certificate. Actual achieved refinement, hull/waterline resolution and refinement convergence must be checked.',
      ...(fidelity==='quick'?['QUICK run: shortened observation window and, for waves, a lighter wave grid. Use it to screen designs fast; numbers are rough and not comparable with standard-fidelity runs.']:[]),
      'For a printed hull, a separate closed displacement envelope sets the initial cavity phase to air. This envelope is not included in the meshed physical hull.',
      'No boundary layers are added by this starter case. Finite-volume wall stress and pressure drag require near-wall mesh convergence.',
    ],
  };
  const n=foamNumber,v=foamVector,[x0,y0,z0]=minDomain,[x1,y1,z1]=maxDomain;
  const flow:Vec3=[-input.speedMps,0,0],fluidPoint:Vec3=[x1-L/2,0,-Math.min(input.load.draftM/2,L/4)];
  const verts:Vec3[]=[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const patches=['inlet','outlet','port','starboard','bottom','atmosphere','hull'];
  const files:Record<string,string|Uint8Array>={};
  files['constant/triSurface/hull.stl']=asciiStl(input.trianglesMm,input.load.draftM);
  if(geometryKind==='printed-material')files['constant/triSurface/dryEnvelope.stl']=asciiStl(input.dryEnvelopeTrianglesMm!,input.load.draftM);
  files['system/blockMeshDict']=dict('blockMeshDict',`scale 1;\nvertices\n(\n${verts.map(p=>'    '+v(p)).join('\n')}\n);\nblocks (hex (0 1 2 3 4 5 6 7) ${v(cells)} simpleGrading (1 1 1));\nedges ();\nboundary\n(\n    inlet { type patch; faces ((1 2 6 5)); }\n    outlet { type patch; faces ((0 4 7 3)); }\n    port { type patch; faces ((3 7 6 2)); }\n    starboard { type patch; faces ((0 1 5 4)); }\n    bottom { type patch; faces ((0 3 2 1)); }\n    atmosphere { type patch; faces ((4 5 6 7)); }\n);\nmergePatchPairs ();`);
  files['system/surfaceFeatureExtractDict']=dict('surfaceFeatureExtractDict',`hull.stl\n{\n    extractionMethod extractFromSurface;\n    extractFromSurfaceCoeffs { includedAngle 150; }\n    writeObj no;\n}`);
  files['system/snappyHexMeshDict']=dict('snappyHexMeshDict',`castellatedMesh true;\nsnap true;\naddLayers false;\ngeometry\n{\n    hull.stl { type triSurfaceMesh; name hull; }\n    hullWaterline\n    {\n        type searchableBox;\n        min ${v([-L/4,-B/2-L/4,-Math.min(D,input.load.draftM+L/8)])};\n        max ${v([L*1.25,B/2+L/4,Math.min(D,L/8)])};\n    }\n}\ncastellatedMeshControls\n{\n    maxLocalCells ${Math.floor(maxCells)};\n    maxGlobalCells ${Math.floor(maxCells)};\n    minRefinementCells 0;\n    maxLoadUnbalance 0.1;\n    nCellsBetweenLevels 3;\n    features ({ file "hull.eMesh"; level ${Math.max(1,surfaceLevel-1)}; });\n    refinementSurfaces\n    {\n        hull { level (${Math.max(1,surfaceLevel-1)} ${surfaceLevel}); patchInfo { type wall; } }\n    }\n    resolveFeatureAngle 30;\n    refinementRegions\n    {\n        hullWaterline { mode inside; levels ((1e15 ${Math.max(1,surfaceLevel-2)})); }\n    }\n    locationInMesh ${v(fluidPoint)};\n    allowFreeStandingZoneFaces true;\n}\nsnapControls\n{\n    nSmoothPatch 3; tolerance 2.0; nSolveIter 30; nRelaxIter 5;\n    nFeatureSnapIter 10; implicitFeatureSnap false; explicitFeatureSnap true; multiRegionFeatureSnap false;\n}\naddLayersControls\n{\n    relativeSizes true; layers {}; expansionRatio 1.2; finalLayerThickness 0.3; minThickness 0.1;\n    nGrow 0; featureAngle 60; nRelaxIter 5; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10;\n    maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50;\n}\nmeshQualityControls\n{\n    #include "meshQualityDict"\n}\nwriteFlags (scalarLevels layerSets layerFields);\nmergeTolerance 1e-6;`);
  files['system/meshQualityDict']=dict('meshQualityDict',`maxNonOrtho 65;\nmaxBoundarySkewness 20;\nmaxInternalSkewness 4;\nmaxConcave 80;\nminVol 1e-18;\nminTetQuality 1e-15;\nminArea -1;\nminTwist 0.02;\nminDeterminant 0.001;\nminFaceWeight 0.02;\nminVolRatio 0.01;\nminTriangleTwist -1;\nnSmoothScale 4;\nerrorReduction 0.75;\nrelaxed { maxNonOrtho 75; }`);
  files['constant/transportProperties']=dict('transportProperties',`phases (water air);\nwater\n{\n    transportModel Newtonian;\n    nu [0 2 -1 0 0 0 0] 1.004e-6;\n    rho [1 -3 0 0 0 0 0] 998;\n}\nair\n{\n    transportModel Newtonian;\n    nu [0 2 -1 0 0 0 0] 1.5e-5;\n    rho [1 -3 0 0 0 0 0] 1.2;\n}\nsigma [1 0 -2 0 0 0 0] 0.072;`,'constant');
  files['constant/turbulenceProperties']=dict('turbulenceProperties','simulationType laminar;','constant');
  files['constant/g']=foamHeader('g','uniformDimensionedVectorField','constant')+'dimensions [0 1 -2 0 0 0 0];\nvalue (0 0 -9.81);\n';
  files['system/fvSchemes']=dict('fvSchemes',`ddtSchemes { default Euler; }\ngradSchemes { default Gauss linear; }\ndivSchemes\n{\n    div(rhoPhi,U) Gauss linearUpwind grad(U);\n    div(phi,alpha) Gauss vanLeer;\n    div(phirb,alpha) Gauss interfaceCompression;\n    div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;\n}\nlaplacianSchemes { default Gauss linear limited corrected 0.5; }\ninterpolationSchemes { default linear; }\nsnGradSchemes { default limited corrected 0.5; }\nwallDist { method meshWave; }\nfluxRequired { default no; p_rgh; pcorr; alpha.water; }`);
  files['system/fvSolution']=dict('fvSolution',`solvers\n{\n    "alpha.water.*"\n    {\n        nAlphaCorr 2; nAlphaSubCycles ${quick?1:2}; cAlpha 1;\n        MULESCorr yes; nLimiterIter 3;\n        solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0;\n    }\n    "pcorr.*" { solver GAMG; smoother DICGaussSeidel; tolerance 1e-6; relTol 0; } // multigrid: PCG needed ~450 iterations per moving-mesh step\n    p_rgh { solver GAMG; tolerance 1e-7; relTol 0.01; smoother DICGaussSeidel; }\n    p_rghFinal { $p_rgh; relTol 0; }\n    U { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0; }\n    UFinal { $U; relTol 0; }\n}\nPIMPLE\n{\n    momentumPredictor yes; ${quick?'nOuterCorrectors 1; nCorrectors 3':'nOuterCorrectors 2; nCorrectors 2'}; nNonOrthogonalCorrectors 1;\n    pRefCell 0; pRefValue 0;\n}\nrelaxationFactors { equations { ".*" 1; } }`);
  const dryCavity=geometryKind==='printed-material'?`\n    surfaceToCell\n    {\n        file "constant/triSurface/dryEnvelope.stl";\n        outsidePoints (${v(fluidPoint)});\n        includeInside true; includeOutside false; includeCut false;\n        nearDistance -1; curvature -100;\n        fieldValues (volScalarFieldValue alpha.water 0);\n    }`:'';
  files['system/setFieldsDict']=dict('setFieldsDict',`defaultFieldValues (volScalarFieldValue alpha.water 0);\nregions\n(\n    boxToCell\n    {\n        box ${v([x0-L,y0-L,z0-L])} ${v([x1+L,y1+L,0])};\n        fieldValues (volScalarFieldValue alpha.water 1);\n    }${dryCavity}\n);`);
  files['system/controlDict']=dict('controlDict',`application interFoam;\nstartFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime ${n(duration)};\ndeltaT ${n(dt)};\nwriteControl adjustableRunTime;\nwriteInterval ${n(writeInterval)};\npurgeWrite 2;\nwriteFormat ascii;\nwritePrecision 10;\nwriteCompression on;\ntimeFormat general;\ntimePrecision 10;\nrunTimeModifiable false;\nadjustTimeStep yes;\nmaxCo ${n(maxCo)};\nmaxAlphaCo ${n(maxAlphaCo)};\nmaxDeltaT ${n(maxDt)};\nfunctions\n{\n${CALM_REFERENCE_FUNCTION}    hullForces\n    {\n        type forces; libs ("libforces.so");\n        patches (hull); p p; U U; rho rho;\n        CofR ${v(solverCg)};\n        log yes; writeControl timeStep; writeInterval 1;\n    }\n    phaseBounds\n    {\n        type fieldMinMax; libs ("libfieldFunctionObjects.so");\n        fields (alpha.water); log yes;\n        writeControl timeStep; writeInterval 10;\n    }\n    waterVolume\n    {\n        type volFieldValue; libs ("libfieldFunctionObjects.so");\n        regionType all; operation volIntegrate; fields (alpha.water);\n        writeFields false; log yes; writeControl timeStep; writeInterval 10;\n    }\n}`);
  files['0/U']=field('U','volVectorField','[0 1 -1 0 0 0 0]',`uniform ${v(flow)}`,patches.map(p=>p==='inlet'?`    ${p} { type fixedValue; value uniform ${v(flow)}; }`:p==='outlet'?`    ${p} { type outletPhaseMeanVelocity; Umean ${n(input.speedMps)}; alpha alpha.water; value uniform ${v(flow)}; }`:p==='hull'?`    ${p} { type noSlip; }`:p==='atmosphere'?`    ${p} { type pressureInletOutletVelocity; value uniform (0 0 0); }`:`    ${p} { type slip; }`).join('\n'));
  files['0/p_rgh']=field('p_rgh','volScalarField','[1 -1 -2 0 0 0 0]','uniform 0',patches.map(p=>p==='outlet'?`    ${p} { type zeroGradient; }`:p==='atmosphere'?`    ${p} { type prghPressure; rho rho; p uniform 0; value uniform 0; }`:`    ${p} { type fixedFluxPressure; value uniform 0; }`).join('\n'));
  const interfaceEps=Math.max(1e-8,baseCell*1e-4);
  files['0/alpha.water']=field('alpha.water','volScalarField','[0 0 0 0 0 0 0]','uniform 0',patches.map(p=>p==='inlet'?`    ${p}\n    {\n        type fixedProfile;\n        profile table ((${n(z0-L)} 1) (${n(-interfaceEps)} 1) (${n(interfaceEps)} 0) (${n(z1+L)} 0));\n        direction (0 0 1); origin 0; value uniform 0;\n    }`:p==='outlet'?`    ${p} { type variableHeightFlowRate; lowerBound 0; upperBound 1; value uniform 0; }`:p==='atmosphere'?`    ${p} { type inletOutlet; inletValue uniform 0; value uniform 0; }`:`    ${p} { type zeroGradient; }`).join('\n'));
  // Calm towing outlet (standard ship-resistance setup): the outflow keeps the mean water velocity at the tow speed and the
  // water height follows the flow, so the tank cannot drain or slosh through the outlet. A density-weighted absorber over the
  // last 2 L before the outlet damps the hull's wake waves towards the tow flow. Long Roihu runs (14.7 s) with the previous
  // fixed-pressure outlet drifted to negative drag; with this setup the drag is stationary after ~5 L/U and 16- and 32-core
  // runs agree within 1% (verification/calm-outlet). Wave cases replace these boundaries, fvOptions and UTow.
  {
    const far=100,spongeEnd=x0+2*L*domainScale,centre:Vec3=[spongeEnd+far,0,0];
    files['system/fvOptions']=foamHeader('fvOptions','dictionary','system')+`calmOutletAbsorber\n{\n    type acousticDampingSource;\n    selectionMode all;\n    centre ${v(centre)};\n    radius1 ${n(far)};\n    radius2 ${n(centre[0]-x0)};\n    frequency 0.5;\n    w 20;\n    URef UTow;\n}\n`;
    files['0/UTow']=foamHeader('UTow','volVectorField','0')+`dimensions [0 1 -1 0 0 0 0];\ninternalField uniform ${v(flow)};\nboundaryField\n{\n    ".*" { type calculated; value uniform ${v(flow)}; }\n}\n`;
  }
  files['Allrun']=`#!/usr/bin/env bash\nset -euo pipefail\ncd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")"\nif ! command -v interFoam >/dev/null 2>&1; then\n    set +eu\n    if [[ -f /usr/lib/openfoam/openfoam2312/etc/bashrc ]]; then\n        source /usr/lib/openfoam/openfoam2312/etc/bashrc\n    elif [[ -f /opt/openfoam2312/etc/bashrc ]]; then\n        source /opt/openfoam2312/etc/bashrc\n    else\n        echo 'OpenCFD OpenFOAM v2312 is required. No empirical fallback will run.' >&2\n        exit 2\n    fi\n    set -eu\nfi\nif [[ "${'$'}{WM_PROJECT_VERSION:-}" != 'v2312' && "${'$'}{WM_PROJECT_VERSION:-}" != '2312' ]]; then\n    echo 'This case is pinned to OpenCFD OpenFOAM v2312.' >&2\n    exit 2\nfi\n# Stream every stage live (line-buffered) while still writing log.<stage> for the result reader.\nLINEBUF=()\nif command -v stdbuf >/dev/null 2>&1; then LINEBUF=(stdbuf -oL -eL); fi\nrun_stage() {\n    local stage="${'$'}1"\n    echo "HULL_CFD_STAGE:${'$'}stage"\n    if ! ${'$'}{LINEBUF[@]+"${'$'}{LINEBUF[@]}"} "$@" 2>&1 | tee "log.${'$'}stage"; then echo "Stage ${'$'}stage failed; see log.${'$'}stage." >&2; exit 1; fi\n}\nrun_stage surfaceCheck -checkSelfIntersection constant/triSurface/hull.stl\nrun_stage blockMesh\nrun_stage surfaceFeatureExtract\nrun_stage snappyHexMesh -overwrite\nrun_stage checkMesh -allTopology -meshQuality\nif ! grep -q 'Mesh OK' log.checkMesh; then\n    # Same rule as the result reader: only skew / severely non-orthogonal faces among the generic failures, no
    # meshQualityDict face with bad pyramid volume, tet quality or determinant, and at most max(10, cells/10000) soft faces.
    if awk '/^[[:space:]]*cells:/{cells=$2} /^[[:space:]]*\\*\\*\\*/{if($0!~/highly skew faces|severely non-orthogonal/)generic=1} /Failed [1-9][0-9]* mesh checks/{failed=1} /FOAM FATAL|Mesh has failed/{fatal=1} /Checking faces in error/{f=1;next} f&&(/^[[:space:]]*$/||/<</){f=0} f&&/: *[0-9]+ *$/{n=$NF+0; seen=1; if($0~/pyramid|tet quality|determinant/){if(n>0)hard=1}else soft+=n} END{limit=int(cells/10000); if(limit<10)limit=10; exit !(failed && !fatal && seen && !hard && !generic && soft<=limit)}' log.checkMesh; then
        echo 'A few faces exceed generic checkMesh limits (skewness or non-orthogonality up to the relaxed 75°); no invalid cells and within the accepted count.'
    else
        echo 'Mesh quality checks did not pass. Solver stopped before creating results.' >&2\n        exit 1\n    fi\nfi\necho "HULL_CFD_STAGE:meshDetailedDiagnostics"\ncheckMesh -allTopology -allGeometry > log.checkMeshDetailed 2>&1 || true\nif ! grep -q 'Mesh OK' log.checkMeshDetailed; then echo 'Detailed geometry diagnostics need review; see log.checkMeshDetailed. This run is not validated.'; fi\nif [[ -f system/topoSetDict ]]; then run_stage topoSet; fi\nrun_stage setFields\n# HULL_NPROCS>1 splits the solve across CPU cores with MPI. Physics and case inputs are unchanged.\nNPROCS="${'$'}{HULL_NPROCS:-1}"\nif [[ "${'$'}NPROCS" =~ ^[0-9]+$ ]] && (( NPROCS > 1 )); then\n    printf 'FoamFile\\n{\\n    version 2.0;\\n    format ascii;\\n    class dictionary;\\n    object decomposeParDict;\\n}\\nnumberOfSubdomains %s;\\nmethod scotch;\\n' "${'$'}NPROCS" > system/decomposeParDict\n    run_stage decomposePar -force\n    export OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 OMPI_MCA_btl_vader_single_copy_mechanism=none OMPI_MCA_mpi_yield_when_idle=1\n    echo "HULL_CFD_STAGE:interFoam"\n    echo "Running interFoam on ${'$'}NPROCS cores"\n    if ! mpirun --oversubscribe --bind-to none -np "${'$'}NPROCS" ${'$'}{LINEBUF[@]+"${'$'}{LINEBUF[@]}"} interFoam -parallel 2>&1 | tee log.interFoam; then echo 'Stage interFoam failed; see log.interFoam.' >&2; exit 1; fi\nelse\n    run_stage interFoam\nfi\n`;
  files['case.foam']='';
  files['README.txt']=`OpenCFD OpenFOAM v2312 fixed-hull free-surface case\n\nRun: bash Allrun\nUse only the pinned distribution/version. The script runs surface/mesh checks and stops on failure. It never deletes prior data. Use a fresh case directory for each variant.\n\nGeometry is the actual original STL transformed from mm to m and shifted vertically by -draft. Inflow is negative X; towing drag is -Fx from hullForces, not the magnitude of an arbitrary component. Moment reference is the supplied CG in the shifted frame; its measured or estimated source is recorded in manifest.json.\n\nA successful solver exit is not a validation certificate. Discard startup and establish stationarity, phase/mass balance, surface/mesh quality and mesh/time/domain convergence before comparing designs. The coarse mesh is a smoke test. The laminar flow and 90-degree wetting assumptions require physical sensitivity checks. Fixed hull cannot predict roll motion.\n\nSee manifest.json for exact protocol, load, geometry hash, dimensions and assumptions.\n`;
  files['manifest.json']=JSON.stringify(manifest,null,2)+'\n';
  return {files,manifest};
}

export const generateCase=generateOpenFoamCase;
