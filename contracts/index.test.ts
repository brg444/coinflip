import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileContract } from "./compile.mjs";

import { bindBeacon as bindBeaconFromProtocol } from "../protocol/beacon.ts";
import { bindContracts as bindContractsFromProtocol } from "../protocol/contracts.ts";
import { buildSettle as buildSettleFromProtocol } from "../protocol/cospend.ts";
import { beaconProgram as beaconProgramFromProtocol, predictVaultProgram as predictVaultProgramFromProtocol, vaultProgram as vaultProgramFromProtocol } from "../protocol/programs.ts";
import { settlePayouts as settlePayoutsFromSettle, slotFixing as slotFixingFromSettle, slotPrice as slotPriceFromSettle } from "../settle/vault.ts";
import {
  attestationBeaconArtifact,
  beaconProgram,
  bindBeacon,
  bindContracts,
  buildSettle,
  optionVaultArtifact,
  predictVaultProgram,
  settlePayouts,
  slotFixing,
  slotPrice,
  vaultProgram,
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

test("the two artifacts publish the vault and beacon functions", () => {
  assert.deepEqual(api(optionVaultArtifact as Artifact), {
    name: "OptionVault",
    constructor: [
      "kind",
      "writerPk",
      "holderPk",
      "writerScript",
      "holderScript",
      "strike",
      "collateral",
      "expiry",
      "beaconTxid",
      "beaconGidx",
      "readFee",
      "exit",
    ],
    functions: [
      { name: "settle", inputs: [] },
      { name: "close", inputs: ["writerSig", "holderSig"] },
      { name: "unilateral", inputs: ["writerSig"] },
    ],
  });
  assert.deepEqual(api(attestationBeaconArtifact as Artifact), {
    name: "AttestationBeacon",
    constructor: [
      "ctrlTxid",
      "ctrlGidx",
      "domain",
      "expiryLag",
      "readFee",
      "adminPk",
      "exit",
    ],
    functions: [
      { name: "attest", inputs: ["expiry", "price", "time", "nonce", "intentExpiry", "sig", "adminSig"] },
      { name: "read", inputs: ["selfIndex"] },
      { name: "migrate", inputs: ["next", "opSig"] },
      { name: "unilateral", inputs: ["adminSig"] },
    ],
  });
});

test("the import surface is the protocol bind and settle helpers", () => {
  assert.equal(bindContracts, bindContractsFromProtocol);
  assert.equal(bindBeacon, bindBeaconFromProtocol);
  assert.equal(buildSettle, buildSettleFromProtocol);
  assert.equal(vaultProgram, vaultProgramFromProtocol);
  assert.equal(predictVaultProgram, predictVaultProgramFromProtocol);
  assert.equal(beaconProgram, beaconProgramFromProtocol);
  assert.equal(slotPrice, slotPriceFromSettle);
  assert.equal(slotFixing, slotFixingFromSettle);
  assert.equal(settlePayouts, settlePayoutsFromSettle);
  assert.deepEqual(Object.keys(vaultProgram().functions).sort(), ["close", "settle", "unilateral"]);
  assert.deepEqual(Object.keys(predictVaultProgram().functions).sort(), ["close", "reboard", "refund", "refundBackup", "settle", "unilateral"]);
  assert.deepEqual(Object.keys(beaconProgram().functions).sort(), ["attest", "migrate", "read", "unilateral"]);
});

test("committed contract artifacts match compiled .ark sources", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const entries = readdirSync(dir).sort();
  const artifactFiles = entries.filter((name) => name.endsWith(".artifact.json"));
  assert.ok(artifactFiles.length >= 4);
  for (const artifactFile of artifactFiles) {
    const entry = artifactFile.replace(/\.artifact\.json$/, ".ark");
    const committed = JSON.parse(readFileSync(path.join(dir, artifactFile), "utf8")) as Record<string, unknown>;
    const compiled = await compileContract(entry, dir);
    assert.ok(compiled.artifact, `${entry}: ${compiled.diagnostics.map((d) => d.message).join("; ")}`);
    assert.deepEqual(compiled.artifact, committed, `${entry} drifted`);
  }
});
