import {describe,it,expect} from 'vitest';
import {SIZE_LIMIT_MM,SCALE,withinSizeLimit} from '../src/engine/conditions';
import {analyzeModel} from '../src/engine/analyze';
import {defaultConditions} from '../src/engine/conditions';
import {exampleHull} from '../src/engine/example';

describe('Competition size limit',()=>{
  it('accepts entries up to 250 x 250 x 250 mm and rejects anything larger in any direction',()=>{
    expect(SIZE_LIMIT_MM).toBe(250);
    expect(withinSizeLimit([250,250,250])).toBe(true);
    expect(withinSizeLimit([240,90,60])).toBe(true);
    expect(withinSizeLimit([251,90,60])).toBe(false);
    expect(withinSizeLimit([220,90,260])).toBe(false);
  });
  it('keeps the preview Froude scale of the 220 mm reference model',()=>{expect(SCALE).toBeCloseTo(120/.22,6);});
  it('treats a 245 mm hull as within the limit in the preview analysis',async()=>{
    const r=await analyzeModel(exampleHull(245,45,20),defaultConditions());
    expect(r.withinLimit).toBe(true);expect(r.notes.join(' ')).not.toMatch(/Larger than/);
  });
});
