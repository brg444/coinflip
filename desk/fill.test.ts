import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { EXIT } from "../protocol/constants.ts";
import { bindContracts, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import type { QuoteRow } from "./book.ts";
import { fillQuote, recoverFilled, selectFloat } from "./fill.ts";
import { minCoinExpiry } from "./guards.ts";

const bettorScript = "5120" + "11".repeat(32);
const deskScriptHex = "5120" + "22".repeat(32);
const vaultScript = "5120" + "33".repeat(32);
const intentScript = "5120" + "44".repeat(32);

function predictFillPsbt() {
  const tx = new Transaction({ version: 3 });
  tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
  tx.addInput({ txid: new Uint8Array(32).fill(2), index: 0 });
  tx.addOutput({ script: hexToBytes(deskScriptHex), amount: 50_000n });
  tx.addOutput({ script: hexToBytes(vaultScript), amount: 95_000n });
  return { id: tx.id, b64: base64.encode(tx.toPSBT()) };
}

test("recoverFilled classifies a spent Predict intent via indexer history and vault output", async () => {
  const fill = predictFillPsbt();
  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === vaultScript) {
          assert.equal(filter.spentOnly, undefined);
          return { vtxos: [{ txid: fill.id, value: 95_000 }] };
        }
        assert.equal(filter.spentOnly, true);
        assert.deepEqual(filter.scripts, [intentScript]);
        return {
          vtxos: [{
            value: 50_000,
            arkTxId: fill.id,
            spentBy: fill.id,
          }],
        };
      },
      async getVirtualTxs(ids: string[]) {
        assert.deepEqual(ids, [fill.id]);
        return { txs: [fill.b64] };
      },
    },
  };

  const txid = await recoverFilled(client as never, hexToBytes(bettorScript), intentScript, {
    collateral: 95_000n,
    premium: 50_000n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
    vaultScript,
  });
  assert.equal(txid, fill.id);
});

test("recoverFilled waits until the vault output exists as a vtxo", async () => {
  const fill = predictFillPsbt();
  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === vaultScript) return { vtxos: [] };
        return { vtxos: [{ value: 50_000, arkTxId: fill.id, spentBy: fill.id }] };
      },
      async getVirtualTxs() {
        return { txs: [fill.b64] };
      },
    },
  };
  const txid = await recoverFilled(client as never, hexToBytes(bettorScript), intentScript, {
    collateral: 95_000n,
    premium: 50_000n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
    vaultScript,
  });
  assert.equal(txid, undefined);
});

test("recoverFilled matches virtual txs by decoded PSBT txid even when indexer reorders results", async () => {
  const fill = predictFillPsbt();
  const other = new Transaction({ version: 3 });
  other.addInput({ txid: new Uint8Array(32).fill(9), index: 0 });
  other.addOutput({ script: hexToBytes(bettorScript), amount: 50_000n });
  const otherB64 = base64.encode(other.toPSBT());
  const otherId = other.id;

  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === vaultScript) {
          return { vtxos: [{ txid: fill.id, value: 95_000 }] };
        }
        return {
          vtxos: [
            { value: 50_000, arkTxId: otherId, spentBy: otherId },
            { value: 50_000, arkTxId: fill.id, spentBy: fill.id },
          ],
        };
      },
      async getVirtualTxs(ids: string[]) {
        assert.deepEqual(ids, [otherId, fill.id]);
        return { txs: [fill.b64, otherB64] };
      },
    },
  };

  const txid = await recoverFilled(client as never, hexToBytes(bettorScript), intentScript, {
    collateral: 95_000n,
    premium: 50_000n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
    vaultScript,
  });
  assert.equal(txid, fill.id);
});

test("selectFloat skips coins expiring before the required settlement margin", () => {
  const minExpiry = minCoinExpiry(1_700_000_000);
  const short = { txid: "aa".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry - 1) * 1000) };
  const long = { txid: "bb".repeat(32), vout: 0, value: 60_000, expiresAt: new Date(minExpiry * 1000) };
  const noExpiry = { txid: "cc".repeat(32), vout: 0, value: 50_000 };

  assert.deepEqual(selectFloat([short, long], 50_000n, minExpiry), [long]);
  assert.equal(selectFloat([short], 50_000n, minExpiry), null);
  assert.deepEqual(selectFloat([short, noExpiry], 50_000n, minExpiry), [noExpiry]);

  // SEC-09: prefers a single fitting coin over combining many small coins, picks largest-first, and enforces maxInputs.
  const tiny = Array.from({ length: 10 }, (_, i) => ({ txid: i.toString(16).padStart(64, "0"), vout: 0, value: 10_000 }));
  const medium = { txid: "dd".repeat(32), vout: 0, value: 95_000 };
  const huge = { txid: "ee".repeat(32), vout: 0, value: 500_000 };
  assert.deepEqual(selectFloat([...tiny, huge, medium], 90_000n), [medium]);

  // Largest-first combination fits within maxInputs instead of failing on small coins first.
  const mixed = [...tiny, { txid: "f1".repeat(32), vout: 0, value: 60_000 }, { txid: "f2".repeat(32), vout: 0, value: 50_000 }];
  const combined = selectFloat(mixed, 105_000n, undefined, { maxInputs: 2 });
  assert.equal(combined?.length, 2);
  assert.equal(combined!.reduce((s, c) => s + c.value, 0), 110_000);
  // Fragmented coins that exceed maxInputs return null instead of exceeding tx weight.
  assert.equal(selectFloat(tiny, 50_000n, undefined, { maxInputs: 4 }), null);

  // Predict fills merge desk change with user stake on output 0, so small change (<= 330 sats) does not add extra inputs.
  const nearExact = { txid: "aa".repeat(32), vout: 0, value: 95_100 };
  const extra = { txid: "bb".repeat(32), vout: 0, value: 20_000 };
  assert.deepEqual(selectFloat([nearExact, extra], 95_000n, undefined, { allowSmallChange: true }), [nearExact]);
  assert.equal(selectFloat([nearExact, extra], 95_000n, undefined, { allowSmallChange: false })?.length, 2);
});

