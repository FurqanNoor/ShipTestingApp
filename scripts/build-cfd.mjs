import {build} from 'esbuild';
await build({entryPoints:['scripts/cfd-core.ts'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'server/generated/core.mjs',logLevel:'info'});
