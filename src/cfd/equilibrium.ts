/** Dry hydrostatic roll/trim initialization of an already validated CAD hull. */
import type {CfdHull,CfdPoint} from './geometry';
import {computeHydrostatics,type CfdHydroState} from './hydro';

export type EquilibriumMatrix=[CfdPoint,CfdPoint,CfdPoint];
export interface FloatingEquilibriumOptions {
  massKg:number;
  cgM:CfdPoint;
  densityKgM3?:number;
  gravityMps2?:number;
  maxAngleRad?:number;
  maxIterations?:number;
  toleranceM?:number;
}
export interface FloatingEquilibrium {
  hull:CfdHull;
  cgM:CfdPoint;
  /** Original model to posed model, row-major; p' = rotation p + translationM. */
  rotation:EquilibriumMatrix;
  translationM:CfdPoint;
  rollRad:number;
  pitchRad:number;
  hydro:CfdHydroState;
  /** Horizontal separation of buoyancy and mass centres after the heave solve. */
  residualM:number;
  iterations:number;
}

const rotate=(r:EquilibriumMatrix,p:CfdPoint):CfdPoint=>r.map(row=>row[0]*p[0]+row[1]*p[1]+row[2]*p[2]) as CfdPoint;
function matrix(roll:number,pitch:number):EquilibriumMatrix {
  const sr=Math.sin(roll),cr=Math.cos(roll),sp=Math.sin(pitch),cp=Math.cos(pitch);
  return [[cp,sp*sr,sp*cr],[0,cr,-sr],[-sp,cp*sr,cp*cr]];
}

