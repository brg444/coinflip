import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import { CSVMultisigTapscript, SingleKey, Transaction } from "@arkade-os/sdk";

import {
  EXIT,
  PAIR,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VAULT_PROGRAM_ID,
  PREDICT_VOID_AFTER,
} from "./constants.ts";
import { SCALE } from "./dia.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import * as protocolBarrel from "./index.ts";
import { parsePosition, type OptionPosition, type RfqQuote, type RfqRequest } from "./messages.ts";
import {
  bindContracts,
  InMemoryRfqBus,
  intentProgram,
  positionFromAnnouncement,
  predictFixDigest,
  predictMultiplier,
  predictPayout,
  predictSettlePriceCents,
  predictVaultProgram,
  settlePredictQuote,
  termsFor,
  type ChainCoin,
  type OracleFeedPort,
  type OracleFixing,
} from "./index.ts";

const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

test("coinflip/protocol barrel exposes the complete Layer 1 API", () => {
  assert.equal(typeof protocolBarrel.bindContracts, "function");
  assert.equal(typeof protocolBarrel.predictFixDigest, "function");
  assert.equal(typeof protocolBarrel.settlePayouts, "function");
  assert.equal(typeof protocolBarrel.settlePredictQuote, "function");
  assert.equal(typeof protocolBarrel.parseOracleFixing, "function");
  assert.equal(typeof protocolBarrel.createHttpOracleClient, "function");
  assert.deepEqual(Object.keys(intentProgram().functions).sort(), ["cancel", "cancelCltv", "finalize", "unilateral"]);
  assert.deepEqual(Object.keys(predictVaultProgram().functions).sort(), ["close", "reboard", "refund", "refundBackup", "settle", "unilateral"]);
});

