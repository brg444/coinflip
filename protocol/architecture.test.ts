import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Allowed cross-directory dependencies enforcing a strictly acyclic 3-layer architecture:
 *   Layer 0: contracts/  -> (none)
 *   Layer 1: protocol/   -> contracts/
 *   Layer 2: oracle/, desk/, settle/, app/ -> protocol/ (zero cross-service imports)
 *   Tooling: scripts/    -> protocol/, contracts/ (compile harness only)
 */
const ALLOWED_CROSS_LAYER: Record<string, ReadonlySet<string>> = {
  contracts: new Set(),
  protocol: new Set(["contracts"]),
  oracle: new Set(["protocol"]),
  desk: new Set(["protocol"]),
  settle: new Set(["protocol"]),
  app: new Set(["protocol"]),
  scripts: new Set(["protocol", "contracts"]),
};

const RELATIVE_IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?from\s+)?["'](\.[^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "go" || entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|js|mjs)$/.test(entry.name) || /\.test\.(ts|js|mjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

test("repository module graph is strictly acyclic and respects Layer 0 -> Layer 1 -> Layer 2 boundaries", () => {
  const violations: string[] = [];
  const graph = new Map<string, Set<string>>();

  for (const [layer, allowed] of Object.entries(ALLOWED_CROSS_LAYER)) {
    const layerDir = path.join(ROOT, layer);
    if (!existsSync(layerDir)) continue;
    for (const file of sourceFiles(layerDir)) {
      const text = readFileSync(file, "utf8");
      const relFile = path.relative(ROOT, file);
      for (const match of text.matchAll(RELATIVE_IMPORT_RE)) {
        const spec = match[1]!;
        const target = path.relative(ROOT, path.resolve(path.dirname(file), spec));
        const targetLayer = target.split(path.sep)[0]!;
        if (targetLayer === layer) continue;
        if (!allowed.has(targetLayer)) {
          violations.push(`${relFile} -> ${target} (disallowed ${layer} -> ${targetLayer})`);
        }
        let edges = graph.get(layer);
        if (!edges) {
          edges = new Set();
          graph.set(layer, edges);
        }
        edges.add(targetLayer);
      }
    }
  }

  assert.deepEqual(violations, [], `Architecture boundary violations:\n${violations.join("\n")}`);

  // Verify the layer graph itself has zero cycles (standard 3-color DFS).
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const dfs = (node: string, trail: string[]) => {
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) {
      const s = state.get(next);
      assert.notEqual(s, 1, `Dependency cycle detected: ${[...trail, node, next].join(" -> ")}`);
      if (!s) dfs(next, [...trail, node]);
    }
    state.set(node, 2);
  };
  for (const node of graph.keys()) {
    if (!state.get(node)) dfs(node, []);
  }
});
