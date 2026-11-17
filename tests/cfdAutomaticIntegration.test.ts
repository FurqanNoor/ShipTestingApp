import {describe,it,expect} from 'vitest';
import {boxHull} from '../src/engine/example';
import {createAutomaticPlan} from '../src/cfd/automatic';
import {prepareCfdJob} from '../src/cfd/request';

const plan=()=>createAutomaticPlan({name:'Automatic analytical box',trianglesMm:boxHull(200,80,50)});
describe('Automatic protocol reaches actual case generation without manual physical inputs',()=>{
  it('prepares all nine standard conditions and never claims imposed weights were measured',async()=>{
    for(const c of plan().conditions){
      const p=await prepareCfdJob(c.request,`auto-${c.id}`);
      expect(p.request.measurementsConfirmed).toBe(false);expect(p.request.massSource).toBe('protocol-default');
      expect(p.package.manifest.load.massMeasured).toBe(false);expect(p.package.manifest.load.cgMeasured).toBe(false);
      expect(p.request.floatingPose?.residualM).toBeLessThan(1e-6);expect(p.hydro.buoyancyN).toBeCloseTo(c.massKg*9.81,8);
      const estimate=JSON.parse(String(p.package.files['cg-estimate.json']));expect(estimate.totalLoadedMassConfirmed).toBe(false);
      if(c.mode==='beam-waves'){
        const motion=(p.package.manifest as unknown as {motion:{inertiaSource:string;inertiaMeasured:boolean;effectiveRollInertiaKgM2:number}}).motion;
        expect(motion.inertiaSource).toBe('cad-estimate');expect(motion.inertiaMeasured).toBe(false);expect(motion.effectiveRollInertiaKgM2).toBeGreaterThan(0);
        expect(String(p.package.files['constant/dynamicMeshDict'])).toContain('momentOfInertia');
      }
    }
  });
  it('retains a common physical protocol across mesh and actual timestep controls',async()=>{
    const req=plan().conditions[0].request;
    const a=await prepareCfdJob({...req,timeStepS:.0005,maxDeltaTS:.0005},'auto-reference');
    const b=await prepareCfdJob({...req,mesh:'medium',timeStepS:.00025,maxDeltaTS:.00025},'auto-refined');
    expect(a.geometryHash).toBe(b.geometryHash);expect(a.protocolHash).toBe(b.protocolHash);
    expect(b.package.manifest.numerics.maxDeltaTS).toBe(.00025);expect(String(b.package.files['system/controlDict'])).toContain('maxDeltaT 0.00025;');
  });
  it('rejects a claimed automatic measured weight and unknown automatic protocol',async()=>{
    const req=plan().conditions[0].request;
    await expect(prepareCfdJob({...req,measurementsConfirmed:true},'bad-provenance')).rejects.toThrow(/unmeasured/);
    await expect(prepareCfdJob({...req,automation:{schema:1,protocol:'made-up'}},'bad-protocol')).rejects.toThrow(/Unsupported/);
    await expect(prepareCfdJob({...req,massKg:.2},'bad-standard-mass')).rejects.toThrow(/150/);
  });
  it('does not mask an oversized original CAD by later posing it',async()=>{
    const req=plan().conditions[0].request;
    await expect(prepareCfdJob({...req,trianglesMm:Array.from(boxHull(260,80,50))},'oversized-auto')).rejects.toThrow(/250/);
  });
  it('keeps advanced CAD inertia explicit and separately preserves measured mass provenance',async()=>{
    const req=plan().conditions.find(c=>c.mode==='beam-waves')!.request;
    const p=await prepareCfdJob({...req,automation:undefined,measurementsConfirmed:true},'advanced-auto-inertia');
    expect(p.request.massSource).toBe('measured');expect(p.request.cgSource).toBe('cad-estimate');expect(p.request.inertiaMeasured).toBe(false);
    expect(p.request.inertiaTensorKgM2).toBeDefined();expect(p.request.floatingPose).toBeUndefined();
  });
  it('rejects a maximum time step below the initial time step',async()=>{
    await expect(prepareCfdJob({...plan().conditions[0].request,timeStepS:.001,maxDeltaTS:.0005},'bad-time-controls')).rejects.toThrow(/Initial time step/);
  });
});
