import {describe,it,expect} from 'vitest';
import {generateOpenFoamCase,type CfdCaseInput} from '../src/cfd/case';
import {extendCaseWithWaves,type WaveCaseSettings} from '../src/cfd/waves';
import {boxHull} from '../src/engine/example';
import {buildAutomaticStudyRequest,normaliseChoice,plannedSolves,formatDuration,reviewText,AUTO_CONDITION_IDS,DEFAULT_AUTO_CHOICE} from '../src/ui/automaticPanel';
import type {CfdSelection} from '../src/ui/cfdPanel';

const text=(files:Record<string,string|Uint8Array>,name:string)=>String(files[name]);
const calm=(extra:Partial<CfdCaseInput>={}):CfdCaseInput=>({caseId:'quick-box',trianglesMm:boxHull(200,60,40),sourceHash:'a'.repeat(64),protocolKey:'test',load:{massKg:.23952,draftM:.02,cgM:[.1,0,.02],cgMeasured:true},speedMps:.3,...extra});
const still=(extra:Partial<CfdCaseInput>={})=>calm({speedMps:0,maxCells:5_000_000,load:{massKg:.23952,draftM:.02,cgM:[.1,0,.015],cgMeasured:true},...extra});
const beam:WaveCaseSettings={kind:'beam-waves',heightM:.01,periodS:1,inertiaSource:'measured',inertiaMeasured:true,inertiaKgM2:[.0001,.0005,.00055]};

describe('Allrun streams live output and can run in parallel',()=>{
  it('tees every stage to its log file instead of printing it only after the stage ends',()=>{
    const run=text(generateOpenFoamCase(calm()).files,'Allrun');
    expect(run).toContain('| tee "log.$stage"');
    expect(run).toContain('stdbuf -oL -eL');
    expect(run).not.toMatch(/>"log\.\$stage" 2>&1; then cat/);
  });
  it('splits interFoam across HULL_NPROCS cores with MPI, defaulting to one core',()=>{
    const run=text(generateOpenFoamCase(calm()).files,'Allrun');
    expect(run).toContain('NPROCS="${HULL_NPROCS:-1}"');
    expect(run).toContain('method scotch;');
    expect(run).toContain('run_stage decomposePar -force');
    expect(run).toMatch(/mpirun --oversubscribe --bind-to none -np "\$NPROCS" .*interFoam -parallel 2>&1 \| tee log\.interFoam/);
    expect(run.indexOf('run_stage setFields')).toBeLessThan(run.indexOf('decomposePar'));
    expect(run).toContain('    run_stage interFoam\n');
    expect(run).not.toMatch(/\brm\s/);
  });
});

