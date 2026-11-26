import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import { arkade, asset, CSVMultisigTapscript, Extension, SingleKey, Transaction } from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, predictFixDigest } from "../protocol/beacon.ts";
import {
  EXIT,
  PAIR,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_READ_FEE,
  PREDICT_VOID_AFTER,
  STAKE_MIN,
} from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { predictSettlePriceCents, refundOutputs } from "../protocol/cospend.ts";
import { SCALE } from "../protocol/dia.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { classifyIntent } from "../protocol/intent-state.ts";
import { parsePosition, parseWire, payoutRefusal, predictRefusal, requestRefusal, type RfqRequest } from "../protocol/messages.ts";
import { positionEvent, readPosition } from "../protocol/nostr.ts";
import { payoutMultiplier, predictMultiplier, predictPayout, probAbove } from "../protocol/pricing.ts";
import { predictVaultProgram } from "../protocol/programs.ts";
import { outlay, openPremium, type QuoteRow } from "../desk/book.ts";
import type { OracleFixing } from "./oracle.ts";
import { positionFromAnnouncement, termsFor } from "./positions.ts";
import { refundQuote, settlePayouts, settlePredictQuote, type ChainCoin } from "./vault.ts";

const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const DISPLAY = "00".repeat(31) + "07";
const EXPIRY = 1_700_000_100;
const LINE = 8_231_500n;
const STAKE = 50_000n;
const PAYOUT = 95_000n;

const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

async function predictTerms(kind: 2 | 3 = 2): Promise<Terms> {
  const desk = await key(21).xOnlyPublicKey();
  const bettor = await key(22).xOnlyPublicKey();
  const oracle = await key(9).xOnlyPublicKey();
  return {
    kind,
    strike: LINE,
    collateral: PAYOUT,
    premium: STAKE,
    expiry: BigInt(EXPIRY),
    deadline: BigInt(EXPIRY - 120),
    exit: EXIT,
    writerPk: desk,
    holderPk: bettor,
    holderPayoutKey: bettor,
    oraclePk: oracle,
    readFee: PREDICT_READ_FEE,
    serverKey: await key(1).xOnlyPublicKey(),
    emulatorKey: await key(2).compressedPublicKey(),
  };
}

function coinTx(outputs: { script: Uint8Array; amount: bigint }[], packets: Parameters<typeof Extension.create>[0] = []) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32), index: 1 });
  for (const output of outputs) tx.addOutput(output);
  if (packets.length > 0) tx.addOutput(Extension.create(packets).txOut());
  return tx;
}

test("predict is all or nothing, and a close on the line pays the desk", () => {
  assert.equal(holderPayoff(2, LINE + 1n, LINE, PAYOUT), PAYOUT);
  assert.equal(holderPayoff(2, LINE, LINE, PAYOUT), 0n);
  assert.equal(holderPayoff(2, LINE - 1n, LINE, PAYOUT), 0n);
  assert.equal(holderPayoff(3, LINE - 1n, LINE, PAYOUT), PAYOUT);
  assert.equal(holderPayoff(3, LINE, LINE, PAYOUT), 0n);
  assert.equal(holderPayoff(3, LINE + 1n, LINE, PAYOUT), 0n);
  // Standalone PredictVaultV3 has zero read fee: the winner takes the entire vault in one output.
  assert.deepEqual(settlementOutputs(PAYOUT, PAYOUT, PREDICT_READ_FEE), { mode: "holder", holder: 95_000n, writer: 0n });
  assert.deepEqual(settlementOutputs(0n, PAYOUT, PREDICT_READ_FEE), { mode: "writer", holder: 0n, writer: 95_000n });
});

