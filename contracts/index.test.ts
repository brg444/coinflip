import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compile } from "@arkade-os/compiler";

import { bindBeacon as bindBeaconFromProtocol } from "../protocol/beacon.ts";
import { bindContracts as bindContractsFromProtocol } from "../protocol/contracts.ts";
import { buildSettle as buildSettleFromProtocol } from "../protocol/cospend.ts";
import { beaconProgram as beaconProgramFromProtocol, standingLegProgram as standingLegProgramFromProtocol, standingVaultProgram as standingVaultProgramFromProtocol, vaultProgram as vaultProgramFromProtocol } from "../protocol/programs.ts";
import { bindWriterLeg as bindWriterLegFromProtocol, buildStandingMatch as buildStandingMatchFromProtocol } from "../protocol/standing.ts";
import { settlePayouts as settlePayoutsFromSettle, slotFixing as slotFixingFromSettle, slotPrice as slotPriceFromSettle } from "../settle/vault.ts";
import {
  attestationBeaconArtifact,
  beaconProgram,
  bindBeacon,
  bindContracts,
  bindWriterLeg,
  buildSettle,
  buildStandingMatch,
  standingLegProgram,
  standingVaultProgram,
  optionVaultArtifact,
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
      "signers",
      "signersN",
      "threshold",
      "domain",
      "expiryLag",
      "readFee",
      "adminPk",
      "exit",
    ],
    functions: [
      { name: "attest", inputs: ["expiry", "price", "time", "sigs"] },
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
  assert.equal(bindWriterLeg, bindWriterLegFromProtocol);
  assert.equal(buildStandingMatch, buildStandingMatchFromProtocol);
  assert.equal(standingLegProgram, standingLegProgramFromProtocol);
  assert.equal(standingVaultProgram, standingVaultProgramFromProtocol);
  assert.equal(vaultProgram, vaultProgramFromProtocol);
  assert.equal(beaconProgram, beaconProgramFromProtocol);
  assert.equal(slotPrice, slotPriceFromSettle);
  assert.equal(slotFixing, slotFixingFromSettle);
  assert.equal(settlePayouts, settlePayoutsFromSettle);
  assert.deepEqual(Object.keys(vaultProgram().functions).sort(), ["close", "settle", "unilateral"]);
  assert.deepEqual(Object.keys(beaconProgram().functions).sort(), ["attest", "migrate", "read", "unilateral"]);
});

test("committed contract artifacts match compiled .ark sources", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const entries = readdirSync(dir).sort();
  const files = Object.fromEntries(
    entries.filter((name) => name.endsWith(".ark")).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]),
  );
  const artifactFiles = entries.filter((name) => name.endsWith(".artifact.json"));
  assert.ok(artifactFiles.length >= 6);
  for (const artifactFile of artifactFiles) {
    const entry = artifactFile.replace(/\.artifact\.json$/, ".ark");
    const committed = JSON.parse(readFileSync(path.join(dir, artifactFile), "utf8")) as Record<string, unknown>;
    const compiled = await compile({ entry, files }, { optimize: true });
    assert.ok(compiled.artifact, `${entry}: ${compiled.diagnostics.map((d) => d.message).join("; ")}`);
    assert.equal(compiled.artifact.contractName, committed.contractName, `${entry} contractName`);
    assert.deepEqual(compiled.artifact.constructorInputs, committed.constructorInputs, `${entry} constructorInputs`);
    assert.deepEqual(compiled.artifact.functions, committed.functions, `${entry} functions`);
  }
});
