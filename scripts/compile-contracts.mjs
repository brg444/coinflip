import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "@arkade-os/compiler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "contracts");

const entries = readdirSync(dir).sort();
const files = Object.fromEntries(
  entries.filter((name) => name.endsWith(".ark")).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]),
);

const requested = process.argv.slice(2).map((name) => (name.endsWith(".ark") ? name : `${name}.ark`));
const targets = requested.length
  ? requested
  : entries
      .filter((name) => name.endsWith(".artifact.json"))
      .map((name) => name.replace(/\.artifact\.json$/, ".ark"));

let failed = false;
for (const entry of targets) {
  if (!(entry in files)) {
    console.error(`missing source: contracts/${entry}`);
    failed = true;
    continue;
  }
  const result = await compile({ entry, files }, { optimize: true });
  for (const diag of result.diagnostics) {
    const loc = diag.start ? `${diag.file}:${diag.start.line}:${diag.start.column}` : diag.file;
    console.error(`[${diag.severity}${diag.code ? `/${diag.code}` : ""}] ${loc}: ${diag.message}`);
  }
  if (!result.artifact) {
    failed = true;
    continue;
  }
  const out = path.join(dir, entry.replace(/\.ark$/, ".artifact.json"));
  writeFileSync(out, `${JSON.stringify(result.artifact, null, 2)}\n`);
  console.log(`compiled ${entry} -> ${path.relative(root, out)}`);
}
if (failed) process.exit(1);