test("PredictVault exposes three-tier exit leaves and direct-signature settle opcodes", async () => {
  const predict = predictVaultProgram();
  assert.equal(predict.name, "PredictVault");
  assert.deepEqual(
    Object.keys(predict.functions).sort(),
    ["close", "reboard", "refund", "refundBackup", "settle", "unilateral"],
  );
  const asm = predict.functions.settle?.arkadeScript?.asm ?? [];
  const count = (name: string) => asm.filter((token) => token === name).length;
  assert.equal(count("MUL"), 0);
  assert.equal(count("DIV"), 1);
  assert.equal(count("CHECKTIME"), 1);
  assert.equal(count("INSPECTINASSETLOOKUP"), 0);
  assert.equal(count("INSPECTINPUTPACKET"), 0);
  assert.equal(count("CHECKSIGFROMSTACK"), 2);
  assert.equal(count("DIGEST"), 2);

  assert.ok((predict.functions.refund?.arkadeScript?.asm ?? []).includes("CHECKTIME"));
  assert.ok((predict.functions.reboard?.arkadeScript?.asm ?? []).includes("TUNNEL"));
  assert.ok((predict.functions.reboard?.arkadeScript?.asm ?? []).includes("INSPECTINTENTMESSAGE"));
  assert.ok(PREDICT_FINAL_EXIT_DELAY > PREDICT_VOID_AFTER);

  const terms = await predictTerms(2);
  const backupA = await key(30).xOnlyPublicKey();
  const backupB = await key(31).xOnlyPublicKey();
  const boundA = bindContracts({ ...terms, backupPk: backupA });
  const boundB = bindContracts({ ...terms, backupPk: backupB });
  assert.notEqual(boundA.vaultAddress, boundB.vaultAddress);

  const scriptA = new arkade.ArkadeProgramScript(predict, boundA.vault, { serverKey: terms.serverKey, emulatorKey: terms.emulatorKey });
  const refundLeaf = scriptA.functionByName("refund");
  const refundBackupLeaf = scriptA.functionByName("refundBackup");
  const unilateralLeaf = scriptA.functionByName("unilateral");
  assert.ok(refundLeaf?.arkadeScript);
  assert.ok(refundBackupLeaf);
  assert.ok(unilateralLeaf);
  const tweakedBackup = arkade.computeArkadeScriptPublicKey(backupA, refundLeaf.arkadeScript);
  assert.ok(bytesToHex(refundBackupLeaf.tapLeafScript[1]).includes(bytesToHex(tweakedBackup)));
  assert.equal(unilateralLeaf.def.tapscript.signatures?.length, 2);
  assert.ok(bytesToHex(unilateralLeaf.tapLeafScript[1]).includes(bytesToHex(terms.writerPk)));
  assert.ok(bytesToHex(unilateralLeaf.tapLeafScript[1]).includes(bytesToHex(terms.holderPk)));
});

test("a prediction binds intent side 1: the bettor holds, the desk writes", async () => {
  const terms = await predictTerms();
  const bound = bindContracts(terms);
  assert.equal(bound.intent.side, 1n);
  assert.equal(bound.intent.premium, STAKE);
  assert.equal(bound.intent.collateral, PAYOUT);
  assert.equal(bytesToHex(bound.intent.userPk as Uint8Array), bytesToHex(terms.holderPk));
  // The bettor is paid at the key of their own address, the desk at its vtxo script.
  assert.equal(bytesToHex(bound.holderPkScript), `5120${bytesToHex(terms.holderPk)}`);
  assert.deepEqual(bound.userPkScript, bound.holderPkScript);
  assert.deepEqual(bound.solverPkScript, bound.writerPkScript);
  // Published script dialect: a script argument is its witness program and version.
  assert.deepEqual(bound.intent["solverScript.program"], bound.writerProgram);
  assert.deepEqual(bound.intent["optionScript.program"], bound.optionProgram);
  assert.equal(bound.intent["userScript.version"], 1n);
  // Same terms on the option vault would be a different contract.
  const asOption = bindContracts({ ...terms, kind: 0, beacon: beaconIdOf(asset.AssetId.create(DISPLAY, 0)) });
  assert.notEqual(asOption.vaultAddress, bound.vaultAddress);
  assert.notEqual(bindContracts({ ...terms, kind: 3 }).vaultAddress, bound.vaultAddress);
});

