import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `pnpm demo` builds into its own folder against its own desk and oracle.
const demoFile = process.env.COINFLIP_DEMO?.trim();
const demo = demoFile ? JSON.parse(readFileSync(demoFile, "utf8")) : null;
const dist = process.env.OUT_DIR?.trim() ? path.resolve(process.env.OUT_DIR.trim()) : path.join(root, "dist");

await esbuild.build({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "app.js"),
  platform: "browser",
  target: "es2022",
  alias: { "node:crypto": path.join(root, "app/src/browser-crypto.ts") },
  sourcemap: true,
  logLevel: "info",
  define: { __COINFLIP_DEMO__: JSON.stringify(demo) },
});

mkdirSync(path.join(dist, "viz"), { recursive: true });
const hash = createHash("sha256").update(readFileSync(path.join(dist, "app.js"))).digest("hex").slice(0, 10);
const cssHash = createHash("sha256").update(readFileSync(path.join(root, "app/desk.css"))).digest("hex").slice(0, 10);
const html = readFileSync(path.join(root, "app/index.html"), "utf8")
  .replace('src="./app.js"', `src="./app.js?${hash}"`)
  .replace('href="desk.css"', `href="desk.css?${cssHash}"`);
writeFileSync(path.join(dist, "index.html"), html);
cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
cpSync(path.join(root, "viz/index.html"), path.join(dist, "viz/index.html"));
cpSync(path.join(root, "app/settle-math.js"), path.join(dist, "viz/settle-math.js"));
writeFileSync(path.join(dist, ".nojekyll"), "");
if (!demo) writeFileSync(path.join(dist, "CNAME"), "arkade.trade\n");
