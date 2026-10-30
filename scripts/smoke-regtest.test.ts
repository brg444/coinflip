import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  arkade,
  asset,
  REGTEST_EMULATOR_PUBKEY,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { beaconIdOf, bindBeacon } from "../protocol/beacon.ts";
import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { BEACON_READ_FEE, DUST_SATS, EXIT, Q_MIN } from "../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { intentProgram, predictVaultProgram, vaultProgram } from "../protocol/programs.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { createOracle } from "../oracle/service.ts";
import { parseOracleBeacon } from "../settle/oracle.ts";
import { settleQuote } from "../settle/vault.ts";

/**
 * Option covenant on a local arkade-regtest stack (bitcoin regtest + arkd + emulator).
 *
 *   pnpm smoke:regtest
 *
 * Clones arkade-regtest if needed, starts it with `.env.regtest` (2048s exit, zero
 * intent fees), and runs the option the contracts actually settle:
 * the oracle service issues and deploys the beacon, the ark client funds two
 * intents and the desk, one intent is finalized, the other is cancelled, then
 * the oracle publishes the strike and the vault settles. Fails unless the
 * beacon is deployed and the strike settlement outputs land.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = "e639c8de978c7978944a3b7356a2060f91403036";
const ARK = process.env.ARK_URL?.trim() || "http://127.0.0.1:7070";
const EMULATOR = process.env.EMULATOR_URL?.trim() || "http://127.0.0.1:7073";
const PASSWORD = process.env.ARKD_PASSWORD?.trim() || "secret";
const ADMIN = "regtest-admin";

const collateral = 50_000n;
const premium = 1_000n;
const strike = 9_700_000n;
/** Sats the seeded ark client sends the oracle. `issue` keeps this coin; deploy pays `DUST_SATS` to the beacon. */
const oracleFunding = Q_MIN;

type Info = {
  network?: string;
  unilateralExitDelay?: string | number;
  fees?: {
    intentFee?: Record<string, string>;
    txFeeRate?: string;
  };
};

type Coin = { txid: string; vout: number; value: number };

