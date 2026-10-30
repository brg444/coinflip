import assert from "node:assert/strict";
import test from "node:test";

import { base64 } from "@scure/base";
import { asset, CSVMultisigTapscript, Extension, SingleKey, Transaction } from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, bindBeacon, genesisState, nextState, priceValue } from "../protocol/beacon.ts";
import { BEACON_READ_FEE, EXIT, PAIR, STAKE_MIN } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { classifyIntent } from "../protocol/intent-state.ts";
import { parsePosition, parseWire, payoutRefusal, predictRefusal, requestRefusal, type RfqRequest } from "../protocol/messages.ts";
import { payoutMultiplier, predictMultiplier, predictPayout, probAbove } from "../protocol/pricing.ts";
import { predictVaultProgram, rawPredictVaultProgram, vaultProgram } from "../protocol/programs.ts";
import { outlay, openPremium, type QuoteRow } from "../desk/book.ts";
import { parseOracleBeacon } from "./oracle.ts";
import { positionFromAnnouncement, termsFor } from "./positions.ts";
import { settleQuote, settlePayouts, type ChainCoin } from "./vault.ts";

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
    beacon: beaconIdOf(asset.AssetId.create(DISPLAY, 0)),
    readFee: BEACON_READ_FEE,
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
  // The winner takes the vault less the read fee, in one output.
  assert.deepEqual(settlementOutputs(PAYOUT, PAYOUT, BEACON_READ_FEE), { mode: "holder", holder: 94_000n, writer: 0n });
  assert.deepEqual(settlementOutputs(0n, PAYOUT, BEACON_READ_FEE), { mode: "writer", holder: 0n, writer: 94_000n });
});

test("PredictVault is OptionVault with the payoff swapped and nothing else", () => {
  const predict = rawPredictVaultProgram();
  const option = vaultProgram();
  assert.equal(predict.name, "PredictVault");
  assert.deepEqual(Object.keys(predict.functions), Object.keys(option.functions));
  const asm = predictVaultProgram().functions.settle?.arkadeScript?.asm ?? [];
  const count = (name: string) => asm.filter((token) => token === name).length;
  assert.equal(count("MUL"), 0);
  assert.equal(count("DIV"), 0);
  assert.equal(count("CHECKTIME"), 1);
  assert.equal(count("INSPECTINASSETLOOKUP"), 1);
  assert.equal(count("INSPECTINPUTPACKET"), 1);
  assert.equal(count("CHECKSIGFROMSTACK"), 0);
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
  assert.deepEqual(bound.intent.solverScript, bound.writerProgram);
  assert.deepEqual(bound.intent.optionScript, bound.optionProgram);
  // Same terms on the option vault would be a different contract.
  const asOption = bindContracts({ ...terms, kind: 0 });
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
    beacon_txid: DISPLAY,
    beacon_gidx: 0,
    deadline: EXPIRY - 120,
    exit: Number(EXIT),
    intent_address: "tark1intent0000",
    vault_address: "tark1vault00000",
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
    profile: { writer_pubkey: "21".repeat(32), writer_pk_script: `5120${"21".repeat(32)}`, ...binding },
  };
  assert.deepEqual(parseWire(quote), quote);
  const both = { ...quote, profile: { ...quote.profile, holder_pubkey: "21".repeat(32), holder_pk_script: `5120${"21".repeat(32)}` } };
  assert.equal(parseWire(both), null);
  const neither = { ...quote, profile: binding };
  assert.equal(parseWire(neither), null);
});

