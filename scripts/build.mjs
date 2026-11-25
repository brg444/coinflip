import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `pnpm demo` builds into its own folder against its own desk and oracle.
const demoFile = process.env.COINFLIP_DEMO?.trim();
const demo = demoFile ? JSON.parse(readFileSync(demoFile, "utf8")) : null;
const networkName = (demo?.network || process.env.NETWORK || "mutinynet").trim().toLowerCase();
const isMainnet = networkName === "bitcoin" || networkName === "mainnet";
const dist = process.env.OUT_DIR?.trim() ? path.resolve(process.env.OUT_DIR.trim()) : path.join(root, "dist");

await esbuild.build({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "app.js"),
  platform: "browser",
  target: "es2022",
  alias: { "node:crypto": path.join(root, "app/src/browser-crypto.ts") },
  minify: true,
  sourcemap: true,
  logLevel: "info",
  define: {
    __COINFLIP_DEMO__: JSON.stringify(demo),
    __COINFLIP_NETWORK__: JSON.stringify(isMainnet ? "bitcoin" : networkName),
  },
});

mkdirSync(dist, { recursive: true });
const hash = createHash("sha256").update(readFileSync(path.join(dist, "app.js"))).digest("hex").slice(0, 10);
const cssHash = createHash("sha256").update(readFileSync(path.join(root, "app/desk.css"))).digest("hex").slice(0, 10);
let html = readFileSync(path.join(root, "app/index.html"), "utf8")
  .replace('src="./app.js"', `src="./app.js?${hash}"`)
  .replace('href="desk.css"', `href="desk.css?${cssHash}"`);
if (isMainnet) {
  html = html
    .replace(
      /\s*<p class="strip" role="note"><span>Educational demo<\/span><span aria-hidden="true">·<\/span><span>Mutinynet<\/span><span aria-hidden="true">·<\/span><span>coins have no value<\/span><\/p>/,
      "",
    )
    .replace('placeholder="tark1…"', 'placeholder="ark1…"')
    .replace(
      'href="https://mutinynet.arkade.money" target="_blank" rel="noopener">Get one at mutinynet.arkade.money',
      'href="https://arkade.money" target="_blank" rel="noopener">Get one at arkade.money',
    );
}
writeFileSync(path.join(dist, "index.html"), html);
cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
writeFileSync(path.join(dist, ".nojekyll"), "");
const cname = process.env.PAGES_CNAME?.trim();
if (!demo && cname) writeFileSync(path.join(dist, "CNAME"), `${cname}\n`);