test("predict requests and quotes round-trip, and each side names the desk once", async () => {
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "ab".repeat(32),
    pair: PAIR,
    amount_side: "from",
    amount: STAKE.toString(),
    profile: {
      kind: 2,
      strike: Number(LINE),
      expiry: EXPIRY,
      holder_pubkey: "22".repeat(32),
      holder_pk_script: `5120${"22".repeat(32)}`,
    },
  };
  assert.deepEqual(parseWire(JSON.parse(JSON.stringify(request))), request);
  assert.equal(parseWire({ ...request, profile: { ...request.profile, kind: 4 } }), null);
  // A predict request carries the bettor, not a writer.
  assert.equal(parseWire({
    ...request,
    profile: { kind: 2, strike: 1, expiry: EXPIRY, writer_pubkey: "22".repeat(32), writer_pk_script: `5120${"22".repeat(32)}` },
  }), null);

  const binding = {
    deadline: EXPIRY - 120,
    exit: Number(EXIT),
    intent_address: "tark1intent0000",
    vault_address: "tark1vault00000",
  };
  const predictExtras = {
    oracle_pubkey: "44".repeat(32),
    backup_pubkey: "33".repeat(32),
    void_after: Number(PREDICT_VOID_AFTER),
    fallback_delay: Number(PREDICT_FALLBACK_DELAY),
    final_exit_delay: Number(PREDICT_FINAL_EXIT_DELAY),
  };
  const quote = {
    v: 1,
    type: "rfq_quote",
    rfq_id: "ab".repeat(32),
    pair: PAIR,
    from_amount: STAKE.toString(),
    to_amount: PAYOUT.toString(),
    solver_pubkey: "21".repeat(32),
    valid_until: EXPIRY - 150,
    profile: { writer_pubkey: "21".repeat(32), writer_pk_script: `5120${"21".repeat(32)}`, ...predictExtras, ...binding },
  };
  assert.deepEqual(parseWire(quote), quote);
  assert.equal(parseWire({ ...quote, profile: { ...quote.profile, oracle_pubkey: "bad" } }), null);
  assert.equal(parseWire({ ...quote, profile: { ...quote.profile, backup_pubkey: "21".repeat(32) } }), null);
  assert.equal(parseWire({ ...quote, profile: { ...quote.profile, final_exit_delay: Number(PREDICT_FALLBACK_DELAY) } }), null);
  assert.equal(parseWire({ ...quote, profile: { ...quote.profile, fallback_delay: 2049 } }), null);
  const both = { ...quote, profile: { ...quote.profile, holder_pubkey: "21".repeat(32), holder_pk_script: `5120${"21".repeat(32)}` } };
  assert.equal(parseWire(both), null);
  const neither = { ...quote, profile: binding };
  assert.equal(parseWire(neither), null);
});

test("a predict close is on the 5-minute grid, far enough out, and at most an hour away", () => {
  const now = EXPIRY - 300;
  assert.equal(predictRefusal(EXPIRY, STAKE, now), "");
  assert.equal(predictRefusal(EXPIRY + 60, STAKE, now), "expiry");
  assert.equal(predictRefusal(EXPIRY, STAKE, EXPIRY - 59), "expiry");
  assert.equal(predictRefusal(EXPIRY, STAKE, EXPIRY - 60), "");
  assert.equal(predictRefusal(EXPIRY + 3600, STAKE, now), "expiry");
  assert.equal(predictRefusal(EXPIRY, STAKE_MIN - 1n, now), "stake");
  assert.equal(predictRefusal(EXPIRY, 1_000_001n, now), "stake");
  const request = {
    v: 1, type: "rfq_request", rfq_id: "ab".repeat(32), pair: PAIR, amount_side: "from", amount: "50000",
    profile: { kind: 3, strike: 1, expiry: EXPIRY, holder_pubkey: "22".repeat(32), holder_pk_script: `5120${"22".repeat(32)}` },
  } as RfqRequest;
  assert.equal(requestRefusal(request, now), "");
  assert.equal(requestRefusal(request, EXPIRY - 30), "expiry");
});

