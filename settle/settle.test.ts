import assert from "node:assert/strict";
import test from "node:test";

import { base64 } from "@scure/base";
import {
  asset,
  CSVMultisigTapscript,
  Extension,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import {
  beaconIdOf,
  bindBeacon,
  encodeState,
  genesisState,
  nextState,
  priceValue,
  statePacketOf,
} from "../protocol/beacon.ts";
import { EXIT, OPTION_VAULT_PROGRAM_ID, PAIR } from "../protocol/constants.ts";
import { bindContracts, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { parsePosition } from "../protocol/messages.ts";
import { serviceOrigin, parseOracleBeacon } from "./oracle.ts";
import { duePositions, manualPositions, positionFromAnnouncement, publishOutcome, publishReady, settlementPositions, termsFor } from "./positions.ts";
import { settleQuote, slotPrice, settlePayouts, type ChainCoin } from "./vault.ts";

const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const DISPLAY = "00".repeat(31) + "07";
const EXPIRY = 1_700_000_000;
const STRIKE = 9_700_000n;
const COLLATERAL = 20_000n;
const PRICE = 10_000_000n;

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

function blankSlots(count: number) {
  return Array.from({ length: count }, () => ({ expiry: 0n, value: new Uint8Array(32) }));
}

function coinTx(outputs: { script: Uint8Array; amount: bigint }[], packets: Parameters<typeof Extension.create>[0] = []) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32), index: 1 });
  for (const output of outputs) tx.addOutput(output);
  if (packets.length > 0) tx.addOutput(Extension.create(packets).txOut());
  return tx;
}

test("the newest slot's price is its first 8 bytes only when the sample time is inside the minute", () => {
  const expiry = BigInt(EXPIRY);
  const fixed = nextState(genesisState(), expiry, priceValue(PRICE, expiry));
  assert.equal(slotPrice(fixed, expiry), PRICE);
  assert.equal(slotPrice(nextState(genesisState(), expiry, priceValue(PRICE, expiry + 60n)), expiry), PRICE);
  assert.equal(slotPrice(nextState(genesisState(), expiry, priceValue(PRICE, expiry - 1n)), expiry), null);
  assert.equal(slotPrice(nextState(genesisState(), expiry, priceValue(PRICE, expiry + 61n)), expiry), null);
  assert.equal(slotPrice(genesisState(), expiry), null);
  const value = priceValue(50n, expiry);
  value[8] = 0xff;
  const tagged = encodeState({
    version: 1,
    round: 2n,
    slots: [
      { expiry, value: priceValue(11n, expiry) },
      { expiry, value },
      ...blankSlots(6),
    ],
  });
  assert.equal(slotPrice(tagged, expiry), 11n);
  assert.equal(slotPrice(encodeState({ version: 1, round: 1n, slots: [{ expiry, value: priceValue(0n, expiry) }, ...blankSlots(7)] }), expiry), null);
});

test("dust folding pays one leg the whole coin", () => {
  const holder = new Uint8Array([1]);
  const writer = new Uint8Array([2]);
  const split = settlePayouts({
    kind: 0,
    price: PRICE,
    strike: STRIKE,
    collateral: COLLATERAL,
    locked: COLLATERAL,
    holderScript: holder,
    writerScript: writer,
  });
  assert.ok(!("error" in split));
  if ("error" in split) return;
  assert.deepEqual(split.payouts.map((item) => item.amount), [600n, 19_400n]);

  const folded = settlePayouts({
    kind: 0,
    price: STRIKE,
    strike: STRIKE,
    collateral: COLLATERAL,
    locked: COLLATERAL,
    holderScript: holder,
    writerScript: writer,
  });
  assert.ok(!("error" in folded));
  if ("error" in folded) return;
  assert.equal(folded.payouts.length, 1);
  assert.equal(folded.payouts[0]?.amount, COLLATERAL);
  assert.equal(folded.payouts[0]?.script, writer);

  const holderAll = settlePayouts({
    kind: 0,
    price: 1_000_000_000n,
    strike: 1n,
    collateral: COLLATERAL,
    locked: COLLATERAL,
    holderScript: holder,
    writerScript: writer,
  });
  assert.ok(!("error" in holderAll));
  if ("error" in holderAll) return;
  assert.equal(holderAll.payouts.length, 1);
  assert.equal(holderAll.payouts[0]?.script, holder);
  const under = settlePayouts({
    kind: 0,
    price: PRICE,
    strike: STRIKE,
    collateral: COLLATERAL,
    locked: COLLATERAL - 1n,
    holderScript: holder,
    writerScript: writer,
  });
  assert.ok("error" in under);
  assert.equal(under.error, "underfunded");
});

