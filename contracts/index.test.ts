import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileContract } from "./compile.mjs";

import { bindContracts as bindContractsFromProtocol } from "../protocol/contracts.ts";
import {
  buildPredictSettle as buildPredictSettleFromProtocol,
  buildRefund as buildRefundFromProtocol,
  predictSettlePriceCents as predictSettlePriceCentsFromProtocol,
  submit as submitFromProtocol,
} from "../protocol/cospend.ts";
import { predictFixDigest as predictFixDigestFromProtocol } from "../protocol/fixing.ts";
import {
  intentProgram as intentProgramFromProtocol,
  predictVaultProgram as predictVaultProgramFromProtocol,
} from "../protocol/programs.ts";
import { settlePayouts as settlePayoutsFromSettle } from "../settle/vault.ts";
import {
  bindContracts,
  buildPredictSettle,
  buildRefund,
  intentProgram,
  optionIntentArtifact,
  predictFixDigest,
  predictSettlePriceCents,
  predictVaultArtifact,
  predictVaultProgram,
  settlePayouts,
  submit,
} from "./index.ts";

type Artifact = {
  contractName: string;
  constructorInputs: { name: string }[];
  functions: {
    name: string;
    arkade?: { inputs?: { name: string }[] };
    leaves?: { name: string; witness?: { name: string }[] }[];
  }[];
};

/** Caller-facing names. Skips script bytes. */
function api(artifact: Artifact) {
  return {
    name: artifact.contractName,
    constructor: artifact.constructorInputs.map((input) => input.name),
    functions: artifact.functions.map((fn) => ({
      name: fn.name,
      inputs:
        fn.arkade?.inputs?.map((input) => input.name) ??
        fn.leaves?.find((leaf) => leaf.name === fn.name)?.witness?.map((item) => item.name) ??
        [],
    })),
  };
}

test("the two artifacts publish the PredictVault and OptionIntent functions", () => {
  assert.deepEqual(api(predictVaultArtifact as Artifact), {
    name: "PredictVault",
    constructor: [
      "kind",
      "writerPk",
      "holderPk",
      "writerScript",
      "holderScript",
      "strike",
      "collateral",
      "stake",
      "expiry",
      "oraclePk",
      "backupPk",
      "voidAfter",
      "fallbackDelay",
      "finalExitDelay",
    ],
    functions: [
      { name: "settle", inputs: ["price", "time", "nonce", "intentExpiry", "sig", "oracleSig"] },
      { name: "refund", inputs: [] },
      { name: "reboard", inputs: [] },
      { name: "close", inputs: ["writerSig", "holderSig"] },
      { name: "unilateral", inputs: ["writerSig", "holderSig"] },
    ],
  });
  assert.deepEqual(api(optionIntentArtifact as Artifact), {
    name: "OptionIntent",
    constructor: [
      "userPk",
      "userScript",
      "solverScript",
      "optionScript",
      "side",
      "collateral",
      "premium",
      "deadline",
      "exit",
    ],
    functions: [
      { name: "finalize", inputs: [] },
      { name: "cancel", inputs: [] },
      { name: "cancelAuto", inputs: [] },
      { name: "unilateral", inputs: ["userSig"] },
    ],
  });
});

test("the import surface exposes the PredictVault and OptionIntent helpers", () => {
  assert.equal(bindContracts, bindContractsFromProtocol);
  assert.equal(predictFixDigest, predictFixDigestFromProtocol);
  assert.equal(buildPredictSettle, buildPredictSettleFromProtocol);
  assert.equal(buildRefund, buildRefundFromProtocol);
  assert.equal(predictSettlePriceCents, predictSettlePriceCentsFromProtocol);
  assert.equal(submit, submitFromProtocol);
  assert.equal(intentProgram, intentProgramFromProtocol);
  assert.equal(predictVaultProgram, predictVaultProgramFromProtocol);
  assert.equal(settlePayouts, settlePayoutsFromSettle);
  assert.deepEqual(Object.keys(intentProgram().functions).sort(), ["cancel", "cancelCltv", "finalize", "unilateral"]);
  assert.deepEqual(Object.keys(predictVaultProgram().functions).sort(), ["close", "reboard", "refund", "refundBackup", "settle", "unilateral"]);
});

test("committed contract artifacts match compiled .ark sources", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const entries = readdirSync(dir).sort();
  const artifactFiles = entries.filter((name) => name.endsWith(".artifact.json"));
  assert.deepEqual(artifactFiles, ["option_intent.artifact.json", "predict_vault.artifact.json"]);
  for (const artifactFile of artifactFiles) {
    const entry = artifactFile.replace(/\.artifact\.json$/, ".ark");
    const committed = JSON.parse(readFileSync(path.join(dir, artifactFile), "utf8")) as Record<string, unknown>;
    const compiled = await compileContract(entry, dir);
    assert.ok(compiled.artifact, `${entry}: ${compiled.diagnostics.map((d) => d.message).join("; ")}`);
    assert.deepEqual(compiled.artifact, committed, `${entry} drifted`);
  }
});