describe('Quick fidelity',()=>{
  it('leaves standard cases on the original numerics',()=>{
    const p=generateOpenFoamCase(calm());
    expect(p.manifest.mesh.fidelity).toBe('standard');
    expect(text(p.files,'system/fvSolution')).toContain('nOuterCorrectors 2; nCorrectors 2');
    expect(text(p.files,'system/controlDict')).toContain('maxAlphaCo 0.25;');
    expect(()=>generateOpenFoamCase(calm({maxCo:.8}))).toThrow(/0\.5/);
  });
  it('uses one outer corrector and a higher Courant limit for a quick calm tow',()=>{
    const p=generateOpenFoamCase(calm({fidelity:'quick',maxCo:.8}));
    expect(p.manifest.mesh.fidelity).toBe('quick');
    expect(text(p.files,'system/fvSolution')).toContain('nOuterCorrectors 1; nCorrectors 3');
    expect(text(p.files,'system/controlDict')).toMatch(/maxCo 0\.8;[\s\S]*maxAlphaCo 0\.5;/);
    expect(p.manifest.numerics.maxAlphaCo).toBe(.5);
    expect(p.manifest.notes.some(n=>n.startsWith('QUICK run'))).toBe(true);
    expect(()=>generateOpenFoamCase(calm({fidelity:'quick',maxCo:1.2}))).toThrow(/no larger than 1/);
  });
  it('quick waves use a lighter grid, 8 measured periods, and keep coupling-safe settings for a floating hull',()=>{
    const standard=extendCaseWithWaves(generateOpenFoamCase(still({durationS:1})),beam);
    const quick=extendCaseWithWaves(generateOpenFoamCase(still({durationS:1,fidelity:'quick',maxCo:.8,maxDeltaTS:.004,timeStepS:.001})),beam);
    const far=(m:typeof quick.manifest)=>m.mesh.baseCells.reduce((a,b)=>a*b,1);
    expect(far(quick.manifest)).toBeLessThan(far(standard.manifest));
    // Near the hull the background is graded to near-square cells (<= 4 x the band height), then refined at the hull
    // surface only, landing exactly on the hull target (the cause of the old checkMesh failures was flat-cell refinement).
    for(const p of [quick,standard]){
      const dz=.01/(p===quick?4:6),snappy=text(p.files,'system/snappyHexMeshDict'),m=p.manifest.mesh;
      expect(m.nearHullSpacingM!).toBeLessThanOrEqual(4*dz*1.000001);
      expect(snappy).toContain(`hull { level (${m.surfaceLevels[0]} ${m.surfaceLevels[0]});`);
      expect(snappy).toContain('hullWaterline { mode inside; levels ((1e15 0)); }');
      expect(snappy).not.toContain('levelIncrement');
      expect(m.nearHullSpacingM!/2**m.surfaceLevels[0]).toBeLessThanOrEqual(generateOpenFoamCase(still()).manifest.mesh.finestCellM*1.000001);
    }
    const warmup=quick.manifest.numerics.recommendedWarmupS;
    expect(quick.manifest.numerics.durationS).toBeCloseTo(warmup+8*1,9);
    expect(standard.manifest.numerics.durationS).toBeCloseTo(warmup+15*1,9);
    expect(quick.manifest.numerics.writeIntervalS).toBeCloseTo(quick.manifest.numerics.durationS/20,9);
    expect(quick.manifest.numerics.maxDeltaTS).toBeCloseTo(Math.min(.004,1/100),12);
    expect(extendCaseWithWaves(generateOpenFoamCase(still({durationS:1,fidelity:"quick",maxDeltaTS:.004,timeStepS:.001})),{...beam,heightM:.002,periodS:.3}).manifest.numerics.maxDeltaTS).toBeCloseTo(.3/100,12);
    // The base quick case asked for 0.8; a moving hull keeps it (cap 1) and the interface Courant cap stays 0.5.
    expect(quick.manifest.numerics.maxCo).toBe(.8);
    expect(text(quick.files,'system/controlDict')).toMatch(/maxCo 0\.8;[\s\S]*maxAlphaCo 0\.5;/);
    expect(text(quick.files,'system/fvSolution')).toContain('nOuterCorrectors 2; nCorrectors 2');
  });
});

describe('Test picker',()=>{
  const selected=():CfdSelection=>({id:1,name:'Hull',trianglesMm:boxHull(200,60,40),sizeMm:[200,60,40],massG:28,speedMps:.3,cgM:[0,0,0]});
  it('defaults to one quick calm test, not all nine',()=>{
    expect(DEFAULT_AUTO_CHOICE).toEqual({speed:'quick',cores:null,conditions:['250g-calm']});
    expect(plannedSolves(DEFAULT_AUTO_CHOICE)).toBe(1);
    expect(plannedSolves({speed:'full',cores:null,conditions:AUTO_CONDITION_IDS})).toBe(21);
    expect(AUTO_CONDITION_IDS).toHaveLength(9);expect(AUTO_CONDITION_IDS.some(id=>id.endsWith('-low'))).toBe(false);
  });
  it('drops unknown or duplicate tests and keeps protocol order',()=>{
    expect(normaliseChoice({speed:'full',cores:3,conditions:['350g-high','bogus','150g-calm','150g-calm']})).toEqual({speed:'full',cores:3,conditions:['150g-calm','350g-high']});
    expect(normaliseChoice({speed:'turbo',cores:-2})).toEqual({speed:'quick',cores:null,conditions:['250g-calm']});
  });
  it('sends the chosen tests, speed and cores with the CAD',()=>{
    const request=buildAutomaticStudyRequest(selected(),{speed:'quick',cores:4,conditions:['150g-calm','250g-high']});
    expect(request).toMatchObject({conditionIds:['150g-calm','250g-high'],speed:'quick',cores:4});
    expect(()=>buildAutomaticStudyRequest(selected(),{speed:'quick',cores:null,conditions:[]})).toThrow(/at least one/);
    expect(buildAutomaticStudyRequest(selected(),{speed:'full',cores:null,conditions:['150g-calm']})).not.toHaveProperty('cores');
  });
  it('formats time-left estimates',()=>{
    expect(formatDuration(null)).toBe('—');expect(formatDuration(42.4)).toBe('42 s');
    expect(formatDuration(600)).toBe('10 min');expect(formatDuration(3*3600+20*60)).toBe('3 h 20 min');expect(formatDuration(7200)).toBe('2 h');
  });
});

