import {describe,expect,it} from "vitest";
import {buildCfdRequest,cfdCgSheet,type CfdFormInput,type CfdSelection} from "../src/ui/cfdPanel";
import {buildXlsx} from '../src/xlsx';
import {unzipSync,strFromU8} from 'fflate';
import {boxHull} from "../src/engine/example";
import {place,IDENTITY} from "../src/engine/orient";
const selection=():CfdSelection=>({id:1,name:"Measured test hull",trianglesMm:place(boxHull(200,60,40),IDENTITY).tris,sizeMm:[200,60,40],massG:240,speedMps:.4});
const form=():CfdFormInput=>({mode:"calm",geometryMode:"closed-envelope",massG:240,cgMm:[100,0,15],measuredMassCg:true,inertiaMeasured:false,speedMps:.4,waveHeightMm:4,wavePeriodS:.45,mesh:"coarse",timeStepS:.0005,durationS:10});
describe("CFD measured-input UI contract",()=>{
  it("converts measured grams and millimetres into explicit SI values",()=>{const r=buildCfdRequest(selection(),form());expect(r.massKg).toBe(.24);expect(r.cgM).toEqual([.1,0,.015]);expect(r).not.toHaveProperty("inertiaKgM2");expect(r).not.toHaveProperty("waveHeightM");expect(r.trianglesMm).toEqual(Array.from(selection().trianglesMm));});
  it("requires measured mass and CG confirmation",()=>expect(()=>buildCfdRequest(selection(),{...form(),measuredMassCg:false})).toThrow(/measured/));
  it("never infers a missing vertical CG",()=>expect(()=>buildCfdRequest(selection(),{...form(),cgMm:[100,0,NaN]})).toThrow(/centre of gravity/));
  it("rejects an oversized physical design",()=>expect(()=>buildCfdRequest({...selection(),sizeMm:[260,60,40]},form())).toThrow(/250/));
  it("requires actual inertia before enabling a free-roll test",()=>expect(()=>buildCfdRequest(selection(),{...form(),mode:"beam-waves"})).toThrow(/inertia/));
  it("free-roll request has zero tow speed and preserves measured inertia",()=>{const r=buildCfdRequest(selection(),{...form(),mode:"beam-waves",inertiaMeasured:true,inertiaKgM2:[.0001,.0002,.00025]});expect(r.speedMps).toBe(0);expect(r.inertiaKgM2).toEqual([.0001,.0002,.00025]);expect(r.waveHeightM).toBe(.004);});
  it("rejects physically impossible principal inertia values",()=>expect(()=>buildCfdRequest(selection(),{...form(),mode:"beam-waves",inertiaMeasured:true,inertiaKgM2:[1,1,8]})).toThrow(/triangle/));
  it("requires wall thickness for a printed material CFD mesh",()=>expect(()=>buildCfdRequest(selection(),{...form(),geometryMode:"printed-shell"})).toThrow(/thickness/));
  it("preserves thin-wall geometry and converts minimum wall thickness",()=>{const r=buildCfdRequest(selection(),{...form(),geometryMode:"printed-shell",minimumWallThicknessMm:2});expect(r.minimumWallThicknessM).toBe(.002);});
  it("rejects invalid integration settings before creating a job",()=>{expect(()=>buildCfdRequest(selection(),{...form(),timeStepS:NaN})).toThrow(/time step/);expect(()=>buildCfdRequest(selection(),{...form(),durationS:-1})).toThrow(/duration/);});
  it("requires positive regular-wave inputs in wave mode",()=>expect(()=>buildCfdRequest(selection(),{...form(),mode:"head-waves",speedMps:0,wavePeriodS:0})).toThrow(/period/));
  it("withholds unsupported head-wave towing instead of silently dropping current",()=>expect(()=>buildCfdRequest(selection(),{...form(),mode:"head-waves",speedMps:.4})).toThrow(/zero tow speed/));
  it("can request regular head-wave forces on a stationary fixed hull",()=>{const r=buildCfdRequest(selection(),{...form(),mode:"head-waves",speedMps:0});expect(r.speedMps).toBe(0);expect(r.waveHeightM).toBe(.004);expect(r.measurementsConfirmed).toBe(true);});
  it("retains a literal design name without deriving commands from it",()=>expect(buildCfdRequest({...selection(),name:'$(bad); =1+1'},form()).name).toBe('$(bad); =1+1'));
});

