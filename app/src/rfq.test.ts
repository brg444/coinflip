import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey, type arkade } from "@arkade-os/sdk";

import predictArtifact from "../../contracts/predict_vault.artifact.json" with { type: "json" };
import { EXIT } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { cancelIntentDelegation, executorArtifact, reboardVaultDelegation, scriptNumHex } from "../../protocol/executor.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { explainError } from "./explain.ts";
import { backupKeyMatches, oracleKeyMatches } from "./rfq.ts";

test("oracleKeyMatches accepts only the pinned oracle x-only pubkey", () => {
  const pinned = LIVE_BEACON_STATUS.args.adminPk;
  assert.equal(oracleKeyMatches(pinned, pinned), true);
  assert.equal(oracleKeyMatches(pinned.toUpperCase(), pinned), true);
  assert.equal(oracleKeyMatches("00".repeat(32), pinned), false);
  assert.equal(oracleKeyMatches("not-a-key", pinned), false);
  assert.equal(oracleKeyMatches(pinned, null), false);
});

test("backupKeyMatches pins backupPk, rejects desk substitution, and requires an independent key on mainnet", async () => {
  const emulator = await SingleKey.fromHex("11".repeat(32)).compressedPublicKey();
  const emulatorX = bytesToHex(emulator.subarray(1));
  const desk = "22".repeat(32);
  const backup = "33".repeat(32);
  assert.equal(backupKeyMatches(emulatorX, desk, emulator, null), true);
  assert.equal(backupKeyMatches(emulatorX, desk, emulator, null, "bitcoin"), false);
  assert.equal(backupKeyMatches(emulatorX, desk, emulator, null, "mainnet"), false);
  assert.equal(backupKeyMatches(backup, desk, emulator, backup, "bitcoin"), true);
  assert.equal(backupKeyMatches(desk, desk, emulator, desk), false);
  assert.equal(backupKeyMatches(backup, desk, emulator, null), false);
  assert.equal(backupKeyMatches(backup, desk, emulator, backup), true);
  assert.equal(backupKeyMatches("not-hex", desk, emulator, null), false);
});

test("explainError turns raw contract and network errors into readable sentences", () => {
  assert.match(explainError("refund", "failed to execute arkade script"), /void window/);
  assert.match(explainError("cancel", "failed to execute arkade script"), /deadline/);
  assert.match(explainError("settle", "signature verification failed"), /not allowed/);
  assert.match(explainError("reboard", "VTXO_ALREADY_UNROLLED"), /unrolled on Bitcoin/);
  assert.match(explainError("settle", new Error("fetch failed")), /Cannot reach the server/);
});

test("executorArtifact flattens ScriptPubKey and delegation builders encode contract args", async () => {
  const flat = executorArtifact(predictArtifact as arkade.ContractArtifact) as {
    constructorInputs: { name: string; type: string }[];
  };
  assert.equal(flat.constructorInputs.some((c) => c.type === "ScriptPubKey"), false);
  assert.ok(flat.constructorInputs.some((c) => c.name === "writerScript.program" && c.type === "bytes32"));
  assert.ok(flat.constructorInputs.some((c) => c.name === "writerScript.version" && c.type === "int"));

  assert.equal(scriptNumHex(0n), "");
  assert.equal(scriptNumHex(1n), "01");
  assert.equal(scriptNumHex(0x80n), "8000");
  assert.equal(scriptNumHex(1_790_000_000n), "803bb16a");
  const serverKey = await SingleKey.fromHex("01".repeat(32)).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex("02".repeat(32)).compressedPublicKey();
  const writerPk = await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey();
  const holderPk = await SingleKey.fromHex("22".repeat(32)).xOnlyPublicKey();
  const oraclePk = await SingleKey.fromHex("33".repeat(32)).xOnlyPublicKey();
  const bound = bindContracts({
    kind: 2,
    strike: 8_500_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: 1_790_000_300n,
    deadline: 1_790_000_180n,
    exit: EXIT,
    writerPk,
    holderPk,
    holderPayoutKey: holderPk,
    oraclePk,
    serverKey,
    emulatorKey,
  });
  const cancel = cancelIntentDelegation("tpl-cancel", bound);
  assert.equal(cancel.templateId, "tpl-cancel");
  assert.equal(cancel.variables.deadline, scriptNumHex(1_790_000_180n));
  assert.equal(cancel.variables.side, scriptNumHex(1n));
  const reboard = reboardVaultDelegation("tpl-reboard", bound);
  assert.equal(reboard.templateId, "tpl-reboard");
  assert.equal(reboard.variables.oracle_pk, `02${bytesToHex(oraclePk)}`);
  assert.equal(reboard.variables.expiry, scriptNumHex(1_790_000_300n));
});