test("option intent fills, cancels, and settles at the strike on local arkade regtest", async () => {
  const regtestDir = ensureCheckout();
  await ensureStack(regtestDir);

  const writer = SingleKey.fromHex("1".padStart(64, "0"));
  const desk = SingleKey.fromHex("2".padStart(64, "0"));
  const oracleSecret = "3".padStart(64, "0");
  const oracleKey = SingleKey.fromHex(oracleSecret);
  const network = networkByName("regtest");
  const indexer = new RestIndexerProvider(ARK);
  const emulator = new RestEmulatorProvider(EMULATOR);
  const connect = (identity: SingleKey) => arkade.Arkade.connect({
    arkade: new RestArkProvider(ARK),
    indexer,
    emulator,
    identity,
    network,
  });
  const writerClient = await connect(writer);
  const deskClient = await connect(desk);
  assert.equal(bytesToHex(writerClient.emulatorKey!), REGTEST_EMULATOR_PUBKEY);
  await assertServerExit(ARK);

  const dataDir = await mkdtemp(path.join(tmpdir(), "arkade-options-oracle-"));
  const storage = await openSqliteStorage(dataDir, "oracle.sqlite");
  const wallet = await Wallet.create({
    identity: oracleKey,
    arkServerUrl: ARK,
    indexerUrl: ARK,
    settlementConfig: false,
    storage: {
      walletRepository: storage.walletRepository,
      contractRepository: storage.contractRepository,
    },
  });
  const oracle = await createOracle({
    dataDir,
    adminToken: ADMIN,
    oracleKey: hexToBytes(oracleSecret),
    emulatorKey: writerClient.emulatorKey!,
    wallet,
    indexer,
    emulator,
  });
  try {
    const oracleAddress = await wallet.getAddress();
    console.log("oracle", oracleAddress);
    arkSend(regtestDir, [{ to: oracleAddress, amount: Number(oracleFunding) }]);
    await waitFor(async () => (await wallet.getVtxos()).some((coin) => !coin.isSpent && BigInt(coin.value) >= oracleFunding), "oracle wallet");

    const issued = await oracleCall(oracle.url, "/api/issue", {});
    assert.match(String(issued.json.txid ?? ""), /^[0-9a-f]{64}$/, `issue ${JSON.stringify(issued.json)}`);
    let deployed: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const response = await oracleCall(oracle.url, "/api/deploy", {}, true);
      if (response.status === 200) {
        deployed = response.json;
        break;
      }
      console.log("deploy", response.json.error ?? response.status, `(${attempt})`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(deployed, "beacon was not deployed");
    const status = (await oracleCall(oracle.url, "/api/status")).json;
    const parsed = parseOracleBeacon(status);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    if (!parsed.ok) return;
    assert.match(String(status.deployTxid ?? ""), /^[0-9a-f]{64}$/);
    assert.equal(parsed.beacon.readFee, BEACON_READ_FEE);
    assert.equal(parsed.beacon.exit, EXIT);
    const beaconScript = bytesToHex(bindBeacon({
      id: beaconIdOf(asset.AssetId.fromString(parsed.beacon.assetId)),
      signers: parsed.beacon.signers,
      threshold: parsed.beacon.threshold,
      domain: parsed.beacon.domain,
      keyLag: parsed.beacon.keyLag,
      readFee: parsed.beacon.readFee,
      adminPk: parsed.beacon.adminPk,
      exit: parsed.beacon.exit,
      serverKey: wallet.arkServerPublicKey,
      emulatorKey: writerClient.emulatorKey!,
    }).pkScript);
    await waitFor(async () => {
      const page = await indexer.getVtxos({ scripts: [beaconScript], spendableOnly: true });
      return (page.vtxos ?? []).some((coin) => BigInt(coin.value) === DUST_SATS && holdsUnit(coin, parsed.beacon.assetId));
    }, "beacon coin");
    console.log("beacon", parsed.beacon.assetId, status.deployTxid);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const expiry = now + 120n;
    const writerPk = await writer.xOnlyPublicKey();
    const holderPk = await desk.xOnlyPublicKey();
    const beacon = beaconIdOf(asset.AssetId.fromString(parsed.beacon.assetId));
    const shared = {
      kind: 0 as const,
      strike,
      collateral,
      premium,
      expiry,
      exit: EXIT,
      writerPk,
      holderPk,
      beacon,
      readFee: BEACON_READ_FEE,
      serverKey: writerClient.serverKey,
      emulatorKey: writerClient.emulatorKey!,
    };
    const fill = bindContracts({ ...shared, deadline: now + 3_600n });
    const cancel = bindContracts({ ...shared, deadline: now + 45n });
    const deskScript = payoutVtxo(holderPk, deskClient.serverKey, EXIT);
    const deskAddress = deskScript.address(network.hrp, deskClient.serverKey).encode();
    console.log("fill intent", fill.intentAddress);
    console.log("cancel intent", cancel.intentAddress);
    console.log("desk", deskAddress);

    arkSend(regtestDir, [
      { to: fill.intentAddress, amount: Number(collateral) },
      { to: cancel.intentAddress, amount: Number(collateral) },
      { to: deskAddress, amount: Number(premium) },
    ]);

    const fillIntent = deskClient.contract(intentProgram(), fill.intent);
    const cancelIntent = writerClient.contract(intentProgram(), cancel.intent);
    await waitFor(async () => (await fillIntent.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "fill intent");
    await waitFor(async () => (await cancelIntent.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "cancel intent");
    await waitFor(async () => (await scriptCoins(indexer, deskScript.pkScript)).some((coin) => BigInt(coin.value) >= premium), "desk float");

    const writerBefore = ids(await scriptCoins(indexer, fill.writerPkScript));
    const row = quoteRow(fill, now, Number(now + 3_600n), writerPk, holderPk, String(status.issueTxid));
    const filled = await fillQuote({
      client: deskClient,
      deskScript,
      row,
      now: Number(now),
      ark: deskClient.arkProvider as RestArkProvider,
      termsFor: () => ({ ...shared, deadline: now + 3_600n }),
    });
    console.log("finalize", filled.result, filled.txid ?? "");
    assert.equal(filled.result, "filled", `finalize ${filled.result}`);
    assert.match(filled.txid ?? "", /^[0-9a-f]{64}$/);

    const vault = deskClient.contract(vaultProgram(), fill.vault);
    await waitFor(async () => (await vault.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "vault");
    await waitFor(async () => fresh(await scriptCoins(indexer, fill.writerPkScript), writerBefore, premium), "premium");

    const cancelCoin = (await cancelIntent.getUtxos()).find((coin) => BigInt(coin.value) >= collateral);
    assert.ok(cancelCoin, "cancel coin missing");
    await sleepUntil(Number(cancel.intent.deadline) + 2, "cancel");
    const writerAtCancel = ids(await scriptCoins(indexer, cancel.writerPkScript));
    const sent = await writerClient.contract(intentProgram(), cancel.intent).functions
      .cancel()
      .from(cancelCoin)
      .to(cancel.writerPkScript, BigInt(cancelCoin.value))
      .send();
    console.log("cancel", sent.txid);
    assert.match(sent.txid, /^[0-9a-f]{64}$/);
    assert.notEqual(sent.txid, filled.txid);
    await waitFor(
      async () => fresh(await scriptCoins(indexer, cancel.writerPkScript), writerAtCancel, collateral),
      "cancel refund",
    );

    const keyLag = Number(parsed.beacon.keyLag);
    await sleepUntil(Number(expiry), "sample");
    if (Math.floor(Date.now() / 1000) > Number(expiry) + keyLag) {
      throw new Error("missed the publish window");
    }
    const sample = (await oracleCall(oracle.url, "/api/samples", { price: strike.toString() })).json;
    assert.equal(sample.price, strike.toString(), `sample ${JSON.stringify(sample)}`);
    await sleepUntil(Number(expiry) + keyLag, "publish");
    const published = (await oracleCall(oracle.url, "/api/publish", { expiry: Number(expiry) })).json;
    console.log("publish", published.txid, published.price);
    assert.equal(published.price, strike.toString());
    assert.match(String(published.txid ?? ""), /^[0-9a-f]{64}$/);

    await waitFor(async () => {
      const page = await indexer.getVtxos({ scripts: [beaconScript], spendableOnly: true });
      return (page.vtxos ?? []).some((coin) => holdsUnit(coin, parsed.beacon.assetId) && BigInt(coin.value) === DUST_SATS);
    }, "beacon after publish");

    let settled: Awaited<ReturnType<typeof settleQuote>> | undefined;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      settled = await settleQuote({
        chain: indexer,
        serverKey: writerClient.serverKey,
        emulatorKey: writerClient.emulatorKey!,
        emulator,
        checkpoint: deskClient.checkpoint,
        fillTxid: filled.txid,
        terms: { ...shared, deadline: now + 3_600n },
        beacon: parsed.beacon,
        now: Math.floor(Date.now() / 1000),
      });
      console.log("settle", settled.result, "txid" in settled ? settled.txid : "", `(${attempt})`);
      if (settled.result === "settled" && settled.price != null) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(settled && settled.result === "settled" && settled.price != null, `settle ${settled?.result}`);
    if (!settled || settled.result !== "settled" || settled.price == null) return;
    assert.equal(settled.price, strike);
    assert.equal(settled.holder, 0n);
    assert.equal(settled.writer, collateral - BEACON_READ_FEE);
    assert.match(settled.txid, /^[0-9a-f]{64}$/);

    const writerSats = settled.writer ?? 0n;
    await waitFor(async () => {
      const coins = await scriptCoins(indexer, fill.writerPkScript);
      return coins.some((coin) => BigInt(coin.value) === writerSats);
    }, "settlement writer");
    await waitFor(async () => {
      const page = await indexer.getVtxos({ scripts: [beaconScript], spendableOnly: true });
      return (page.vtxos ?? []).some((coin) => holdsUnit(coin, parsed.beacon.assetId) && BigInt(coin.value) === DUST_SATS + BEACON_READ_FEE);
    }, "beacon after read");
    await waitFor(async () => (await vault.getUtxos()).length === 0, "vault spent");
    console.log("settled", settled.txid, "writer", settled.writer.toString(), "holder", settled.holder?.toString());
  } finally {
    await oracle.close();
    await wallet.dispose();
    storage.db.close();
  }
});

/**
 * Predict on the same stack: the bettor holds and pays the stake (OptionIntent
 * side 1), the desk writes and funds the payout into a PredictVault from its
 * float, the oracle publishes a close above the line, and the vault pays the
 * bettor's own address. A second stake that the desk never fills is cancelled
 * back to the bettor after its deadline.
 */
test("a prediction fills from the desk float, pays the bettor above the line, and an unfilled stake refunds", async () => {
  const regtestDir = ensureCheckout();
  await ensureStack(regtestDir);

  const bettor = SingleKey.fromHex("4".padStart(64, "0"));
  const desk = SingleKey.fromHex("5".padStart(64, "0"));
  const oracleSecret = "6".padStart(64, "0");
  const network = networkByName("regtest");
  const indexer = new RestIndexerProvider(ARK);
  const emulator = new RestEmulatorProvider(EMULATOR);
  const connect = (identity: SingleKey) => arkade.Arkade.connect({
    arkade: new RestArkProvider(ARK),
    indexer,
    emulator,
    identity,
    network,
  });
  const bettorClient = await connect(bettor);
  const deskClient = await connect(desk);
  const booted = await bootOracle(regtestDir, oracleSecret, indexer, emulator, bettorClient.emulatorKey!);
  const { oracle, wallet, storage, parsed, issueTxid, beaconScript } = booted;
  try {
    const line = 9_700_000n;
    const stake = 20_000n;
    const payout = 38_000n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expiry = now + 150n;
    const serverKey = deskClient.serverKey;
    const deskPk = await desk.xOnlyPublicKey();
    // The page pays the bettor at the taproot key of their own Arkade address.
    const bettorVtxo = payoutVtxo(await bettor.xOnlyPublicKey(), serverKey, EXIT);
    const bettorKey = bettorVtxo.tweakedPublicKey;
    const beacon = beaconIdOf(asset.AssetId.fromString(parsed.beacon.assetId));
    const shared = {
      kind: 2 as const,
      strike: line,
      collateral: payout,
      premium: stake,
      expiry,
      exit: EXIT,
      writerPk: deskPk,
      holderPk: bettorKey,
      holderPayoutKey: bettorKey,
      beacon,
      readFee: BEACON_READ_FEE,
      serverKey,
      emulatorKey: bettorClient.emulatorKey!,
    };
    const fill = bindContracts({ ...shared, deadline: now + 3_600n });
    const cancel = bindContracts({ ...shared, deadline: now + 45n });
    const deskScript = payoutVtxo(deskPk, serverKey, EXIT);
    assert.equal(bytesToHex(fill.writerPkScript), bytesToHex(deskScript.pkScript));
    assert.equal(bytesToHex(fill.holderPkScript), bytesToHex(bettorVtxo.pkScript));
    const deskAddress = deskScript.address(network.hrp, serverKey).encode();
    console.log("predict intent", fill.intentAddress);
    console.log("predict vault", fill.vaultAddress);

    arkSend(regtestDir, [
      { to: fill.intentAddress, amount: Number(stake) },
      { to: cancel.intentAddress, amount: Number(stake) },
      { to: deskAddress, amount: Number(payout) },
    ]);
    const fillIntent = deskClient.contract(intentProgram(), fill.intent);
    const cancelIntent = bettorClient.contract(intentProgram(), cancel.intent);
    await waitFor(async () => (await fillIntent.getUtxos()).some((coin) => BigInt(coin.value) >= stake), "stake");
    await waitFor(async () => (await cancelIntent.getUtxos()).some((coin) => BigInt(coin.value) >= stake), "unfilled stake");
    await waitFor(async () => (await scriptCoins(indexer, deskScript.pkScript)).some((coin) => BigInt(coin.value) >= payout), "desk float");

    const deskBefore = ids(await scriptCoins(indexer, deskScript.pkScript));
    const row: QuoteRow = {
      ...quoteRow(fill, now, Number(now + 3_600n), deskPk, bettorKey, issueTxid),
      collateral: payout.toString(),
      premium: stake.toString(),
      kind: 2,
      strike: line.toString(),
      expiry: Number(expiry),
      writerPkScript: bytesToHex(fill.writerPkScript),
      holderPkScript: bytesToHex(fill.holderPkScript),
    };
    const filled = await fillQuote({
      client: deskClient,
      deskScript,
      row,
      now: Number(now),
      ark: deskClient.arkProvider as RestArkProvider,
      termsFor: () => ({ ...shared, deadline: now + 3_600n }),
    });
    console.log("predict finalize", filled.result, filled.txid ?? "");
    assert.equal(filled.result, "filled", `finalize ${filled.result}`);
    const vault = deskClient.contract(predictVaultProgram(), fill.vault);
    await waitFor(async () => (await vault.getUtxos()).some((coin) => BigInt(coin.value) === payout), "predict vault");
    await waitFor(async () => fresh(await scriptCoins(indexer, deskScript.pkScript), deskBefore, stake), "stake to the desk");

    const cancelCoin = (await cancelIntent.getUtxos()).find((coin) => BigInt(coin.value) >= stake);
    assert.ok(cancelCoin, "unfilled stake missing");
    await sleepUntil(Number(cancel.intent.deadline) + 2, "refund");
    const bettorAtCancel = ids(await scriptCoins(indexer, cancel.userPkScript));
    const refunded = await bettorClient.contract(intentProgram(), cancel.intent).functions
      .cancel()
      .from(cancelCoin)
      .to(cancel.userPkScript, BigInt(cancelCoin.value))
      .send();
    console.log("predict refund", refunded.txid);
    await waitFor(async () => fresh(await scriptCoins(indexer, cancel.userPkScript), bettorAtCancel, stake), "refund");

    const keyLag = Number(parsed.beacon.keyLag);
    await sleepUntil(Number(expiry), "predict sample");
    const above = line + 3_710n;
    const sample = (await oracleCall(oracle.url, "/api/samples", { price: above.toString() })).json;
    assert.equal(sample.price, above.toString(), `sample ${JSON.stringify(sample)}`);
    await sleepUntil(Number(expiry) + keyLag, "predict publish");
    const published = (await oracleCall(oracle.url, "/api/publish", { expiry: Number(expiry) })).json;
    console.log("predict publish", published.txid, published.price);
    assert.equal(published.price, above.toString());
    await waitFor(async () => {
      const page = await indexer.getVtxos({ scripts: [beaconScript], spendableOnly: true });
      return (page.vtxos ?? []).some((coin) => holdsUnit(coin, parsed.beacon.assetId) && BigInt(coin.value) === DUST_SATS);
    }, "beacon after predict publish");

    const bettorBefore = ids(await scriptCoins(indexer, fill.holderPkScript));
    let settled: Awaited<ReturnType<typeof settleQuote>> | undefined;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      settled = await settleQuote({
        chain: indexer,
        serverKey,
        emulatorKey: bettorClient.emulatorKey!,
        emulator,
        checkpoint: deskClient.checkpoint,
        fillTxid: filled.txid,
        terms: { ...shared, deadline: now + 3_600n },
        beacon: parsed.beacon,
        now: Math.floor(Date.now() / 1000),
      });
      console.log("predict settle", settled.result, "txid" in settled ? settled.txid : "", `(${attempt})`);
      if (settled.result === "settled" && settled.price != null) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(settled && settled.result === "settled" && settled.price != null, `settle ${settled?.result}`);
    if (!settled || settled.result !== "settled" || settled.price == null) return;
    assert.equal(settled.price, above);
    assert.equal(settled.holder, payout - BEACON_READ_FEE);
    assert.equal(settled.writer, 0n);
    await waitFor(
      async () => fresh(await scriptCoins(indexer, fill.holderPkScript), bettorBefore, payout - BEACON_READ_FEE),
      "payout to the bettor",
    );
    await waitFor(async () => (await vault.getUtxos()).length === 0, "predict vault spent");
    console.log("predict settled", settled.txid, "bettor", settled.holder?.toString());
  } finally {
    await oracle.close();
    await wallet.dispose();
    storage.db.close();
  }
});

/** A fresh oracle with its own beacon, issued and deployed on the regtest stack. */
async function bootOracle(
  regtestDir: string,
  oracleSecret: string,
  indexer: RestIndexerProvider,
  emulator: RestEmulatorProvider,
  emulatorKey: Uint8Array,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "arkade-options-oracle-"));
  const storage = await openSqliteStorage(dataDir, "oracle.sqlite");
  const wallet = await Wallet.create({
    identity: SingleKey.fromHex(oracleSecret),
    arkServerUrl: ARK,
    indexerUrl: ARK,
    settlementConfig: false,
    storage: {
      walletRepository: storage.walletRepository,
      contractRepository: storage.contractRepository,
    },
  });
  const oracle = await createOracle({
    dataDir,
    adminToken: ADMIN,
    oracleKey: hexToBytes(oracleSecret),
    emulatorKey,
    wallet,
    indexer,
    emulator,
  });
  const oracleAddress = await wallet.getAddress();
  arkSend(regtestDir, [{ to: oracleAddress, amount: Number(oracleFunding) }]);
  await waitFor(async () => (await wallet.getVtxos()).some((coin) => !coin.isSpent && BigInt(coin.value) >= oracleFunding), "oracle wallet");
  const issued = await oracleCall(oracle.url, "/api/issue", {});
  assert.match(String(issued.json.txid ?? ""), /^[0-9a-f]{64}$/, `issue ${JSON.stringify(issued.json)}`);
  let deployed = false;
  for (let attempt = 1; attempt <= 15 && !deployed; attempt += 1) {
    const response = await oracleCall(oracle.url, "/api/deploy", {}, true);
    deployed = response.status === 200;
    if (!deployed) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert.ok(deployed, "beacon was not deployed");
  const status = (await oracleCall(oracle.url, "/api/status")).json;
  const parsed = parseOracleBeacon(status);
  if (!parsed.ok) throw new Error(parsed.error);
  const beaconScript = bytesToHex(bindBeacon({
    id: beaconIdOf(asset.AssetId.fromString(parsed.beacon.assetId)),
    signers: parsed.beacon.signers,
    threshold: parsed.beacon.threshold,
    domain: parsed.beacon.domain,
    keyLag: parsed.beacon.keyLag,
    readFee: parsed.beacon.readFee,
    adminPk: parsed.beacon.adminPk,
    exit: parsed.beacon.exit,
    serverKey: wallet.arkServerPublicKey,
    emulatorKey,
  }).pkScript);
  await waitFor(async () => {
    const page = await indexer.getVtxos({ scripts: [beaconScript], spendableOnly: true });
    return (page.vtxos ?? []).some((coin) => BigInt(coin.value) === DUST_SATS && holdsUnit(coin, parsed.beacon.assetId));
  }, "beacon coin");
  return { oracle, wallet, storage, parsed, issueTxid: String(status.issueTxid), beaconScript };
}

function quoteRow(
  bound: ReturnType<typeof bindContracts>,
  now: bigint,
  deadline: number,
  writerPk: Uint8Array,
  holderPk: Uint8Array,
  beaconTxid: string,
): QuoteRow {
  return {
    rfqId: "11".repeat(32),
    collateral: collateral.toString(),
    premium: premium.toString(),
    kind: 0,
    strike: strike.toString(),
    expiry: Number(now + 120n),
    deadline,
    validUntil: Number(now + 30n),
    exit: Number(EXIT),
    writerPubkey: bytesToHex(writerPk),
    writerPkScript: bytesToHex(bound.writerPkScript),
    holderPubkey: bytesToHex(holderPk),
    beaconTxid,
    beaconGidx: 0,
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: Number(now),
    clientPubkey: bytesToHex(writerPk),
  };
}

async function oracleCall(url: string, pathName: string, body?: unknown, allowError = false): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url + pathName, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!allowError && !res.ok) throw new Error(`${pathName} ${res.status} ${text}`);
  return { status: res.status, json };
}

function holdsUnit(coin: { assets?: readonly { assetId?: string; amount?: bigint | number }[] }, assetId: string): boolean {
  const want = assetId.toLowerCase();
  return (coin.assets ?? []).some((item) => (item.assetId ?? "").toLowerCase() === want && BigInt(item.amount ?? 0) === 1n);
}

async function sleepUntil(unix: number, label: string) {
  const ms = unix * 1000 - Date.now() + 1_000;
  if (ms <= 0) return;
  console.log(label, `waits ${Math.ceil(ms / 1000)}s`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCheckout(): string {
  const dir = process.env.ARKADE_REGTEST_DIR?.trim() || path.join(ROOT, "arkade-regtest");
  if (existsSync(path.join(dir, "regtest.mjs"))) return dir;
  git(["init", dir]);
  git(["remote", "add", "origin", "https://github.com/ArkLabsHQ/arkade-regtest.git"], dir);
  git(["fetch", "--depth", "1", "origin", PIN], dir);
  git(["checkout", "--detach", "FETCH_HEAD"], dir);
  return dir;
}

async function ensureStack(regtestDir: string) {
  const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (docker.error || docker.status !== 0) {
    const detail = docker.error?.message || docker.stderr || docker.stdout;
    throw new Error(`docker is not usable, so arkade regtest cannot start: ${detail.trim()}`);
  }
  const info = await readInfo(ARK);
  const emulatorKey = await emulatorPubkey();
  if (info && !arkMatches(info)) {
    throw new Error(
      `arkd at ${ARK} is ${info.network ?? "unknown"} with unilateralExitDelay ${info.unilateralExitDelay}, not regtest/${EXIT}. `
      + `Stop that stack (cd arkade-regtest && node regtest.mjs clean) and rerun pnpm smoke:regtest.`,
    );
  }
  if (!arkMatches(info) || emulatorKey !== REGTEST_EMULATOR_PUBKEY) {
    console.log("starting arkade-regtest");
    const started = spawnSync("node", [
      "regtest.mjs", "start", "--profile", "emulator", "--env", path.join(ROOT, ".env.regtest"),
    ], { cwd: regtestDir, stdio: "inherit" });
    if (started.status !== 0) {
      throw new Error(`arkade-regtest start exited ${started.status}`);
    }
  }
  const ready = await readInfo(ARK);
  const readyKey = await emulatorPubkey();
  if (!arkMatches(ready)) {
    throw new Error(`arkd at ${ARK} did not come up as regtest with exit ${EXIT} and zero intent fees`);
  }
  if (readyKey !== REGTEST_EMULATOR_PUBKEY) {
    throw new Error(`emulator at ${EMULATOR} signer is ${readyKey ?? "down"}, expected ${REGTEST_EMULATOR_PUBKEY}`);
  }
  console.log("regtest", ARK, "emulator", EMULATOR, "exit", ready?.unilateralExitDelay);
}

function arkMatches(info: Info | null): boolean {
  if (!info || info.network !== "regtest") return false;
  if (BigInt(info.unilateralExitDelay ?? 0) !== EXIT) return false;
  const fee = info.fees?.intentFee ?? {};
  const values = [fee.offchainInput, fee.offchainOutput, fee.onchainInput, fee.onchainOutput, info.fees?.txFeeRate];
  return values.every((item) => item !== undefined && Number(item) === 0);
}

async function readInfo(url: string): Promise<Info | null> {
  try {
    const response = await fetch(`${url}/v1/info`);
    if (!response.ok) return null;
    return await response.json() as Info;
  } catch {
    return null;
  }
}

async function emulatorPubkey(): Promise<string | undefined> {
  const info = await readInfo(EMULATOR);
  const key = (info as { signerPubkey?: string } | null)?.signerPubkey;
  return key?.trim().toLowerCase();
}

function arkSend(regtestDir: string, receivers: { to: string; amount: number }[]) {
  const res = spawnSync("node", [
    "regtest.mjs", "ark", "send",
    "--receivers", JSON.stringify(receivers),
    "--password", PASSWORD,
  ], { cwd: regtestDir, encoding: "utf8" });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  if (res.status !== 0) throw new Error(`ark send failed (${res.status}): ${out}`);
  console.log("funded", out);
}

async function scriptCoins(indexer: RestIndexerProvider, script: Uint8Array): Promise<Coin[]> {
  const page = await indexer.getVtxos({ scripts: [bytesToHex(script)], spendableOnly: true });
  return page.vtxos ?? [];
}

function ids(coins: Coin[]): Set<string> {
  return new Set(coins.map((coin) => `${coin.txid}:${coin.vout}`));
}

function fresh(coins: Coin[], before: Set<string>, min: bigint): boolean {
  return coins.some((coin) => !before.has(`${coin.txid}:${coin.vout}`) && BigInt(coin.value) >= min);
}

async function waitFor(ready: () => Promise<boolean>, label: string) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (await ready()) return;
    console.log(label, `not indexed yet (${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} was not indexed`);
}

function git(args: string[], cwd?: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim()}`);
  }
}