test("due positions are expired vaults this bot has not progressed", () => {
  const row = (id: string, expiry: number) => ({ id, expiry });
  const due = duePositions([
    row("early", EXPIRY + 10),
    row("later", EXPIRY),
    row("older", EXPIRY - 5),
    row("done", EXPIRY - 1),
  ], EXPIRY, new Set(["done"]));
  assert.deepEqual(due.map((item) => item.id), ["older", "later"]);
  const closed = duePositions([
    row("open", EXPIRY),
    row("ready", EXPIRY - 60),
  ], EXPIRY, new Set(), 60);
  assert.deepEqual(closed.map((item) => item.id), ["ready"]);
});

test("a failed publish is not a fixing, and a minute must pass before the same expiry is asked again", () => {
  assert.equal(publishOutcome(200), "published");
  assert.equal(publishOutcome(409, "already a fixing"), "fixed");
  assert.equal(publishOutcome(400, "no sample"), "failed");
  assert.equal(publishOutcome(400, "before expiry time"), "failed");
  assert.equal(publishOutcome(500, "error"), "failed");
  assert.equal(publishReady(0, 60_000), true);
  assert.equal(publishReady(1_000, 1_000 + 59_999), false);
  assert.equal(publishReady(1_000, 1_000 + 60_000), true);
});

test("a positions file accepts one vault, a list, or a positions object", () => {
  const row = {
    v: 1,
    type: "option_position",
    rfq_id: "aa".repeat(32),
    pair: PAIR,
    kind: 0,
    collateral: "20000",
    strike: "9700000",
    expiry: EXPIRY,
    exit: Number(EXIT),
    writer_pubkey: "11".repeat(32),
    writer_pk_script: "5120" + "22".repeat(32),
    holder_pubkey: "33".repeat(32),
    beacon_txid: "07".repeat(32),
    beacon_gidx: 0,
    vault_address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qg",
    fill_txid: "ee".repeat(32),
  };
  assert.equal(manualPositions(row)[0]?.fill_txid, row.fill_txid);
  assert.equal(manualPositions([row, { ...row, type: "rfq_quote" }]).length, 1);
  assert.equal(manualPositions({ positions: [row] }).length, 1);
  assert.equal(manualPositions({ quotes: [row] }).length, 0);
  const predict = { ...row, rfq_id: "bb".repeat(32), program_id: "PredictVault" };
  assert.equal(parsePosition(predict)?.program_id, "PredictVault");
  assert.equal(parsePosition({ ...predict, program_id: "not an id" }), null);
  const kept = settlementPositions(manualPositions([predict, row]));
  assert.deepEqual(kept.map((item) => item.id), [row.rfq_id]);
  assert.equal(kept[0]?.programId, OPTION_VAULT_PROGRAM_ID);
});

test("a service origin drops the path and refuses other schemes", () => {
  assert.equal(serviceOrigin("https://oracle.example/api/status"), "https://oracle.example");
  assert.throws(() => serviceOrigin("ftp://oracle.example"), /http/);
});

