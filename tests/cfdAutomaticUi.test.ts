import {describe,it,expect} from 'vitest';
import {unzipSync,strFromU8} from 'fflate';
import {buildAutomaticStudyRequest,automaticStudySheets} from '../src/ui/automaticPanel';
import type {CfdSelection} from '../src/ui/cfdPanel';
import {boxHull} from '../src/engine/example';
import {buildXlsx} from '../src/xlsx';

const selected=():CfdSelection=>({id:3,name:'Own hull',trianglesMm:boxHull(200,60,40),sizeMm:[200,60,40],massG:28,speedMps:.005,cgM:[0,0,0]});
describe('One-click automatic CFD UI contract',()=>{
  it('sends CAD only, leaving the common loads and protocol to the server',()=>{
    const selection=selected(),request=buildAutomaticStudyRequest(selection);
    expect(Object.keys(request).sort()).toEqual(['name','trianglesMm']);
    expect(request.trianglesMm).toEqual(Array.from(selection.trianglesMm));
    selection.trianglesMm[0]=99;expect(request.trianglesMm[0]).not.toBe(99);
    expect(request).not.toHaveProperty('measurementsConfirmed');expect(request).not.toHaveProperty('massKg');
  });
  it('rejects invalid or oversized CAD before queuing solver work',()=>{
    expect(()=>buildAutomaticStudyRequest({...selected(),sizeMm:[251,60,40]})).toThrow(/250/);
    expect(()=>buildAutomaticStudyRequest({...selected(),trianglesMm:new Float32Array([1,2,3])})).toThrow(/complete triangular/);
    const t=boxHull(200,60,40);t[3]=NaN;expect(()=>buildAutomaticStudyRequest({...selected(),trianglesMm:t})).toThrow(/invalid coordinates/);
  });
  it('exports partial results with missing outputs left blank rather than fabricated zeroes',()=>{
    const sh=automaticStudySheets({id:'one',status:'running',plan:{protocol:'standard-220-v1'},conditions:[{label:'150 g · calm',massKg:.15,mode:'calm',status:'running',runs:[]}]});
    const row=sh[0].rows[1];expect(row[1]).toBe(150);expect(row[6]).toBe('Not established');expect(row.slice(7,13)).toEqual([null,null,null,null,null,null]);
  });
  it('does not present mean wave force as towing resistance or turn a sensitivity pass into physical validation',()=>{
    const sh=automaticStudySheets({id:'two',plan:{assumptions:['Uniform printed material.']},conditions:[{label:'250 g · medium waves',massKg:.25,mode:'beam-waves',status:'completed',result:{numericalSensitivityPassed:true,metrics:{meanDragN:.3,rollRmsDeg:2.5,initialGmM:.012,initialBuoyancyN:2.45}},runs:[]}]});
    expect(sh[0].rows[1][7]).toBeNull();expect(sh[0].rows[1][8]).toBe(2.5);expect(sh[0].rows[1][11]).toBe(12);
    expect(sh[2].rows).toContainEqual(['Physical validation','Not performed; numerical agreement is not an accuracy certificate']);
    expect(sh[2].rows).toContainEqual(['Mass source','Standard test loads, not measured ship weights']);
  });
  it('preserves full inertia/load provenance and comparison failures in a downloadable workbook',()=>{
    const sh=automaticStudySheets({id:'three',plan:{assumptions:['No unseen equipment.']},conditions:[{label:'350 g · low waves',status:'completed',result:{checks:[{name:'Domain sensitivity',passed:false,relativeChange:.07,threshold:.03,reason:'Boundary effect remains.'}]},runs:[{phase:'fine',jobId:'job-1',status:'completed',result:{manifest:{load:{cgSource:'cad-estimate',cgMeasured:false},motion:{inertiaSource:'cad-estimate',inertiaMeasured:false}},quality:{rankable:false}}}]}]});
    expect(sh[1].rows[1]).toEqual(['350 g · low waves','Domain sensitivity','No',.07,.03,'Boundary effect remains.']);
    const files=unzipSync(buildXlsx(sh)),metadata=strFromU8(files['xl/worksheets/sheet4.xml']);
    expect(metadata).toContain('cad-estimate');expect(metadata).toContain('cgMeasured');expect(metadata).toContain('inertiaMeasured');expect(metadata).toContain('false');
  });
});
