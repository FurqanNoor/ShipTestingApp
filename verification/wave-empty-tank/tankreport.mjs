// tankreport.mjs <root> <tankdir...> — achieved wave vs target using the app's own gauge analysis and averaging window
import {readFileSync,existsSync} from 'node:fs';import {resolve} from 'node:path';
const [,,root,...dirs]=process.argv;
const {analyseWaveGauges}=await import(resolve(root,'server/result-reader.mjs'));
for(const d of dirs){
  const m=JSON.parse(readFileSync(d+'/manifest.json','utf8')),T=m.condition.periodS,H=m.condition.heightM,end=m.numerics.durationS;
  const start=Math.max(end*.5,5*T,m.numerics.recommendedWarmupS);
  const f=d+'/postProcessing/waveGauges/0/position.dat';if(!existsSync(f)){console.log(d,'no gauges');continue;}
  const text=readFileSync(f,'utf8'),last=Number(text.trim().split('\n').at(-1).trim().split(/\s+/)[0]);
  const w=analyseWaveGauges(text,{startS:start,endS:Math.min(end,last),targetHeightM:H,targetPeriodS:T});
  console.log(`${d.split('/').at(-1)}: t=${last.toFixed(2)}/${end.toFixed(1)}s window ${start.toFixed(2)}-${Math.min(end,last).toFixed(2)} | target H ${(H*1000).toFixed(2)} mm T ${T.toFixed(3)} s | gauges H ${w?.gauges.map(g=>g.heightM===null?'-':(g.heightM*1000).toFixed(2)).join(', ')} mm T ${w?.gauges.map(g=>g.periodS?.toFixed(3)??'-').join(', ')} | H ${(100*(w?.heightRatio??NaN)).toFixed(0)}% T ${(100*(w?.periodRatio??NaN)).toFixed(1)}% ok=${w?.withinTolerance}`);
}