test("a filled vault settles from the beacon state the oracle published", async () => {
  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const adminPk = await key(9).xOnlyPublicKey();
  const writerPk = await key(21).xOnlyPublicKey();
  const holderPk = await key(22).xOnlyPublicKey();
  const domain = new TextEncoder().encode("BTCUSD-FIX");
  const assetId = asset.AssetId.create(DISPLAY, 0);
  const id = beaconIdOf(assetId);
  const beacon = bindBeacon({
    id,
    signers,
    threshold: 3n,
    domain,
    expiryLag: 60n,
    readFee: 0n,
    adminPk,
    exit: EXIT,
    serverKey,
    emulatorKey,
  });
  const terms: Terms = {
    kind: 0,
    strike: STRIKE,
    collateral: COLLATERAL,
    premium: 1_000n,
    expiry: BigInt(EXPIRY),
    deadline: BigInt(EXPIRY),
    exit: EXIT,
    writerPk,
    holderPk,
    beacon: id,
    serverKey,
    emulatorKey,
  };
  const bound = bindContracts(terms);
  const fixed = nextState(genesisState(), terms.expiry, priceValue(PRICE, terms.expiry));
  const beaconTx = coinTx([{ script: beacon.pkScript, amount: 330n }], [statePacket(fixed)]);
  const vaultTx = coinTx([
    { script: bound.writerPkScript, amount: 330n },
    { script: bound.vaultPkScript, amount: COLLATERAL },
  ]);
  assert.equal(Transaction.fromPSBT(base64.decode(base64.encode(beaconTx.toPSBT()))).id, beaconTx.id);
  assert.deepEqual(statePacketOf(Transaction.fromPSBT(base64.decode(base64.encode(beaconTx.toPSBT())))), fixed);

  const coins: (ChainCoin & { script: string })[] = [
    {
      txid: vaultTx.id,
      vout: 1,
      value: Number(COLLATERAL),
      script: bytesToHex(bound.vaultPkScript),
    },
    {
      txid: beaconTx.id,
      vout: 0,
      value: 330,
      script: bytesToHex(beacon.pkScript),
      assets: [{ assetId: assetId.toString(), amount: 1n }],
    },
  ];
  const prev = new Map<string, string>([
    [vaultTx.id, base64.encode(vaultTx.toPSBT())],
    [beaconTx.id, base64.encode(beaconTx.toPSBT())],
  ]);
  const submitted: string[] = [];
  const checkpoints: string[][] = [];
  const chain = {
    async getVtxos(filter: { scripts?: string[]; spendableOnly?: boolean; spentOnly?: boolean }) {
      const wanted = new Set(filter.scripts ?? []);
      return {
        vtxos: coins.filter((coin) => {
          if (!wanted.has(coin.script)) return false;
          const gone = Boolean(coin.isSpent) || Boolean(coin.spentBy);
          if (filter.spendableOnly) return !gone;
          if (filter.spentOnly) return gone;
          return true;
        }),
      };
    },
    async getVirtualTxs(ids: string[]) {
      return { txs: ids.map((id) => prev.get(id) ?? "") };
    },
  };
  const emulator = {
    async submitTx(arkTx: string, checkpointTxs: string[]) {
      submitted.push(arkTx);
      checkpoints.push(checkpointTxs);
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
    },
  };
  const status = {
    issueTxid: DISPLAY,
    assetId: assetId.toString(),
    address: beacon.address,
    pubkeys: signers.map((item) => bytesToHex(item)),
    args: {
      ctrlTxid: bytesToHex(id.txid),
      threshold: 3,
      domain: bytesToHex(domain),
      expiryLag: 60,
      readFee: 0,
      adminPk: bytesToHex(adminPk),
      exit: Number(EXIT),
    },
    fixings: [{ expiry: EXPIRY, twap: PRICE.toString(), txid: "ab".repeat(32) }],
  };
  const parsed = parseOracleBeacon(status, DISPLAY, 0);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.beacon.address, beacon.address);
  const wrongBeacon = parseOracleBeacon({ ...status, issueTxid: "ff".repeat(32) }, DISPLAY, 0);
  const wrongAddress = parseOracleBeacon({ ...status, address: "not-an-address" }, DISPLAY, 0);
  assert.equal(wrongBeacon.ok, false);
  assert.equal(wrongAddress.ok, false);
  if (!wrongBeacon.ok) assert.equal(wrongBeacon.error, "oracle beacon");
  if (!wrongAddress.ok) assert.equal(wrongAddress.error, "oracle address");

  const announcement = {
    v: 1 as const,
    type: "option_position" as const,
    rfq_id: "aa".repeat(32),
    pair: PAIR,
    kind: 0 as const,
    collateral: COLLATERAL.toString(),
    strike: STRIKE.toString(),
    expiry: EXPIRY,
    exit: Number(EXIT),
    writer_pubkey: bytesToHex(writerPk),
    writer_pk_script: bytesToHex(bound.writerPkScript),
    holder_pubkey: bytesToHex(holderPk),
    beacon_txid: DISPLAY,
    beacon_gidx: 0,
    vault_address: bound.vaultAddress,
    fill_txid: vaultTx.id,
  };
  const announced = parsePosition(announcement);
  assert.ok(announced);
  assert.equal(parsePosition({ ...announcement, type: "rfq_quote" }), null);
  const published = positionFromAnnouncement(announced);
  assert.equal(published?.fillTxid, vaultTx.id);
  assert.equal(bindContracts(termsFor(published!, serverKey, emulatorKey)).vaultAddress, bound.vaultAddress);
  const env = {
    chain,
    serverKey,
    emulatorKey,
    emulator,
    checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT)),
    identity: key(22),
    fillTxid: vaultTx.id,
    terms,
    beacon: parsed.beacon,
    feeScript: payoutVtxo(holderPk, serverKey, EXIT),
  };

  const mismatch = await settleQuote({
    ...env,
    now: EXPIRY,
    terms: { ...terms, beacon: beaconIdOf(asset.AssetId.create("11".repeat(32), 0)) },
  });
  assert.deepEqual(mismatch, { result: "mismatch" });

  const early = await settleQuote({ ...env, now: EXPIRY - 1 });
  assert.deepEqual(early, { result: "waiting", reason: "early" });

  const refused = await settleQuote({
    ...env,
    now: EXPIRY,
    expected: { price: PRICE + 1n, time: terms.expiry },
  });
  assert.equal(refused.result, "rejected");
  assert.equal(submitted.length, 0);

  const settled = await settleQuote({ ...env, now: EXPIRY, expected: { price: PRICE, time: terms.expiry } });
  assert.equal(settled.result, "settled");
  if (settled.result !== "settled") return;
  assert.equal(submitted.length, 1);
  const tx = Transaction.fromPSBT(base64.decode(submitted[0]!));
  assert.equal(tx.inputsLength, 2);
  const vaultCheckpoint = Transaction.fromPSBT(base64.decode(checkpoints[0]![0]!));
  assert.equal(vaultCheckpoint.getInput(0).index, 1);
  const ph = holderPayoff(0, PRICE, STRIKE, COLLATERAL);
  const split = settlementOutputs(ph, COLLATERAL);
  assert.equal(tx.getOutput(0)?.amount, 330n);
  assert.equal(bytesToHex(tx.getOutput(0)!.script!), bytesToHex(beacon.pkScript));
  assert.equal(tx.getOutput(1)?.amount, split.holder);
  assert.equal(bytesToHex(tx.getOutput(1)!.script!), bytesToHex(bound.holderPkScript));
  assert.equal(tx.getOutput(2)?.amount, split.writer);
  assert.equal(bytesToHex(tx.getOutput(2)!.script!), bytesToHex(bound.writerPkScript));
  assert.deepEqual(statePacketOf(tx), fixed);

  const flat = nextState(genesisState(), terms.expiry, priceValue(STRIKE, terms.expiry));
  const flatTx = coinTx([{ script: beacon.pkScript, amount: 330n }], [statePacket(flat)]);
  coins[1] = { ...coins[1]!, txid: flatTx.id };
  prev.set(flatTx.id, base64.encode(flatTx.toPSBT()));
  const writerOnly = await settleQuote({ ...env, now: EXPIRY });
  assert.equal(writerOnly.result, "settled");
  const folded = Transaction.fromPSBT(base64.decode(submitted[1]!));
  assert.equal(folded.outputsLength, 4);
  assert.equal(folded.getOutput(1)?.amount, COLLATERAL);
  assert.equal(bytesToHex(folded.getOutput(1)!.script!), bytesToHex(bound.writerPkScript));

  const older = coinTx([{ script: beacon.pkScript, amount: 330n }], [statePacket(genesisState())]);
  coins.splice(1, 0, {
    txid: older.id,
    vout: 0,
    value: 330,
    script: bytesToHex(beacon.pkScript),
    assets: [{ assetId: assetId.toString(), amount: 1n }],
  });
  prev.set(older.id, base64.encode(older.toPSBT()));
  const fromLive = await settleQuote({ ...env, now: EXPIRY });
  assert.equal(fromLive.result, "settled");
  coins.splice(1, 1);

  const bare = coinTx([{ script: beacon.pkScript, amount: 330n }], [statePacket(genesisState())]);
  coins[1] = { ...coins[1]!, txid: bare.id };
  prev.set(bare.id, base64.encode(bare.toPSBT()));
  const unfixed = await settleQuote({ ...env, now: EXPIRY });
  assert.deepEqual(unfixed, { result: "unfixed" });

  const feeBeacon = bindBeacon({
    id,
    signers,
    threshold: 3n,
    domain,
    expiryLag: 60n,
    readFee: 1_000n,
    adminPk,
    exit: EXIT,
    serverKey,
    emulatorKey,
  });
  const feeState = coinTx([{ script: feeBeacon.pkScript, amount: 330n }], [statePacket(fixed)]);
  coins[1] = {
    txid: feeState.id,
    vout: 0,
    value: 330,
    script: bytesToHex(feeBeacon.pkScript),
    assets: [{ assetId: assetId.toString(), amount: 1n }],
  };
  prev.set(feeState.id, base64.encode(feeState.toPSBT()));
  const priced = parseOracleBeacon({
    ...status,
    address: feeBeacon.address,
    args: { ...status.args, readFee: 1_000 },
  }, DISPLAY, 0);
  assert.equal(priced.ok, true);
  if (!priced.ok) return;
  const feeTerms = { ...env.terms, readFee: 1_000n };
  const feeVault = bytesToHex(bindContracts(feeTerms).vaultPkScript);
  const vaultScript = coins[0]!.script;
  coins[0] = { ...coins[0]!, script: feeVault };
  const paid = await settleQuote({
    ...env,
    now: EXPIRY,
    terms: feeTerms,
    beacon: priced.beacon,
  });
  assert.equal(paid.result, "settled");
  if (paid.result !== "settled") return;
  const withFee = Transaction.fromPSBT(base64.decode(submitted.at(-1)!));
  assert.equal(withFee.inputsLength, 2);
  assert.equal(withFee.getOutput(0)?.amount, 1_330n);
  assert.equal(withFee.getOutput(2)?.amount, 18_400n);
  coins[0] = { ...coins[0]!, script: vaultScript };

  coins[0] = { ...coins[0]!, isSpent: true, spentBy: "ee".repeat(32), arkTxId: "ff".repeat(32) };
  const gone = await settleQuote({ ...env, now: EXPIRY });
  assert.deepEqual(gone, { result: "settled", txid: "ff".repeat(32) });

  coins[0] = { ...coins[0]!, isSpent: false, spentBy: "", arkTxId: undefined, isUnrolled: true, settledBy: "ab".repeat(32) };
  const rolled = await settleQuote({ ...env, now: EXPIRY });
  assert.deepEqual(rolled, { result: "settled", txid: "ab".repeat(32) });
});
