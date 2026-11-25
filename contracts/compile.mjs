import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { compile } from "@arkade-os/compiler";

// executord accepts decimal literals up to 2^53 - 1; larger numbers push the same minimal script bytes.
function push(token) {
  if (!/^\d+$/.test(token) || BigInt(token) <= BigInt(Number.MAX_SAFE_INTEGER)) return token;
  const bytes = [];
  for (let v = BigInt(token); v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn));
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const injected = (name) => ({ name, type: "signature", encoding: "schnorr-64", injected: true });

// Adapt compiler 0.1.0 single-key operator leaves to the current dual-key (arkd + emulator) operator and executord schema.
export function forTwoKeyOperator(artifact) {
  const out = structuredClone(artifact);
  delete out.updatedAt;
  delete out.codeHash;
  let exits = false;
  for (const fn of out.functions) {
    if (fn.arkade) fn.arkade.asm = fn.arkade.asm.map(push);
    for (const leaf of fn.leaves) {
      const n = leaf.asm.length;
      const tail = n >= 2 && leaf.asm[n - 1] === "OP_CHECKSIG" && /^<OPERATOR_KEY:(.+)>$/.exec(leaf.asm[n - 2]);
      if (tail) {
        leaf.asm = [...leaf.asm.slice(0, n - 2), "<SERVER_KEY>", "OP_CHECKSIGVERIFY", `<EMULATOR_KEY:${tail[1]}>`, "OP_CHECKSIG"];
        leaf.witness = [injected("serverSig"), injected("emulatorSig")];
      }
      if (leaf.asm.some((t) => t.includes("OPERATOR_KEY"))) {
        throw new Error(`leaf ${leaf.name}: unsupported OPERATOR_KEY placement`);
      }
      if (leaf.asm.includes("<OPERATOR_EXIT_DELAY>")) {
        exits = true;
        leaf.asm = leaf.asm.map((t) => (t === "<OPERATOR_EXIT_DELAY>" ? "<operatorExitDelay>" : t));
      }
    }
  }
  if (exits) out.constructorInputs.push({ name: "operatorExitDelay", type: "int" });
  return out;
}

export function loadContractSources(dir) {
  const entries = readdirSync(dir).sort();
  return Object.fromEntries(
    entries.filter((name) => name.endsWith(".ark")).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]),
  );
}

export async function compileContract(entry, dir) {
  const files = loadContractSources(dir);
  if (!(entry in files)) throw new Error(`missing source: ${entry}`);
  const result = await compile({ entry, files }, { optimize: true });
  return {
    artifact: result.artifact ? forTwoKeyOperator(result.artifact) : null,
    diagnostics: result.diagnostics,
  };
}