const automatic=():CfdFormInput=>({...form(),cgSource:'cad-estimate',cgDistribution:'solid',cgAssumptionsConfirmed:true,cgMm:[NaN,NaN,NaN]});
describe('CAD CG input and export contract',()=>{
  it('fills CG from the CAD without requiring typed or rounded preview coordinates',()=>{
    const r=buildCfdRequest(selection(),automatic());
    expect(r.cgM[0]).toBeCloseTo(.1,12);expect(r.cgM[1]).toBeCloseTo(0,12);expect(r.cgM[2]).toBeCloseTo(.02,12);
    expect(r.cgSource).toBe('cad-estimate');expect(r.assumptionsConfirmed).toBe(true);expect(r.cgEstimate).toEqual({distribution:'solid',payloads:[]});
  });
  it('weights cargo with the remaining hull mass rather than adding it twice',()=>{
    const r=buildCfdRequest(selection(),{...automatic(),massG:300,cgPayloads:[{name:'Cargo',massG:100,positionMm:[160,12,80]}]});
    [.12,.004,.04].forEach((v,i)=>expect(r.cgM[i]).toBeCloseTo(v,12));
    expect(r.massKg).toBe(.3);expect(r.cgEstimate?.payloads[0]).toEqual({name:'Cargo',massKg:.1,positionM:[.16,.012,.08]});
  });
  it('ignores blank zero-mass cargo rows but rejects unspecified positions for positive mass',()=>{
    expect(buildCfdRequest(selection(),{...automatic(),cgPayloads:[{name:'Cargo',massG:0,positionMm:[NaN,NaN,NaN]}]}).cgEstimate?.payloads).toEqual([]);
    expect(()=>buildCfdRequest(selection(),{...automatic(),cgPayloads:[{name:'Cargo',massG:20,positionMm:[NaN,0,20]}]})).toThrow(/position/);
  });
  it('requires acknowledgement of both total mass and CAD distribution assumptions',()=>{
    expect(()=>buildCfdRequest(selection(),{...automatic(),measuredMassCg:false})).toThrow(/loaded mass/);
    expect(()=>buildCfdRequest(selection(),{...automatic(),cgAssumptionsConfirmed:false})).toThrow(/assumptions/);
  });
  it('rejects added masses that leave no physical hull mass',()=>{
    expect(()=>buildCfdRequest(selection(),{...automatic(),cgPayloads:[{name:'Ballast',massG:240,positionMm:[100,0,0]}]})).toThrow(/some mass must remain/);
  });
  it('uses an open physical skin without attributing mass to the buoyancy cap',()=>{
    const t=boxHull(200,60,40),open=new Float32Array([...t.slice(0,18),...t.slice(36)]);
    const r=buildCfdRequest({...selection(),trianglesMm:open},{...automatic(),geometryMode:'open-surface',cgDistribution:undefined});
    const sideArea=2*(.2+.06)*.04;expect(r.cgM[2]).toBeCloseTo(sideArea*.02/(.2*.06+sideArea),12);expect(r.cgEstimate?.distribution).toBe('shell');
    expect(()=>buildCfdRequest({...selection(),trianglesMm:open},{...automatic(),geometryMode:'open-surface'})).toThrow(/virtual cap/);
  });
  it('manual measurement mode never silently falls back to estimated CG or retains CAD assumptions',()=>{
    expect(()=>buildCfdRequest(selection(),{...automatic(),cgSource:'measured'})).toThrow(/measured/);
    const r=buildCfdRequest(selection(),{...automatic(),cgSource:'measured',cgMm:[100,0,15]});
    expect(r.cgSource).toBe('measured');expect(r.cgM).toEqual([.1,0,.015]);expect(r).not.toHaveProperty('cgEstimate');expect(r).not.toHaveProperty('assumptionsConfirmed');
  });
  it('requests explicit CAD inertia without calling it measured',()=>{
    const r=buildCfdRequest(selection(),{...automatic(),mode:'beam-waves'});
    expect(r.inertiaSource).toBe('cad-estimate');expect(r.inertiaMeasured).toBe(false);expect(r).not.toHaveProperty('inertiaKgM2');
  });
  it('exports CAD assumptions, point positions and CG without calling them measured',()=>{
    const req={cgSource:'cad-estimate',massKg:.3,cgM:[.12,.004,.04],assumptionsConfirmed:true,cgEstimate:{distribution:'solid',payloads:[{name:'Cargo',massKg:.1,positionM:[.16,.012,.08]}]}};
    const sh=cfdCgSheet(req,{cgSource:'cad-estimate',cgMeasured:false,massKg:.3,cgM:req.cgM,cgAssumptions:['Uniform density.']});
    expect(sh.rows).toContainEqual(['CG source','CAD estimate · not measured']);expect(sh.rows).toContainEqual(['Cargo',.1,.16,.012,.08]);expect(sh.rows).toContainEqual(['CG assumption','Uniform density.']);
    const files=unzipSync(buildXlsx([sh]));expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('CAD estimate · not measured');
  });
  it('preserves measured provenance and does not invent a source for historical unknown records',()=>{
    expect(cfdCgSheet({},{cgMeasured:true,cgM:[.1,0,.015]}).rows).toContainEqual(['CG source','Measured CG']);
    expect(cfdCgSheet({},{}).rows).toContainEqual(['CG source','CG source not recorded']);
  });
});
