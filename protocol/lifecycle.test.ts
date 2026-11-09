import assert from "node:assert/strict";
import test from "node:test";

import { base64 } from "@scure/base";
import {
  arkade,
  asset,
  buildOffchainTx,
  CSVMultisigTapscript,
  networks,
  SingleKey,
  Transaction,
  type ArkProvider,
  type ArkTxInput,
  type EmulatorProvider,
  type IndexerProvider,
} from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import type { QuoteRow } from "../desk/book.ts";
import { fillQuote } from "../desk/fill.ts";
import type { PendingArk } from "../desk/finalize.ts";
import { beaconIdOf, bindBeacon, genesisState, nextState, priceValue } from "./beacon.ts";
import { EXIT } from "./constants.ts";
import { bindContracts, payoutVtxo, type Terms } from "./contracts.ts";
import { buildSettle, submit } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { intentProgram, vaultProgram } from "./programs.ts";

// Mutinynet's signer and checkpoint closure. Connect needs both; arkd is not called.
const SERVER = "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a";
const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";

const collateral = 20_000n;
const premium = 1_000n;
const strike = 9_700_000n;
const price = 10_000_000n;

type Coin = {
  txid: string;
  vout: number;
  value: number;
  script: string;
  isSpent: boolean;
  spentBy: string;
};

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

function memory() {
  const coins: Coin[] = [];
  const pending: Coin[] = [];
  const pendingTxs: { arkTxid: string; signedCheckpointTxs: string[] }[] = [];
  const finalized: string[] = [];
  const prev = new Map<string, string>();
  const submitted: string[] = [];
  const indexer = {
    async getVtxos(filter: { scripts?: string[]; pendingOnly?: boolean }) {
      if (filter.pendingOnly) return { vtxos: pending };
      const wanted = new Set(filter.scripts ?? []);
      return { vtxos: coins.filter((coin) => wanted.has(coin.script) && !coin.isSpent) };
    },
    async getVirtualTxs(ids: string[]) {
      return {
        txs: ids.map((id) => {
          const psbt = prev.get(id);
          if (!psbt) throw new Error(`missing previous tx ${id}`);
          return psbt;
        }),
      };
    },
  };
  const emulator = {
    async getInfo() {
      return { signerPubkey: SERVER };
    },
    async submitTx(arkTx: string, checkpointTxs: string[]) {
      submitted.push(arkTx);
      const txid = Transaction.fromPSBT(base64.decode(arkTx)).id;
      prev.set(txid, arkTx);
      pendingTxs.splice(0, pendingTxs.length, { arkTxid: txid, signedCheckpointTxs: checkpointTxs });
      pending.splice(0, pending.length, {
        txid: "11".repeat(32),
        vout: 0,
        value: 1_000,
        script: "",
        isSpent: true,
        spentBy: txid,
      });
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
    },
    async submitIntent() {
      return "";
    },
    async submitFinalization() {
      return { signedForfeits: [] };
    },
    async submitOnchainTx(tx: string) {
      return { signedTx: tx };
    },
  };
  return { coins, pending, pendingTxs, finalized, prev, submitted, indexer, emulator };
}

function spendOutputs(psbt: string) {
  const tx = Transaction.fromPSBT(base64.decode(psbt));
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    outputs.push({ amount: out.amount ?? 0n, script: out.script ? bytesToHex(out.script) : "" });
  }
  return outputs;
}