describe('Queue and comparison helpers',()=>{
  it('builds one comparison sheet across hulls with achieved-wave and failure columns',async()=>{
    const {allStudiesSheet}=await import('../src/ui/automaticPanel');
    const sheet=allStudiesSheet([
      {id:'a',name:'Entry A',createdAt:'2026-11-16T10:00:00Z',options:{speed:'full'},conditions:[{id:'250g-calm',label:'250 g · Calm water',mode:'calm',massKg:.25,status:'completed',result:{numericalSensitivityPassed:true,metrics:{meanDragN:.0549,initialBuoyancyN:2.45}}}]},
      {id:'b',name:'Entry B',createdAt:'2026-11-16T11:00:00Z',options:{speed:'quick'},conditions:[
        {id:'250g-high',label:'250 g · High beam waves',mode:'beam-waves',massKg:.25,waveHeightM:.012,wavePeriodS:.6,status:'completed',result:{quick:true,metrics:{rollRmsDeg:3.2,waveHeightRatio:.93}}},
        {id:'350g-calm',label:'350 g · Calm water',mode:'calm',massKg:.35,status:'blocked',error:'This load reaches or exceeds the hull envelope displacement.',hint:{title:'Hull cannot float this load'}}]},
    ]);
    expect(sheet.name).toBe('All hulls');expect(sheet.rows).toHaveLength(4);
    const [head,a,bWave,bBlocked]=sheet.rows;
    expect(a[0]).toBe('Entry A');expect(a[9]).toBe(.0549);expect(a[a.length-3]).toBe('Sensitivity checks passed');
    expect(bWave[2]).toBe('Quick');expect(bWave[9]).toBeNull();expect(bWave[10]).toBe(3.2);expect(bWave[head.indexOf('Achieved wave height (% of target)')]).toBeCloseTo(93,9);
    expect(String(bBlocked[head.indexOf('Issue')])).toMatch(/^Hull cannot float this load: This load reaches/);
  });
  it('formats finish times as a clock time, with the weekday when not today',async()=>{
    const {clockTime}=await import('../src/ui/automaticPanel');
    const now=new Date('2026-11-16T12:00:00');
    expect(clockTime(new Date('2026-11-16T15:30:00').toISOString(),now)).toMatch(/15[:.]30|3[:.]30/);
    expect(clockTime(new Date('2026-11-17T09:05:00').toISOString(),now)).toMatch(/^\S+ .*(09|9)[:.]05/);
    expect(clockTime(null,now)).toBe('');expect(clockTime('nonsense',now)).toBe('');
  });
});

