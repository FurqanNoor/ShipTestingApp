import {describe,it,expect} from 'vitest';
import {cfdLeaderboard,PROTOCOL_VERSION} from '../src/cfd/leaderboard';

const opts={speed:'quick',backend:'cluster',cores:64,protocolVersion:PROTOCOL_VERSION};
const calm=(g:number,dragN:number,gm=.02)=>({id:`${g}g-calm`,mode:'calm',status:'completed',result:{metrics:{meanDragN:dragN,initialGmM:gm}}});
const wave=(g:number,roll:number,gm=.02)=>({id:`${g}g-high`,mode:'beam-waves',status:'completed',result:{metrics:{maxRollDeg:roll,initialGmM:gm}}});
const study=(name:string,conditions:unknown[],options:Record<string,unknown>=opts,createdAt='2026-11-18T01:00:00Z')=>({id:name+createdAt,name,createdAt,options,conditions});
const full=(name:string,drag:number,roll:number,gm=.02)=>study(name,[calm(150,drag,gm),calm(250,drag,gm),wave(150,roll,gm),wave(250,roll,gm)]);

describe('CFD hackathon leaderboard',()=>{
  it('scores drag, roll and stability against the best hull and averages them',()=>{
    const {rows}=cfdLeaderboard([full('A',.010,5,.02),full('B',.020,2.5,.04)]);
    const a=rows.find(r=>r.name==='A')!,b=rows.find(r=>r.name==='B')!;
    expect(a.scoreDrag).toBeCloseTo(100);expect(b.scoreDrag).toBeCloseTo(50);
    expect(a.scoreRoll).toBeCloseTo(50);expect(b.scoreRoll).toBeCloseTo(100);
    expect(a.scoreStability).toBeCloseTo(50);expect(b.scoreStability).toBeCloseTo(100);
    expect(b.place).toBe(1);expect(a.place).toBe(2);expect(b.total).toBeCloseTo(250/3);
    expect(a.dragMN).toBeCloseTo(10);expect(a.gmMm).toBeCloseTo(20);
  });
  it('ranks a hull that sinks or capsizes below every hull without failures',()=>{
    const sinker=study('Fast but sinks',[calm(150,.001),{...calm(250,0),status:'failed',result:null,hint:{verdict:'sinks'}},wave(150,1),{...wave(250,0),status:'failed',result:null,hint:{verdict:'stability-failure'}}]);
    const {rows}=cfdLeaderboard([sinker,full('Steady',.02,8)]);
    expect(rows[0].name).toBe('Steady');expect(rows[1].failures).toBe(2);expect(rows[1].status).toBe('ranked');expect(rows[1].place).toBe(2);
  });
  it('does not rank hulls tested with different settings or an older solver setup',()=>{
    const other=study('Local run',full('x',.01,1).conditions,{...opts,backend:'local',cores:8});
    const old=study('Old setup',full('x',.01,1).conditions,{speed:'quick',backend:'cluster',cores:64});
    const {rows,reference}=cfdLeaderboard([full('A',.01,5),full('B',.02,3),other,old]);
    expect(reference?.backend).toBe('cluster');
    expect(rows.find(r=>r.name==='Local run')!.status).toBe('different-settings');
    expect(rows.find(r=>r.name==='Old setup')!.status).toBe('different-settings');
    expect(rows.filter(r=>r.status==='ranked').map(r=>r.name).sort()).toEqual(['A','B']);
  });
  it('needs every test of the common programme, and asks for re-runs of numerical failures',()=>{
    const partial=study('Partial',[calm(150,.01),calm(250,.01)]);
    const crashed=study('Crashed',[calm(150,.01),calm(250,.01),wave(150,2),{...wave(250,2),status:'failed',result:null,hint:{title:'Solver diverged'}}]);
    const {rows}=cfdLeaderboard([full('A',.01,5),full('B',.02,3),partial,crashed]);
    expect(rows.find(r=>r.name==='Partial')!.status).toBe('incomplete');
    const c=rows.find(r=>r.name==='Crashed')!;expect(c.status).toBe('incomplete');expect(c.note).toMatch(/Re-run needed: 250g-high failed/);
  });
  it('merges a re-run study with the original study of the same hull',()=>{
    const first=study('Fixed',[calm(150,.01),calm(250,.01),wave(150,2),{...wave(250,2),status:'failed',result:null}],opts,'2026-11-18T01:00:00Z');
    const rerun=study('Fixed',[wave(250,3)],opts,'2026-11-18T03:00:00Z');
    const {rows}=cfdLeaderboard([full('A',.01,5),first,rerun]);
    const f=rows.find(r=>r.name==='Fixed')!;expect(f.status).toBe('ranked');expect(f.rollDeg).toBeCloseTo(2.5);
  });
});