test("a payout has to beat the stake", () => {
  assert.equal(payoutRefusal(PAYOUT, STAKE, PREDICT_READ_FEE), "");
  assert.equal(payoutRefusal(STAKE, STAKE, PREDICT_READ_FEE), "payout");
  assert.equal(payoutRefusal(STAKE + 1n, STAKE, PREDICT_READ_FEE), "");
});

test("the multiplier is 1.90 at even odds, pays more for the far line, and refuses long shots", () => {
  const years = 161 / (365 * 24 * 3600);
  const at = (kind: 2 | 3, line: number) => predictMultiplier({ kind, spotCents: 8_231_500, lineCents: line, years, vol: 0.45 });
  assert.equal(at(2, 8_231_500), 1.9);
  assert.ok(at(2, 8_236_500)! > at(2, 8_231_500)!);
  assert.ok(at(3, 8_226_500)! > at(3, 8_231_500)!);
  assert.ok(at(2, 8_226_500)! < 1.9);
  assert.equal(at(2, 8_300_000), null);
  assert.equal(at(2, 8_100_000), null);
  assert.ok(Math.abs(probAbove(100, 100, years, 0.45) - 0.5) < 0.001);
  assert.equal(predictPayout(STAKE, 1.9), PAYOUT);
  assert.equal(predictPayout(33_333n, 3.45), 114_998n);
  assert.equal(payoutMultiplier(STAKE, PAYOUT), 1.9);
});

test("the desk's float covers the whole payout of an open prediction", () => {
  const row = (kind: 0 | 2, premium: string, collateral: string): QuoteRow => ({
    rfqId: "ab".repeat(32), collateral, premium, kind, strike: "1", expiry: EXPIRY, deadline: EXPIRY, validUntil: EXPIRY,
    exit: 2048, writerPubkey: "", writerPkScript: "", holderPubkey: "", beaconTxid: DISPLAY, beaconGidx: 0,
    intentAddress: "", vaultAddress: "", status: "open", createdAt: 0, clientPubkey: "",
  });
  assert.equal(outlay(row(0, "1000", "50000")), 1_000n);
  assert.equal(outlay(row(2, "50000", "95000")), 95_000n);
  assert.equal(openPremium([row(0, "1000", "50000"), row(2, "50000", "95000")], EXPIRY - 1), 96_000n);
});

test("a prediction's fill funds the vault, and the stake back is a refund", () => {
  const user = "51200a";
  const vault = "51200b";
  const desk = "51200c";
  const coin = { value: STAKE, spent: true, spentBy: "aa".repeat(32), txid: "bb".repeat(32) };
  const base = { coins: [coin], collateral: PAYOUT, premium: STAKE, writerScript: user, now: 0, deadline: 10, side: 1 as const, vaultScript: vault };
  const filled = classifyIntent({
    ...base,
    spends: { [coin.spentBy]: [{ script: desk, amount: STAKE }, { script: vault, amount: PAYOUT }] },
  });
  assert.equal(filled.phase, "filled");
  assert.equal(filled.closeTxid, coin.spentBy);
  const refunded = classifyIntent({ ...base, spends: { [coin.spentBy]: [{ script: user, amount: STAKE }] } });
  assert.equal(refunded.phase, "refunded");
  const live = classifyIntent({ ...base, coins: [{ ...coin, spent: false, spentBy: "" }], spends: {} });
  assert.equal(live.phase, "funded");
  const short = classifyIntent({
    ...base,
    spends: { [coin.spentBy]: [{ script: desk, amount: STAKE }, { script: vault, amount: PAYOUT - 1n }] },
  });
  assert.equal(short.phase, "open");
});