describe('Deep-water wave absorption',()=>{
  const still=()=>({caseId:'sponge-box',trianglesMm:boxHull(200,60,40),sourceHash:'a'.repeat(64),protocolKey:'test',load:{massKg:.23952,draftM:.02,cgM:[.1,0,.015] as [number,number,number],cgMeasured:true},speedMps:0,maxCells:5_000_000,durationS:1});
  const beam:WaveCaseSettings={kind:'beam-waves',heightM:.01,periodS:1,inertiaSource:'measured',inertiaMeasured:true,inertiaKgM2:[.0001,.0005,.00055]};
  it('generates waves in a relaxation zone and absorbs them in a sponge, with no boundary wave-maker',()=>{
    const base=generateOpenFoamCase(still()),p=extendCaseWithWaves(base,beam),wl=p.manifest.waves.waveLengthM;
    expect(p.files['constant/waveProperties']).toBeUndefined();
    expect(text(p.files,'0/U')).not.toMatch(/waveVelocity|waveAlpha/);
    expect(text(p.files,'0/U')).toMatch(/starboard\s*\{\s*type slip;/);expect(text(p.files,'0/U')).toMatch(/port\s*\{\s*type slip;/);
    const fv=text(p.files,'system/fvOptions');
    expect(fv).toMatch(/sponge\s*\{\s*type acousticDampingSource;[\s\S]*URef UZero;/);
    expect(fv).toMatch(/wavemaker\s*\{\s*type acousticDampingSource;[\s\S]*URef UWave;/);
    const ctrl=text(p.files,'system/controlDict');
    expect(ctrl).toMatch(/fields \(UZero UWave\);/);expect(ctrl).toMatch(/type exprField;[\s\S]*field UWave;[\s\S]*action modify;/);
    expect(ctrl).toMatch(/DebugSwitches\s*\{\s*dimensionSet 0;/);
    expect(p.manifest.waves.generation?.method).toBe('relaxation-zone');
    // Tank extended by the generation zone up-wave and the sponge down-wave.
    expect(p.manifest.domain.maxM[1]-p.manifest.waves.sponge!.minM[1]).toBeCloseTo(1.5*wl,6);
    expect(p.manifest.waves.generation!.lengthM).toBeCloseTo(wl,9);
  });
  it('keeps the mesher inside point within the smaller wave tank and outside the hull',()=>{
    const p=extendCaseWithWaves(generateOpenFoamCase(still()),beam);
    const loc=/locationInMesh \(([^)]*)\);/.exec(text(p.files,'system/snappyHexMeshDict'))![1].split(' ').map(Number);
    const {minM,maxM}=p.manifest.domain,g=p.manifest.geometry;
    for(let i=0;i<3;i++){expect(loc[i]).toBeGreaterThan(minM[i]);expect(loc[i]).toBeLessThan(maxM[i]);}
    expect(loc[1]<g.minM[1]||loc[1]>g.maxM[1]).toBe(true);expect(loc[2]).toBeLessThan(0);
  });
  it('fills the whole extended tank with water (a dry sponge region would collapse like a dam break)',()=>{
    const p=extendCaseWithWaves(generateOpenFoamCase(still()),beam);
    const box=/box \(([^)]*)\) \(([^)]*)\);/.exec(text(p.files,'system/setFieldsDict'))!;
    const lo=box[1].split(' ').map(Number),hi=box[2].split(' ').map(Number);
    expect(hi[1]).toBeGreaterThanOrEqual(p.manifest.domain.maxM[1]);expect(lo[1]).toBeLessThanOrEqual(p.manifest.domain.minM[1]);expect(hi[2]).toBe(0);
  });
});

describe('Competition load rule',()=>{
  it('puts half of every test mass as ballast low on the centreline, identical rule for every hull',async()=>{
    const {createAutomaticPlan,standardBallast}=await import('../src/cfd/automatic');
    const {prepareCfdHull}=await import('../src/cfd/geometry');
    const tris=boxHull(200,60,40),plan=createAutomaticPlan({trianglesMm:tris}),hull=prepareCfdHull(new Float32Array(tris),'closed-envelope');
    for(const c of plan.conditions){
      const [b]=c.request.cgEstimate.payloads;
      expect(b.massKg).toBeCloseTo(c.massKg/2,12);
      expect(b.positionM[0]).toBeCloseTo(hull.centroidM[0],9);expect(b.positionM[1]).toBe(0);
      // 10% of the 40 mm depth above the flat bottom.
      expect(b.positionM[2]-hull.bounds.minM[2]).toBeCloseTo(.004,6);
    }
    expect(standardBallast(hull,.35).massKg).toBeCloseTo(.175,12);
  });
});

describe('review label',()=>{
  it('names the failed check instead of a bare "Review needed"',()=>{
    expect(reviewText({quick:true})).toBe('Quick result (rough)');
    expect(reviewText({numericalSensitivityPassed:true})).toBe('Sensitivity checks passed');
    expect(reviewText({numericalSensitivityPassed:false,checks:[{name:'Completed numerical quality',passed:true},{name:'Mesh sensitivity',passed:false,relativeChange:.327,threshold:.05}]})).toBe('Mesh sensitivity 33% (limit 5%)');
    expect(reviewText({numericalSensitivityPassed:false,checks:[{name:'Completed numerical quality',passed:false}]})).toBe('Check failed: Completed numerical quality');
  });
});
