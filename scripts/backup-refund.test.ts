import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { SingleKey } from "@arkade-os/sdk";

import { EXIT, PREDICT_FALLBACK_DELAY, PREDICT_FINAL_EXIT_DELAY, PREDICT_VOID_AFTER } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { exitSequence } from "../protocol/programs.ts";
import { buildBackupRefundTx } from "./backup-refund.ts";

test("Tier-2 backup-refund builds a valid tweaked refundBackup L1 transaction with BIP68 sequence and dust folding", async () => {
  const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));
  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const writerPk = await key(11).xOnlyPublicKey();
  const holderPk = await key(12).xOnlyPublicKey();
  const oraclePk = await key(13).xOnlyPublicKey();
  const backupSecret = hexToBytes(key(14).toHex());
  const backupPk = schnorr.getPublicKey(backupSecret);

  const expiry = 1_795_593_000n;
  const stake = 50_000n;
  const collateral = 95_000n;
  const terms: Terms = {
    kind: 2,
    strike: 8_500_000n,
    collateral,
    premium: stake,
    expiry,
    deadline: expiry - 60n,
    exit: EXIT,
    writerPk,
    holderPk,
    holderPayoutKey: holderPk,
    oraclePk,
    backupPk,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    finalExitDelay: PREDICT_FINAL_EXIT_DELAY,
    serverKey,
    emulatorKey,
  };
  const bound = bindContracts(terms);

  // Split case: holder receives stake, writer receives spendable - stake.
  const split = buildBackupRefundTx({
    backupSecret,
    terms,
    stake,
    utxoTxid: "ab".repeat(32),
    utxoVout: 0,
    utxoValue: collateral,
    feeSats: 1_000n,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    voidAfter: PREDICT_VOID_AFTER,
  });
  assert.equal(split.lockTime, Number(expiry + PREDICT_VOID_AFTER));
  assert.equal(split.sequence, Number(exitSequence(PREDICT_FALLBACK_DELAY)));
  assert.equal(split.holderSats, 50_000n);
  assert.equal(split.writerSats, 44_000n);
  assert.equal(split.tx.outputsLength, 2);
  assert.equal(bytesToHex(split.tx.getOutput(0).script!), bytesToHex(bound.holderPkScript));
  assert.equal(bytesToHex(split.tx.getOutput(1).script!), bytesToHex(bound.writerPkScript));
  assert.ok(split.leafScriptHex.includes(split.tweakedPubHex));
  assert.match(split.rawTxHex, /^[0-9a-f]+$/);

  // Dust-folded case: house remainder <= 330 folds into holder output 0.
  const folded = buildBackupRefundTx({
    backupSecret,
    terms,
    stake,
    utxoTxid: "cd".repeat(32),
    utxoVout: 1,
    utxoValue: stake + 1_300n,
    feeSats: 1_000n,
    fallbackDelay: PREDICT_FALLBACK_DELAY,
    voidAfter: PREDICT_VOID_AFTER,
  });
  assert.equal(folded.tx.outputsLength, 1);
  assert.equal(folded.holderSats, stake + 300n);
  assert.equal(folded.writerSats, 0n);
});