test("a filled prediction settles standalone via signed fixing to the bettor above the line and to the desk at it", async () => {
  const terms = await predictTerms(2);
  const bound = bindContracts(terms);
  const oracleSecret = hexToBytes(key(9).toHex());
  const oraclePk = await key(9).xOnlyPublicKey();
  const oraclePkHex = bytesToHex(oraclePk);
  const vaultTx = coinTx([
    { script: bound.writerPkScript, amount: STAKE },
    { script: bound.vaultPkScript, amount: PAYOUT },
  ]);
  const coins: (ChainCoin & { script: string })[] = [
    { txid: vaultTx.id, vout: 1, value: Number(PAYOUT), script: bytesToHex(bound.vaultPkScript) },
  ];
  const prev = new Map<string, string>([[vaultTx.id, base64.encode(vaultTx.toPSBT())]]);
  const makeFixing = (cents: bigint): OracleFixing => {
    const time = EXPIRY + 12;
    const digest = predictFixDigest({ expiry: BigInt(EXPIRY), cents, time: BigInt(time) });
    return {
      expiry: EXPIRY,
      cents,
      price: cents * SCALE,
      time,
      nonce: 42n,
      intentExpiry: time + 3_600,
      sig: new Uint8Array(64).fill(0x11),
      oracleSig: schnorr.sign(digest, oracleSecret),
      oraclePk,
      oraclePkHex,
    };
  };
  const submitted: string[] = [];
  const chain = {
    async getVtxos(filter: { scripts?: string[]; spendableOnly?: boolean; spentOnly?: boolean }) {
      const wanted = new Set(filter.scripts ?? []);
      return {
        vtxos: coins.filter((coin) => {
          if (!wanted.has(coin.script)) return false;
          const gone = Boolean(coin.isSpent) || Boolean(coin.spentBy);
          return filter.spendableOnly ? !gone : filter.spentOnly ? gone : true;
        }),
      };
    },
    async getVirtualTxs(ids: string[]) {
      return { txs: ids.map((txid) => prev.get(txid) ?? "") };
    },
  };

  // The public announcement is enough to rebuild the same standalone PredictVaultV3.
  const announcement = parsePosition({
    v: 1,
    type: "option_position",
    rfq_id: "aa".repeat(32),
    pair: PAIR,
    kind: 2,
    collateral: PAYOUT.toString(),
    strike: LINE.toString(),
    expiry: EXPIRY,
    exit: Number(EXIT),
    writer_pubkey: bytesToHex(terms.writerPk),
    writer_pk_script: bytesToHex(bound.writerPkScript),
    holder_pubkey: bytesToHex(terms.holderPk),
    holder_pk_script: bytesToHex(bound.holderPkScript),
    stake: STAKE.toString(),
    oracle_pubkey: oraclePkHex,
    backup_pubkey: bytesToHex(terms.emulatorKey.subarray(1)),
    void_after: Number(PREDICT_VOID_AFTER),
    fallback_delay: Number(PREDICT_FALLBACK_DELAY),
    final_exit_delay: Number(PREDICT_FINAL_EXIT_DELAY),
    vault_address: bound.vaultAddress,
    fill_txid: vaultTx.id,
  });
  assert.ok(announcement);
  // A desk-signed Predict position (signer is writer_pubkey) passes readPosition; a third party does not.
  const deskEvent = positionEvent(hexToBytes(key(21).toHex()), announcement, EXPIRY);
  assert.deepEqual(readPosition(deskEvent), announcement);
  const bettorEvent = positionEvent(hexToBytes(key(22).toHex()), announcement, EXPIRY);
  assert.deepEqual(readPosition(bettorEvent), announcement);
  const strangerEvent = positionEvent(hexToBytes(key(23).toHex()), announcement, EXPIRY);
  assert.equal(readPosition(strangerEvent), null);
  const { holder_pk_script: _dropped, ...withoutHolder } = announcement;
  assert.equal(parsePosition(withoutHolder), null);
  const watched = positionFromAnnouncement(announcement)!;
  const rebuilt = termsFor(watched, terms.serverKey, terms.emulatorKey, PREDICT_READ_FEE);
  assert.equal(bindContracts(rebuilt).vaultAddress, bound.vaultAddress);

  const env = {
    chain,
    serverKey: terms.serverKey,
    emulatorKey: terms.emulatorKey,
    emulator: {
      async submitTx(arkTx: string, checkpointTxs: string[]) {
        submitted.push(arkTx);
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
      },
    },
    checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT)),
    fillTxid: vaultTx.id,
    terms: rebuilt,
    now: EXPIRY + 60,
  };

  const earlySettle = await settlePredictQuote({ ...env, fixing: makeFixing(LINE + 3_710n), now: EXPIRY + 59 });
  assert.deepEqual(earlySettle, { result: "waiting", reason: "early" });

  const won = await settlePredictQuote({ ...env, fixing: makeFixing(LINE + 3_710n) });
  assert.equal(won.result, "settled");
  if (won.result !== "settled") return;
  assert.equal(won.holder, 95_000n);
  assert.equal(won.writer, 0n);
  const paid = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(paid.inputsLength, 1);
  assert.equal(paid.getOutput(0)?.amount, 95_000n);
  assert.equal(bytesToHex(paid.getOutput(0)!.script!), bytesToHex(bound.holderPkScript));
  assert.equal(predictSettlePriceCents(paid), LINE + 3_710n);

  const onLine = await settlePredictQuote({ ...env, fixing: makeFixing(LINE) });
  assert.equal(onLine.result, "settled");
  if (onLine.result !== "settled") return;
  assert.equal(onLine.holder, 0n);
  assert.equal(onLine.writer, 95_000n);
  const kept = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(kept.inputsLength, 1);
  assert.equal(bytesToHex(kept.getOutput(0)!.script!), bytesToHex(bound.writerPkScript));
  assert.equal(predictSettlePriceCents(kept), LINE);

  const lower = settlePayouts({
    kind: 3,
    price: LINE - 1n,
    strike: LINE,
    collateral: PAYOUT,
    locked: PAYOUT,
    readFee: PREDICT_READ_FEE,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  });
  assert.ok("payouts" in lower);
  if ("payouts" in lower) assert.deepEqual(lower.payouts, [{ script: bound.holderPkScript, amount: 95_000n }]);

  const earlyRefund = await refundQuote({ ...env, now: EXPIRY + Number(PREDICT_VOID_AFTER) - 1 });
  assert.deepEqual(earlyRefund, { result: "waiting", reason: "early" });
  const voided = await refundQuote({ ...env, now: EXPIRY + Number(PREDICT_VOID_AFTER) });
  assert.equal(voided.result, "refunded");
  if (voided.result !== "refunded") return;
  assert.equal(voided.holder, STAKE);
  assert.equal(voided.writer, PAYOUT - STAKE);
  const voidTx = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(voidTx.getOutput(0)?.amount, STAKE);
  assert.equal(bytesToHex(voidTx.getOutput(0)!.script!), bytesToHex(bound.holderPkScript));
  assert.equal(voidTx.getOutput(1)?.amount, PAYOUT - STAKE);
  assert.equal(bytesToHex(voidTx.getOutput(1)!.script!), bytesToHex(bound.writerPkScript));

  const folded = refundOutputs(STAKE + 330n, STAKE, bound.holderPkScript, bound.writerPkScript);
  assert.deepEqual(folded, [{ script: bound.holderPkScript, amount: STAKE + 330n }]);
  assert.throws(() => refundOutputs(STAKE, 330n, bound.holderPkScript, bound.writerPkScript), /dust/);
});