test("a predict close is on the 5-minute grid, far enough out, and at most an hour away", () => {
  const now = EXPIRY - 300;
  assert.equal(predictRefusal(EXPIRY, STAKE, now), "");
  assert.equal(predictRefusal(EXPIRY + 60, STAKE, now), "expiry");
  assert.equal(predictRefusal(EXPIRY, STAKE, EXPIRY - 119), "expiry");
  assert.equal(predictRefusal(EXPIRY, STAKE, EXPIRY - 120), "");
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

test("a payout has to beat the stake after the read fee", () => {
  assert.equal(payoutRefusal(PAYOUT, STAKE, BEACON_READ_FEE), "");
  assert.equal(payoutRefusal(STAKE + BEACON_READ_FEE, STAKE, BEACON_READ_FEE), "payout");
  assert.equal(payoutRefusal(STAKE + BEACON_READ_FEE + 1n, STAKE, BEACON_READ_FEE), "");
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

test("a filled prediction settles to the bettor above the line and to the desk at it", async () => {
  const terms = await predictTerms(2);
  const bound = bindContracts(terms);
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const adminPk = await key(9).xOnlyPublicKey();
  const domain = new TextEncoder().encode("BTCUSD-FIX");
  const assetId = asset.AssetId.create(DISPLAY, 0);
  const id = beaconIdOf(assetId);
  const beacon = bindBeacon({
    id,
    signers,
    threshold: 1n,
    domain,
    keyLag: 60n,
    readFee: BEACON_READ_FEE,
    adminPk,
    exit: EXIT,
    serverKey: terms.serverKey,
    emulatorKey: terms.emulatorKey,
  });
  const vaultTx = coinTx([
    { script: bound.writerPkScript, amount: STAKE },
    { script: bound.vaultPkScript, amount: PAYOUT },
  ]);
  const coins: (ChainCoin & { script: string })[] = [
    { txid: vaultTx.id, vout: 1, value: Number(PAYOUT), script: bytesToHex(bound.vaultPkScript) },
  ];
  const prev = new Map<string, string>([[vaultTx.id, base64.encode(vaultTx.toPSBT())]]);
  const useFixing = (cents: bigint) => {
    const state = nextState(genesisState(), terms.expiry, priceValue(cents));
    const tx = coinTx([{ script: beacon.pkScript, amount: 330n }], [statePacket(state)]);
    coins[1] = { txid: tx.id, vout: 0, value: 330, script: bytesToHex(beacon.pkScript), assets: [{ assetId: assetId.toString(), amount: 1n }] };
    prev.set(tx.id, base64.encode(tx.toPSBT()));
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
  const status = {
    issueTxid: DISPLAY,
    assetId: assetId.toString(),
    address: beacon.address,
    pubkeys: signers.map((item) => bytesToHex(item)),
    args: {
      ctrlTxid: bytesToHex(id.txid),
      threshold: 1,
      domain: bytesToHex(domain),
      keyLag: 60,
      readFee: Number(BEACON_READ_FEE),
      adminPk: bytesToHex(adminPk),
      exit: Number(EXIT),
    },
    fixings: [],
  };
  const parsed = parseOracleBeacon(status, DISPLAY, 0);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  // The public announcement is enough to rebuild the same vault.
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
    beacon_txid: DISPLAY,
    beacon_gidx: 0,
    vault_address: bound.vaultAddress,
    fill_txid: vaultTx.id,
  });
  assert.ok(announcement);
  const { holder_pk_script: _dropped, ...withoutHolder } = announcement;
  assert.equal(parsePosition(withoutHolder), null);
  const watched = positionFromAnnouncement(announcement)!;
  const rebuilt = termsFor(watched, terms.serverKey, terms.emulatorKey, BEACON_READ_FEE);
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
    beacon: parsed.beacon,
    now: EXPIRY + 60,
  };

  useFixing(LINE + 3_710n);
  const won = await settleQuote(env);
  assert.equal(won.result, "settled");
  if (won.result !== "settled") return;
  assert.equal(won.holder, 94_000n);
  assert.equal(won.writer, 0n);
  const paid = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(paid.getOutput(0)?.amount, 1_330n);
  assert.equal(paid.getOutput(1)?.amount, 94_000n);
  assert.equal(bytesToHex(paid.getOutput(1)!.script!), bytesToHex(bound.holderPkScript));

  useFixing(LINE);
  const onLine = await settleQuote(env);
  assert.equal(onLine.result, "settled");
  if (onLine.result !== "settled") return;
  assert.equal(onLine.holder, 0n);
  assert.equal(onLine.writer, 94_000n);
  const kept = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(bytesToHex(kept.getOutput(1)!.script!), bytesToHex(bound.writerPkScript));

  const lower = settlePayouts({
    kind: 3,
    price: LINE - 1n,
    strike: LINE,
    collateral: PAYOUT,
    locked: PAYOUT,
    readFee: BEACON_READ_FEE,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  });
  assert.ok("payouts" in lower);
  if ("payouts" in lower) assert.deepEqual(lower.payouts, [{ script: bound.holderPkScript, amount: 94_000n }]);
});