/** A rigid transform; no geometry repair, scale, mass adjustment or proxy hull is applied. */
function pose(original:CfdHull,cg:CfdPoint,roll:number,pitch:number) {
  const rotation=matrix(roll,pitch),min:CfdPoint=[Infinity,Infinity,Infinity],max:CfdPoint=[-Infinity,-Infinity,-Infinity];
  const transformArray=(input:Float64Array)=>{
    const out=new Float64Array(input.length);
    for(let i=0;i<input.length;i+=3){
      const p=rotate(rotation,[input[i],input[i+1],input[i+2]]);
      for(let k=0;k<3;k++){out[i+k]=p[k];min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
    }
    return out;
  };
  const triangles=transformArray(original.trianglesM);
  const solver=original.solverTrianglesM===original.trianglesM?triangles:transformArray(original.solverTrianglesM);
  const translationM:CfdPoint=[-min[0],-(min[1]+max[1])/2,-min[2]];
  const shifted=(p:CfdPoint):CfdPoint=>p.map((v,k)=>v+translationM[k]) as CfdPoint;
  for(let i=0;i<triangles.length;i++)triangles[i]+=translationM[i%3];
  if(solver!==triangles)for(let i=0;i<solver.length;i++)solver[i]+=translationM[i%3];
  const minM=shifted(min),maxM=shifted(max);
  const hull:CfdHull={...original,trianglesM:triangles,solverTrianglesM:solver,
    centroidM:shifted(rotate(rotation,original.centroidM)),
    rimVerticesM:original.rimVerticesM.map(p=>shifted(rotate(rotation,p))),
    bounds:{minM,maxM,lengthM:maxM[0]-minM[0],beamM:maxM[1]-minM[1],depthM:maxM[2]-minM[2]},
    notes:[...original.notes],
  };
  return {hull,cgM:shifted(rotate(rotation,cg)),rotation,translationM};
}

/**
 * Solve CBx=CGx and CBy=CGy, with exact facet displacement solving heave at
 * every trial. Newton steps are bounded and damped; failed dry-rim trials are
 * rejected. An unsuccessful solve never changes the prescribed CG or load.
 */
export function solveFloatingEquilibrium(original:CfdHull,options:FloatingEquilibriumOptions):FloatingEquilibrium {
  if(!options||!Array.isArray(options.cgM)||options.cgM.length!==3||!options.cgM.every(Number.isFinite))throw new Error('A finite loaded CAD CG is required for automatic floating equilibrium.');
  const maxAngle=options.maxAngleRad??20*Math.PI/180,maxIterations=options.maxIterations??15,tolerance=options.toleranceM??1e-6;
  if(!Number.isFinite(maxAngle)||maxAngle<=0||maxAngle>30*Math.PI/180)throw new Error('Automatic equilibrium angle bound must be positive and at most 30 degrees.');
  if(!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>30)throw new Error('Automatic equilibrium iterations must be from 1 to 30.');
  if(!Number.isFinite(tolerance)||tolerance<=0||tolerance>1e-4)throw new Error('Equilibrium residual tolerance must be positive and no greater than 0.1 mm.');
  function evaluate(roll:number,pitch:number) {
    const placed=pose(original,options.cgM,roll,pitch);
    const hydro=computeHydrostatics(placed.hull,{massKg:options.massKg,cgM:placed.cgM,densityKgM3:options.densityKgM3??998,gravityMps2:options.gravityMps2??9.81,requireStable:false});
    const residual:[number,number]=[hydro.centerBuoyancyM[0]-placed.cgM[0],hydro.centerBuoyancyM[1]-placed.cgM[1]];
    return {...placed,hydro,residual,residualM:Math.hypot(...residual),rollRad:roll,pitchRad:pitch};
  }
  let state=evaluate(0,0),iterations=0;
  for(;iterations<maxIterations&&state.residualM>tolerance;iterations++){
    const h=1e-4;
    const derivative=(axis:0|1)=>{
      for(const sign of [1,-1]){
        const angles:[number,number]=[state.rollRad,state.pitchRad];angles[axis]+=sign*h;
        if(Math.abs(angles[axis])>maxAngle)continue;
        try{const trial=evaluate(...angles);return trial.residual.map((v,k)=>(v-state.residual[k])/(sign*h));}catch{/* Try the inward difference if the forward trial floods. */}
      }
      throw new Error('No dry finite-difference equilibrium step exists near this load.');
    };
    const a=derivative(0),b=derivative(1),det=a[0]*b[1]-b[0]*a[1];
    const jacScale=Math.max(Math.abs(a[0]),Math.abs(a[1]),Math.abs(b[0]),Math.abs(b[1]));
    if(!Number.isFinite(det)||Math.abs(det)<Math.max(1e-14,jacScale*jacScale*1e-9))throw new Error('The hydrostatic equilibrium Jacobian is singular; no reliable dry roll/trim start was found.');
    let dRoll=(-state.residual[0]*b[1]+b[0]*state.residual[1])/det;
    let dPitch=(-a[0]*state.residual[1]+state.residual[0]*a[1])/det;
    const scale=Math.min(1,.1/Math.max(Math.abs(dRoll),Math.abs(dPitch)));dRoll*=scale;dPitch*=scale;
    let improved:ReturnType<typeof evaluate>|null=null;
    for(let damping=1;damping>=1/128;damping/=2){
      const roll=state.rollRad+damping*dRoll,pitch=state.pitchRad+damping*dPitch;
      if(Math.abs(roll)>maxAngle||Math.abs(pitch)>maxAngle)continue;
      try{const trial=evaluate(roll,pitch);if(trial.residualM<state.residualM){improved=trial;break;}}catch{/* Flooded or invalid dry trials cannot initialize a solve. */}
    }
    if(!improved)throw new Error(`No dry floating equilibrium converged within ±${(maxAngle*180/Math.PI).toFixed(1)} degrees. The load/CG was not altered.`);
    state=improved;
  }
  if(state.residualM>tolerance)throw new Error(`Automatic floating equilibrium did not converge within ${maxIterations} iterations. The load/CG was not altered.`);
  if(!(state.hydro.gmM>0))throw new Error('The solved dry equilibrium has non-positive transverse GM; no stable free-motion start was found.');
  // Verify longitudinal as well as transverse restoring behaviour. The residual
  // Jacobian is converted to torque derivatives in the two angle coordinates.
  // At equilibrium, applied rotations about fixed model Y and Ry(pitch) X give
  // generalized torques [cos(pitch)*FyOffset, -FxOffset] * buoyancy.
  const h=1e-4;
  const dr=evaluate(state.rollRad+h,state.pitchRad),dp=evaluate(state.rollRad,state.pitchRad+h);
  const j00=Math.cos(state.pitchRad)*(dr.residual[1]-state.residual[1])/h;
  const j01=Math.cos(state.pitchRad)*(dp.residual[1]-state.residual[1])/h;
  const j10=-(dr.residual[0]-state.residual[0])/h;
  const j11=-(dp.residual[0]-state.residual[0])/h;
  const cross=(j01+j10)/2;
  if(!(j00<0&&j11<0&&j00*j11-cross*cross>0))throw new Error('The solved dry roll/trim equilibrium is not restoring in both rotational directions.');
  const hydro:CfdHydroState={...state.hydro,
    flags:state.hydro.flags.filter(f=>!f.startsWith('unbalanced-upright')),
    warnings:state.hydro.warnings.filter(w=>!w.startsWith('Initial draft assumes upright')&&!w.startsWith('Specified transverse CG')&&!w.startsWith('Specified longitudinal CG')),
  };
  hydro.warnings.push(`Initial dry hydrostatic roll/trim solved from the CAD envelope and stated mass distribution; CB–CG horizontal residual ${(state.residualM*1000).toPrecision(3)} mm. This does not validate real loading or flooding.`);
  const hull={...state.hull,notes:[...state.hull.notes,`Automatic initial rigid CAD pose: roll ${state.rollRad*180/Math.PI} degrees, trim ${state.pitchRad*180/Math.PI} degrees. The original CAD shape and scale are preserved.`]};
  return {hull,cgM:state.cgM,rotation:state.rotation,translationM:state.translationM,rollRad:state.rollRad,pitchRad:state.pitchRad,hydro,residualM:state.residualM,iterations};
}