test("InMemoryRfqBus + OracleFeedPort run full RFQ -> quote -> fill announcement -> standalone settle in memory", async () => {
  const bus = new InMemoryRfqBus();
  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const deskPk = await key(21).xOnlyPublicKey();
  const bettorPk = await key(22).xOnlyPublicKey();
  const oracleSecret = hexToBytes(key(9).toHex());
  const oraclePk = await key(9).xOnlyPublicKey();
  const deskPubHex = bytesToHex(deskPk);
  const bettorPubHex = bytesToHex(bettorPk);
  const oraclePkHex = bytesToHex(oraclePk);
  const backupPkHex = bytesToHex(emulatorKey.subarray(1));

  const now = 1_700_000_000;
  const expiry = 1_700_000_400; // multiple of 300
  const strike = 9_000_000n;
  const stake = 50_000n;

  // 1. Desk connects over pluggable RfqTransport (no Nostr sockets).
  const deskState: { bound?: ReturnType<typeof bindContracts> } = {};
  const deskTransport = bus.connectDesk(deskPubHex, ({ from, message }) => {
    if (message.type !== "rfq_request") return;
    const mult = predictMultiplier({
      kind: message.profile.kind,
      spotCents: Number(strike),
      lineCents: message.profile.strike,
      years: (message.profile.expiry - now) / (365 * 24 * 3600),
      vol: 0.5,
    })!;
    const payout = predictPayout(BigInt(message.amount), mult);
    const bound = bindContracts({
      kind: message.profile.kind,
      strike: BigInt(message.profile.strike),
      collateral: payout,
      premium: BigInt(message.amount),
      expiry: BigInt(message.profile.expiry),
      deadline: BigInt(now + 30),
      exit: EXIT,
      writerPk: deskPk,
      holderPk: hexToBytes(message.profile.holder_pubkey),
      holderPayoutKey: hexToBytes(message.profile.holder_pubkey),
      oraclePk,
      serverKey,
      emulatorKey,
    });
    deskState.bound = bound;
    const quote: RfqQuote = {
      v: 1,
      type: "rfq_quote",
      rfq_id: message.rfq_id,
      pair: PAIR,
      from_amount: message.amount,
      to_amount: payout.toString(),
      solver_pubkey: deskPubHex,
      valid_until: now + 30,
      profile: {
        writer_pubkey: deskPubHex,
        writer_pk_script: bytesToHex(bound.writerPkScript),
        oracle_pubkey: oraclePkHex,
        backup_pubkey: backupPkHex,
        void_after: Number(PREDICT_VOID_AFTER),
        fallback_delay: Number(PREDICT_FALLBACK_DELAY),
        final_exit_delay: Number(PREDICT_FINAL_EXIT_DELAY),
        deadline: now + 30,
        exit: Number(EXIT),
        intent_address: bound.intentAddress,
        vault_address: bound.vaultAddress,
      },
    };
    void deskTransport.publish(from, quote);
  });

  // 2. Settler watches public filled positions via PositionFeed.
  const observed: OptionPosition[] = [];
  const positionSub = bus.watchPositions((position) => observed.push(position));

  try {
    // 3. Client sends RFQ via pluggable RfqClient and verifies quote binding.
    const client = bus.client(bettorPubHex);
    const req: RfqRequest = {
      v: 1,
      type: "rfq_request",
      rfq_id: "aa".repeat(32),
      pair: PAIR,
      amount_side: "from",
      amount: stake.toString(),
      profile: {
        kind: 2,
        strike: Number(strike),
        expiry,
        holder_pubkey: bettorPubHex,
        holder_pk_script: `5120${bettorPubHex}`,
      },
    };
    const replies = await client.request({
      recipients: [deskPubHex],
      payload: req,
      timeoutMs: 1_000,
      accept: (incoming) => incoming.message.rfq_id === req.rfq_id,
      done: (incoming) => incoming.message.type === "rfq_quote",
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.message.type, "rfq_quote");
    const quote = replies[0]!.message as RfqQuote;
    assert.equal(quote.to_amount, "95000");

    // 4. Desk fills vault and announces public position.
    const deskBound = deskState.bound;
    assert.ok(deskBound);
    const fillTx = new Transaction({ version: 3, allowUnknownOutputs: true });
    fillTx.addInput({ txid: new Uint8Array(32), index: 0 });
    fillTx.addOutput({ script: deskBound.writerPkScript, amount: stake });
    fillTx.addOutput({ script: deskBound.vaultPkScript, amount: 95_000n });

    const announcement = parsePosition({
      v: 1,
      type: "option_position",
      program_id: PREDICT_VAULT_PROGRAM_ID,
      rfq_id: req.rfq_id,
      pair: PAIR,
      kind: 2,
      collateral: "95000",
      stake: stake.toString(),
      strike: strike.toString(),
      expiry,
      exit: Number(EXIT),
      writer_pubkey: deskPubHex,
      writer_pk_script: bytesToHex(deskBound.writerPkScript),
      holder_pubkey: bettorPubHex,
      holder_pk_script: bytesToHex(deskBound.holderPkScript),
      oracle_pubkey: oraclePkHex,
      backup_pubkey: backupPkHex,
      void_after: Number(PREDICT_VOID_AFTER),
      fallback_delay: Number(PREDICT_FALLBACK_DELAY),
      final_exit_delay: Number(PREDICT_FINAL_EXIT_DELAY),
      vault_address: deskBound.vaultAddress,
      fill_txid: fillTx.id,
    })!;
    await deskTransport.publishPosition(announcement);
    assert.equal(observed.length, 1);

    // 5. Settler rebuilds vault from public announcement, fetches fixing via OracleFeedPort, and settles.
    const watched = positionFromAnnouncement(observed[0]!)!;
    const rebuiltTerms = termsFor(watched, serverKey, emulatorKey);
    assert.equal(bindContracts(rebuiltTerms).vaultAddress, deskBound.vaultAddress);

    const winCents = strike + 5_000n;
    const sampleTime = expiry + 12;
    const fixing: OracleFixing = {
      expiry,
      cents: winCents,
      price: winCents * SCALE,
      time: sampleTime,
      nonce: 7n,
      intentExpiry: sampleTime + 3_600,
      sig: new Uint8Array(64).fill(0x22),
      oracleSig: schnorr.sign(predictFixDigest({ expiry: BigInt(expiry), cents: winCents, time: BigInt(sampleTime) }), oracleSecret),
      oraclePk,
      oraclePkHex,
    };
    const oracleFeed: OracleFeedPort = {
      fetchStatus: async () => ({ pubkeys: [oraclePkHex] }),
      fetchPrices: async () => [{ price: winCents.toString(), time: sampleTime }],
      fetchFixing: async (wantExpiry, wantPk) => (
        wantExpiry === expiry && wantPk === oraclePkHex
          ? { status: 200, fixing }
          : { status: 404, fixing: null, error: "no sample" }
      ),
    };
    const fetched = await oracleFeed.fetchFixing(expiry, watched.oraclePkHex);
    assert.ok(fetched.fixing);

    const vaultCoins: (ChainCoin & { script: string })[] = [
      { txid: fillTx.id, vout: 1, value: 95_000, script: bytesToHex(deskBound.vaultPkScript) },
    ];
    const submitted: string[] = [];
    const settled = await settlePredictQuote({
      chain: {
        async getVtxos(filter) {
          return { vtxos: vaultCoins.filter((c) => filter.scripts.includes(c.script)) };
        },
        async getVirtualTxs() {
          return { txs: [base64.encode(fillTx.toPSBT())] };
        },
      },
      serverKey,
      emulatorKey,
      emulator: {
        async submitTx(arkTx, checkpointTxs) {
          submitted.push(arkTx);
          return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
        },
      },
      checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT)),
      fillTxid: fillTx.id,
      terms: rebuiltTerms,
      fixing: fetched.fixing,
      now: expiry + 60,
    });
    assert.equal(settled.result, "settled");
    if (settled.result !== "settled") return;
    assert.equal(settled.holder, 95_000n);
    assert.equal(settled.writer, 0n);
    const settleTx = Transaction.fromPSBT(base64.decode(submitted[0]!));
    assert.equal(predictSettlePriceCents(settleTx), winCents);
  } finally {
    positionSub.close();
    deskTransport.close();
  }
});
