import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
mkdirSync(dist, { recursive: true });

const publish = () => {
  const jsPath = path.join(dist, "app.js");
  const hash = existsSync(jsPath)
    ? createHash("sha256").update(readFileSync(jsPath)).digest("hex").slice(0, 10)
    : "dev";
  const cssHash = createHash("sha256").update(readFileSync(path.join(root, "app/desk.css"))).digest("hex").slice(0, 10);
  const html = readFileSync(path.join(root, "app/index.html"), "utf8")
    .replace('src="./app.js"', `src="./app.js?${hash}"`)
    .replace('href="desk.css"', `href="desk.css?${cssHash}"`);
  writeFileSync(path.join(dist, "index.html"), html);
  cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
  writeFileSync(path.join(dist, ".nojekyll"), "");
};

const ctx = await esbuild.context({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "app.js"),
  platform: "browser",
  target: "es2022",
  alias: { "node:crypto": path.join(root, "app/src/browser-crypto.ts") },
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "copy-html",
      setup(build) {
        build.onEnd(() => publish());
      },
    },
  ],
});
await ctx.watch();
publish();

const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};
http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    rel = rel.replace(/^\//, "");
    const file = path.resolve(dist, rel);
    if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`options http://127.0.0.1:${port}`);
  });
