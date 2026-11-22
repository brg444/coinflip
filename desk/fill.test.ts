import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { asset, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import { BEACON_READ_FEE, EXIT } from "../protocol/constants.ts";
import { bindContracts, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import type { QuoteRow } from "./book.ts";
import { fillQuote, recoverFilled, selectFloat } from "./fill.ts";
import { BEACON_RATCHET_MARGIN_S, minCoinExpiry } from "./guards.ts";

const writer = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";
const intentScript = "51205327a5c6693c7f8f932418d934b5517509f3d01cc5a3a8f9e509503c15bcf5bd";
const fillB64 = readFileSync(fileURLToPath(new URL("../protocol/testdata/fill.b64", import.meta.url)), "utf8").trim();
const fillId = Transaction.fromPSBT(base64.decode(fillB64)).id;

test("recoverFilled classifies a spent intent via indexer history and fill.b64", async () => {
  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === writer) {
          assert.equal(filter.spentOnly, undefined);
          return { vtxos: [{ txid: fillId, value: 414 }] };
        }
        assert.equal(filter.spentOnly, true);
        assert.deepEqual(filter.scripts, [intentScript]);
        return {
          vtxos: [{
            value: 20_000,
            arkTxId: fillId,
            spentBy: fillId,
          }],
        };
      },
      async getVirtualTxs(ids: string[]) {
        assert.deepEqual(ids, [fillId]);
        return { txs: [fillB64] };
      },
    },
  };

  const txid = await recoverFilled(client as never, hexToBytes(writer), intentScript, {
    collateral: 20_000n,
    premium: 414n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
  });
  assert.equal(txid, fillId);
});

test("recoverFilled waits until the premium output exists as a vtxo", async () => {
  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === writer) return { vtxos: [] };
        return { vtxos: [{ value: 20_000, arkTxId: fillId, spentBy: fillId }] };
      },
      async getVirtualTxs() {
        return { txs: [fillB64] };
      },
    },
  };
  const txid = await recoverFilled(client as never, hexToBytes(writer), intentScript, {
    collateral: 20_000n,
    premium: 414n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
  });
  assert.equal(txid, undefined);
});

test("recoverFilled matches virtual txs by decoded PSBT txid even when indexer reorders results", async () => {
  const other = new Transaction({ version: 3 });
  other.addInput({ txid: new Uint8Array(32).fill(9), index: 0 });
  other.addOutput({ script: hexToBytes(writer), amount: 100n });
  const otherB64 = base64.encode(other.toPSBT());
  const otherId = other.id;

  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        if (filter.scripts?.[0] === writer) {
          return { vtxos: [{ txid: fillId, value: 414 }] };
        }
        return {
          vtxos: [
            { value: 20_000, arkTxId: otherId, spentBy: otherId },
            { value: 20_000, arkTxId: fillId, spentBy: fillId },
          ],
        };
      },
      async getVirtualTxs(ids: string[]) {
        assert.deepEqual(ids, [otherId, fillId]);
        // Return in reversed order from the request.
        return { txs: [fillB64, otherB64] };
      },
    },
  };

  const txid = await recoverFilled(client as never, hexToBytes(writer), intentScript, {
    collateral: 20_000n,
    premium: 414n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
  });
  assert.equal(txid, fillId);
});

test("selectFloat skips coins expiring before the required settlement margin", () => {
  const minExpiry = minCoinExpiry(1_700_000_000);
  const short = { txid: "aa".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry - 1) * 1000) };
  const long = { txid: "bb".repeat(32), vout: 0, value: 60_000, expiresAt: new Date(minExpiry * 1000) };
  const noExpiry = { txid: "cc".repeat(32), vout: 0, value: 50_000 };

  assert.deepEqual(selectFloat([short, long], 50_000n, minExpiry), [long]);
  assert.equal(selectFloat([short], 50_000n, minExpiry), null);
  assert.deepEqual(selectFloat([short, noExpiry], 50_000n, minExpiry), [noExpiry]);
});

async function predictFixture(expiry: number, deadline: number) {
  const serverKey = await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex("22".repeat(32)).compressedPublicKey();
  const deskPk = await SingleKey.fromHex("33".repeat(32)).xOnlyPublicKey();
  const bettorPk = await SingleKey.fromHex("44".repeat(32)).xOnlyPublicKey();
  const beaconTxid = "55".repeat(32);
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
    beacon: beaconIdOf(asset.AssetId.create(beaconTxid, 0)),
    readFee: BEACON_READ_FEE,
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
    beaconTxid,
    beaconGidx: 0,
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: deadline - 60,
    clientPubkey: bytesToHex(bettorPk),
  };
  return { terms, bound, deskScript, row };
}

test("fillQuote declines short-expiry intent coins and honors checkPredict verdicts", async () => {
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

  const deadBeacon = await fillQuote({
    client: mockClient([goodCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    beaconExpiry: 0,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((minExpiry + 600) * 1000) }],
  });
  assert.equal(deadBeacon.result, "declined");

  const liveBeacon = expiry + 86_400;
  const ratchetUser = await fillQuote({
    client: mockClient([goodCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    beaconExpiry: liveBeacon,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date(liveBeacon * 1000) }],
  });
  assert.equal(ratchetUser.result, "declined");

  const longCoin = { txid: "dd".repeat(32), vout: 0, value: 50_000, expiresAt: new Date((liveBeacon - BEACON_RATCHET_MARGIN_S) * 1000) };
  const ratchetFloat = await fillQuote({
    client: mockClient([longCoin]) as never,
    termsFor: () => terms,
    deskScript,
    row,
    now,
    beaconExpiry: liveBeacon,
    float: [{ txid: "bb".repeat(32), vout: 0, value: 100_000, expiresAt: new Date((liveBeacon - BEACON_RATCHET_MARGIN_S - 1) * 1000) }],
  });
  assert.equal(ratchetFloat.result, "short");
});