async function predictFixture(expiry: number, deadline: number) {
  const serverKey = await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex("22".repeat(32)).compressedPublicKey();
  const deskPk = await SingleKey.fromHex("33".repeat(32)).xOnlyPublicKey();
  const bettorPk = await SingleKey.fromHex("44".repeat(32)).xOnlyPublicKey();
  const oraclePk = await SingleKey.fromHex("55".repeat(32)).xOnlyPublicKey();
  const terms: Terms = {
    kind: 2,
    strike: 9_000_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: BigInt(expiry),
    deadline: BigInt(deadline),
    exit: EXIT,
    writerPk: deskPk,
    holderPk: bettorPk,
    holderPayoutKey: bettorPk,
    oraclePk,
    serverKey,
    emulatorKey,
  };
  const bound = bindContracts(terms);
  const deskScript = payoutVtxo(deskPk, serverKey, EXIT);
  const row: QuoteRow = {
    rfqId: "66".repeat(32),
    collateral: "95000",
    premium: "50000",
    kind: 2,
    strike: "9000000",
    expiry,
    deadline,
    validUntil: deadline,
    exit: Number(EXIT),
    writerPubkey: bytesToHex(deskPk),
    writerPkScript: bytesToHex(bound.writerPkScript),
    holderPubkey: bytesToHex(bettorPk),
    holderPkScript: bytesToHex(bound.holderPkScript),
    oraclePubkey: bytesToHex(oraclePk),
    backupPubkey: bytesToHex(emulatorKey.subarray(1)),
    voidAfter: 86_400,
    fallbackDelay: 22_016,
    finalExitDelay: 108_032,
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: deadline - 60,
    clientPubkey: bytesToHex(bettorPk),
  };
  return { terms, bound, deskScript, row };
}

test("fillQuote declines short-expiry intent coins, honors checkPredict, and rejects short float", async () => {
  const now = 1_700_000_000;
  const expiry = now + 300;
  const deadline = now + 60;
  const minExpiry = minCoinExpiry(expiry);
  const { terms, bound, deskScript, row } = await predictFixture(expiry, deadline);
  const mockClient = (utxos: { txid: string; vout: number; value: number; expiresAt?: Date }[]) => ({
    contract: () => ({
      pkScript: bound.intentPkScript,
      getUtxos: async () => utxos,
      functions: {
        finalize() {
          throw new Error("should not finalize");
        },
      },
    }),
    indexer: {
      getVtxos: async () => ({ vtxos: [] }),
      getVirtualTxs: async () => ({ txs: [] }),
    },
  });

  const shortCoin = { txid: "aa".repeat(32), vout: 0, value: 50_000, expiresAt: new Date((minExpiry - 10) * 1000) };
  const declinedShort = await fillQuote({
    client: mockClient([shortCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry + 600) * 1000) }],
  });
  assert.equal(declinedShort.result, "declined");
  assert.equal(declinedShort.reason, "coin_expiry");

  const goodCoin = { txid: "cc".repeat(32), vout: 0, value: 50_000, expiresAt: new Date((minExpiry + 600) * 1000) };
  const declinedPrice = await fillQuote({
    client: mockClient([goodCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry + 600) * 1000) }],
    checkPredict: async () => "decline",
  });
  assert.equal(declinedPrice.result, "declined");
  assert.equal(declinedPrice.reason, "price_moved");

  const retryPrice = await fillQuote({
    client: mockClient([goodCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry + 600) * 1000) }],
    checkPredict: async () => "retry",
  });
  assert.equal(retryPrice.result, "waiting");

  const shortFloat = await fillQuote({
    client: mockClient([goodCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry - 1) * 1000) }],
    checkPredict: async () => "allow",
  });
  assert.equal(shortFloat.result, "short");
});
