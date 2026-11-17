import {describe,it,expect} from 'vitest';
import {rankModels,type ModelResult,type WeightResult} from '../src/engine/analyze';
import {holtrop,type HullForm} from '../src/engine/drag';
function model():ModelResult {
  const w={floats:true,stable:true,calm:{total:.01},waves:[{dragN:.011,maxRollDeg:5,capsized:false}]} as WeightResult;
  return {withinLimit:true,maxLoadG:500,weights:[structuredClone(w),structuredClone(w),structuredClone(w)]} as ModelResult;
}
describe('Preview comparison safeguards',()=>{
  it('excludes an oversized hull from placements without removing its diagnostic row',()=>{const good=model(),bad=model();bad.withinLimit=false;bad.maxLoadG=9999;const rows=rankModels([{name:'good',result:good},{name:'oversize',result:bad}]);expect(rows.find(r=>r.name==='oversize')?.place).toBe(0);expect(rows.find(r=>r.name==='good')?.place).toBe(1);});
  it('applies the documented load penalty when a statically stable case capsizes in waves',()=>{const m=model();m.weights[0].waves[0].capsized=true;const r=rankModels([{name:'capsize',result:m}])[0];expect(r.total).toBeCloseTo(200/3,10);expect(r.failures).toBe(1);});
  it('does not let nonfinite force poison other candidate scores',()=>{const bad=model();bad.weights.forEach(w=>w.calm.total=NaN);const rows=rankModels([{name:'bad',result:bad},{name:'good',result:model()}]);expect(rows.every(r=>Number.isFinite(r.total))).toBe(true);expect(rows[0].name).toBe('good');expect(rows[0].total).toBeCloseTo(100,10);});
  it('handles zero-drag input without a division-by-zero placement',()=>{const m=model();m.weights.forEach(w=>{w.calm.total=0;w.waves.forEach(v=>v.dragN=0);});const r=rankModels([{name:'zero',result:m}])[0];expect(r.total).toBe(0);expect(r.place).toBe(0);});
});
describe('Published LCB percentage regression',()=>{
  const f:HullForm={LWL:180,BWL:28,T:8,V:.65*180*28*8,S:5800,Cb:.65,Cm:.98,Cp:.8,Cwp:.8,lcbPct:5,iE:18,At:4};
  it('retains percent units at positive LCB',()=>{expect(holtrop(f,.25*Math.sqrt(9.81*180),1025,1.1883e-6,9.81).formFactor).toBeCloseTo(1.278245674,8);});
  it('retains percent units at negative LCB',()=>{expect(holtrop({...f,lcbPct:-5},.25*Math.sqrt(9.81*180),1025,1.1883e-6,9.81).formFactor).toBeCloseTo(1.334104700,8);});
});
