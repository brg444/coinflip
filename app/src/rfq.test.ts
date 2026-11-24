import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";

import { bytesToHex } from "../../protocol/hex.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { backupKeyMatches, quoteMatchesBeacon } from "./rfq.ts";

test("quoteMatchesBeacon accepts only the pinned beacon txid and group index", () => {
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid.toUpperCase(), 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 1), false);
  assert.equal(quoteMatchesBeacon("00".repeat(32), 0), false);
  assert.equal(quoteMatchesBeacon("not-a-txid", 0), false);
});

test("backupKeyMatches pins backupPk and rejects desk key substitution", async () => {
  const emulator = await SingleKey.fromHex("11".repeat(32)).compressedPublicKey();
  const emulatorX = bytesToHex(emulator.subarray(1));
  const desk = "22".repeat(32);
  const backup = "33".repeat(32);
  assert.equal(backupKeyMatches(emulatorX, desk, emulator, null), true);
  assert.equal(backupKeyMatches(desk, desk, emulator, desk), false);
  assert.equal(backupKeyMatches(backup, desk, emulator, null), false);
  assert.equal(backupKeyMatches(backup, desk, emulator, backup), true);
  assert.equal(backupKeyMatches("not-hex", desk, emulator, null), false);
});