test("a covered call locks, pays the writer, settles, and refunds a missed fill", async () => {
  const book = memory();
  const writer = key(1);
  const desk = key(2);
  const oracles = [3, 4, 5, 6, 7].map(key);
  const client = await arkade.Arkade.connect({
    arkade: {
      async getInfo() {
        return { signerPubkey: SERVER, checkpointTapscript: CHECKPOINT };
      },
      async submitTx() {
        throw new Error("arkd is not used");
      },
      async getPendingTxs() {
        return book.pendingTxs;
      },
      async finalizeTx(arkTxid: string) {
        book.finalized.push(arkTxid);
        book.pending.splice(0, book.pending.length);
        book.pendingTxs.splice(0, book.pendingTxs.length);
      },
    } as unknown as Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">,
    emulator: book.emulator as EmulatorProvider,
    indexer: book.indexer as Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    identity: desk,
    network: networks.mutinynet,
  });
  if (!client.emulatorKey) throw new Error("emulator key missing");

  const now = BigInt(Math.floor(Date.now() / 1000));
  const writerPk = await writer.xOnlyPublicKey();
  const holderPk = await desk.xOnlyPublicKey();
  const oraclePks = await Promise.all(oracles.map((item) => item.xOnlyPublicKey()));
  const displayTxid = "00".repeat(31) + "07";
  const beacon = beaconIdOf(asset.AssetId.create(displayTxid, 0));
  const shared = {
    kind: 0 as const,
    strike,
    collateral,
    premium,
    expiry: now + 86_400n,
    exit: EXIT,
    writerPk,
    payoutKey: writerPk,
    holderPk,
    beacon,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  };
  const terms: Terms = { ...shared, deadline: now + 600n };
  const bound = bindContracts(terms);
  assert.equal(bytesToHex(bound.writerPkScript), `5120${bytesToHex(writerPk)}`);
  const deskScript = payoutVtxo(holderPk, client.serverKey, EXIT);

  function place(script: Uint8Array, amount: bigint) {
    const { arkTx } = buildOffchainTx(
      [{
        txid: crypto.getRandomValues(new Uint8Array(32)),
        vout: 0,
        value: Number(amount),
        tapLeafScript: deskScript.forfeit(),
        tapTree: deskScript.encode(),
      } as unknown as ArkTxInput],
      [{ script, amount }],
      client.checkpoint,
    );
    book.prev.set(arkTx.id, base64.encode(arkTx.toPSBT()));
    const coin: Coin = {
      txid: arkTx.id,
      vout: 0,
      value: Number(amount),
      script: bytesToHex(script),
      isSpent: false,
      spentBy: "",
    };
    book.coins.push(coin);
    return coin;
  }

  const quote = (deadline: bigint) => ({
    collateral: collateral.toString(),
    premium: premium.toString(),
    deadline: Number(deadline),
  }) as QuoteRow;

  const waiting = await fillQuote({
    client,
    deskScript,
    row: quote(terms.deadline),
    now: Number(now),
    termsFor: () => terms,
  });
  assert.equal(waiting.result, "waiting");

  place(bound.intentPkScript, collateral);
  place(deskScript.pkScript, premium);
  const filled = await fillQuote({
    client,
    deskScript,
    row: quote(terms.deadline),
    now: Number(now),
    termsFor: () => terms,
    ark: client.arkProvider as unknown as PendingArk,
  });
  assert.equal(filled.result, "filled");
  assert.ok(filled.txid);
  assert.deepEqual(book.finalized, [filled.txid]);
  const fillTx = book.submitted.at(-1);
  assert.ok(fillTx);
  const paid = spendOutputs(fillTx);
  assert.equal(paid[0]?.amount, premium);
  assert.equal(paid[0]?.script, bytesToHex(bound.writerPkScript));
  assert.equal(paid[1]?.amount, collateral);
  assert.equal(paid[1]?.script, bytesToHex(bound.vaultPkScript));

  book.coins.push({
    txid: filled.txid,
    vout: 1,
    value: Number(collateral),
    script: bytesToHex(bound.vaultPkScript),
    isSpent: false,
    spentBy: "",
  });
  const vault = client.contract(vaultProgram(), bound.vault);
  const vaultCoin = (await vault.getUtxos())[0];
  assert.ok(vaultCoin);
  const ph = holderPayoff(0, price, strike, collateral);
  const split = settlementOutputs(ph, collateral);
  assert.equal(split.mode, "split");
  assert.equal(split.holder, 600n);
  assert.equal(split.writer, 19_400n);
  const beaconBound = bindBeacon({
    id: beacon,
    signers: [oraclePks[0]!],
    threshold: 1n,
    domain: new TextEncoder().encode("BTCUSD-FIX"),
    expiryLag: 0n,
    readFee: 0n,
    adminPk: oraclePks[0]!,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  });
  const fixed = nextState(genesisState(), terms.expiry, priceValue(price));
  const beaconTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  beaconTx.addInput({ txid: new Uint8Array(32), index: 1 });
  beaconTx.addOutput({ script: beaconBound.pkScript, amount: 330n });
  const fillParsed = Transaction.fromPSBT(base64.decode(fillTx));
  const vaultScript = new arkade.ArkadeProgramScript(vaultProgram(), bound.vault, {
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  });
  const built = buildSettle({
    vault: {
      script: vaultScript,
      coin: { txid: fillParsed.id, vout: 1, value: collateral, prevTx: fillParsed.toBytes(true, true) },
    },
    beacon: {
      script: beaconBound.script,
      coin: { txid: beaconTx.id, vout: 0, value: 330n, prevTx: beaconTx.toBytes(true, true) },
      state: fixed,
      id: asset.AssetId.create(displayTxid, 0),
    },
    readFee: 0n,
    payouts: [
      { script: bound.holderPkScript, amount: split.holder },
      { script: bound.writerPkScript, amount: split.writer },
    ],
    checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT)),
  });
  const settled = await submit(built, book.emulator as EmulatorProvider);
  assert.ok(settled.txid);
  const settledOut = spendOutputs(book.submitted.at(-1)!);
  assert.equal(settledOut[0]?.amount, 330n);
  assert.equal(settledOut[0]?.script, bytesToHex(beaconBound.pkScript));
  assert.equal(settledOut[1]?.amount, split.holder);
  assert.equal(settledOut[1]?.script, bytesToHex(bound.holderPkScript));
  assert.equal(settledOut[2]?.amount, split.writer);
  assert.equal(settledOut[2]?.script, bytesToHex(bound.writerPkScript));

  const late: Terms = { ...shared, deadline: now - 60n };
  const lateBound = bindContracts(late);
  place(lateBound.intentPkScript, collateral);
  const before = book.submitted.length;
  const expired = await fillQuote({
    client,
    deskScript,
    row: quote(late.deadline),
    now: Number(now),
    termsFor: () => late,
  });
  assert.equal(expired.result, "expired");
  assert.equal(book.submitted.length, before);
  const refundCoin = book.coins.find((coin) => coin.script === bytesToHex(lateBound.intentPkScript));
  assert.ok(refundCoin);
  const refund = await client.contract(intentProgram(), lateBound.intent).functions
    .cancel()
    .from(refundCoin)
    .to(lateBound.writerPkScript, collateral)
    .send();
  assert.ok(refund.txid);
  const refunded = spendOutputs(book.submitted.at(-1)!);
  assert.equal(refunded[0]?.amount, collateral);
  assert.equal(refunded[0]?.script, bytesToHex(lateBound.writerPkScript));
});
