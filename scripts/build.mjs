// Bundles the app into dist/: index.html + styles.css + app.js, plus a single-file
// hull-test-bench.html that works when opened straight from disk.
import { build, context } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";

const serve = process.argv.includes("--serve");
const options = { entryPoints: ["src/ui/main.ts"], bundle: true, format: "iife", target: "es2020", outfile: "dist/app.js", minify: !serve, sourcemap: serve, legalComments: "none", logLevel: "info" };

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  if (existsSync("public")) cpSync("public", "dist", {recursive:true});
  const html = readFileSync("index.html", "utf8"), css = readFileSync("styles.css", "utf8") + "\n" + readFileSync("styles-cfd.css", "utf8") + "\n" + readFileSync("styles-automatic.css", "utf8");
  writeFileSync("dist/index.html", html);
  writeFileSync("dist/styles.css", css);
  return { html, css };
}

if (serve) {
  copyStatic();
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 5173 });
  console.log(`Hull Test Bench running at http://localhost:${port}`);
} else {
  const { html, css } = copyStatic();
  await build(options);
  const js = readFileSync("dist/app.js", "utf8").replace(/<\/script/g, "<\\/script");
  const single = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`).replace('<script src="app.js"></script>', () => `<script>\n${js}\n</script>`);
  writeFileSync("dist/hull-test-bench.html", single);
  console.log("Built dist/index.html, dist/app.js, dist/styles.css and dist/hull-test-bench.html");
}
