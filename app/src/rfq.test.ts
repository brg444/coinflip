import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";

import { EXIT } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { DIA_PUBKEY } from "../../protocol/dia.ts";
import { cancelIntentDelegation, reboardVaultDelegation, scriptNumHex } from "../../protocol/executor.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { explainError } from "./explain.ts";
import { backupKeyMatches, oracleKeyMatches, quoteMatchesBeacon } from "./rfq.ts";

test("quoteMatchesBeacon accepts only the pinned beacon txid and group index", () => {
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid.toUpperCase(), 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 1), false);
  assert.equal(quoteMatchesBeacon("00".repeat(32), 0), false);
  assert.equal(quoteMatchesBeacon("not-a-txid", 0), false);
});

test("oracleKeyMatches pins the DIA signing key", () => {
  const pinned = bytesToHex(DIA_PUBKEY);
  assert.equal(oracleKeyMatches(pinned), true);
  assert.equal(oracleKeyMatches(pinned.toUpperCase()), true);
  assert.equal(oracleKeyMatches("1002" + "11".repeat(32)), false);
  assert.equal(oracleKeyMatches("not-a-key"), false);
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

test("executor delegation builders encode script numbers and contract args", async () => {
  assert.equal(scriptNumHex(0n), "");
  assert.equal(scriptNumHex(1n), "01");
  assert.equal(scriptNumHex(0x80n), "8000");
  assert.equal(scriptNumHex(1_790_000_000n), "803bb16a");
  const serverKey = await SingleKey.fromHex("01".repeat(32)).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex("02".repeat(32)).compressedPublicKey();
  const writerPk = await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey();
  const holderPk = await SingleKey.fromHex("22".repeat(32)).xOnlyPublicKey();
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
    serverKey,
    emulatorKey,
  });
  const cancel = cancelIntentDelegation("tpl-cancel", bound);
  assert.equal(cancel.templateId, "tpl-cancel");
  assert.equal(cancel.variables.deadline, scriptNumHex(1_790_000_180n));
  assert.equal(cancel.variables.side, scriptNumHex(1n));
  const reboard = reboardVaultDelegation("tpl-reboard", bound);
  assert.equal(reboard.templateId, "tpl-reboard");
  assert.equal(reboard.variables.oracle_pk, bytesToHex(DIA_PUBKEY));
  assert.equal(reboard.variables.expiry, scriptNumHex(1_790_000_300n));
});
