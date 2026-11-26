import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  arkade,
  REGTEST_EMULATOR_PUBKEY,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { createOracle } from "../oracle/service.ts";
import {
  EXIT,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VOID_AFTER,
} from "../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { centsOf, fetchPinnedIntent } from "../protocol/dia.ts";
import { FIX_EXPIRY_LAG } from "../protocol/fixing.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { intentProgram, predictVaultProgram } from "../protocol/programs.ts";
import { fetchOracleFixing } from "../protocol/oracle-client.ts";
import { refundQuote, settlePredictQuote } from "../protocol/vault-ops.ts";

/**
 * Standalone PredictVaultV3 end-to-end smoke test on a local arkade-regtest stack
 * (bitcoin regtest + arkd + emulator).
 *
 *   pnpm smoke:regtest
 *
 * Clones arkade-regtest if needed, starts it with `.env.regtest` (2048s exit, zero
 * intent fees), starts a stateless fixing oracle, and exercises:
 *   1. Filling a Predict intent from desk float (`OptionIntent` side 1 -> `PredictVaultV3`).
 *   2. Cancelling an unfilled stake back to the bettor after its deadline.
 *   3. Void-refunding an unfixed vault after `expiry + voidAfter`.
 *   4. Standalone direct-signature settlement (`PredictVaultV3.settle`) using a live
 *      DIA print + oracle Schnorr signature, paying 100% of `payout` to the bettor.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = "e639c8de978c7978944a3b7356a2060f91403036";
const ARK = process.env.ARK_URL?.trim() || "http://127.0.0.1:7070";
const EMULATOR = process.env.EMULATOR_URL?.trim() || "http://127.0.0.1:7073";
const PASSWORD = process.env.ARKD_PASSWORD?.trim() || "secret";
const ADMIN = "regtest-admin";

type Info = {
  network?: string;
  unilateralExitDelay?: string | number;
  fees?: {
    intentFee?: Record<string, string>;
    txFeeRate?: string;
  };
};

type Coin = { txid: string; vout: number; value: number };

test("a prediction fills from the desk float, settles standalone with a signed fixing, voids after voidAfter, and cancels when unfilled", async () => {
  const regtestDir = ensureCheckout();
  await ensureStack(regtestDir);

  const bettor = SingleKey.fromHex("4".padStart(64, "0"));
  const desk = SingleKey.fromHex("5".padStart(64, "0"));
  const oracleSecret = "6".padStart(64, "0");
  const oracleKey = SingleKey.fromHex(oracleSecret);
  const oraclePk = await oracleKey.xOnlyPublicKey();
  const oraclePkHex = bytesToHex(oraclePk);
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
  assert.equal(bytesToHex(bettorClient.emulatorKey!), REGTEST_EMULATOR_PUBKEY);
  await assertServerExit(ARK);

  const dataDir = await mkdtemp(path.join(tmpdir(), "coinflip-regtest-oracle-"));
  const oracle = await createOracle({
    dataDir,
    adminToken: ADMIN,
    oracleKey: hexToBytes(oracleSecret),
    network: "regtest",
  });
  try {
    const initial = await fetchPinnedIntent();
    const line = centsOf(initial.price) - 50_000n;
    const stake = 20_000n;
    const payout = 38_000n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expiry = nextGridExpiry(now);
    const serverKey = deskClient.serverKey;
    const deskPk = await desk.xOnlyPublicKey();
    const bettorVtxo = payoutVtxo(await bettor.xOnlyPublicKey(), serverKey, EXIT);
    const bettorKey = bettorVtxo.tweakedPublicKey;
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
      oraclePk,
      serverKey,
      emulatorKey: bettorClient.emulatorKey!,
    };
    const fill = bindContracts({ ...shared, deadline: now + 3_600n });
    const cancel = bindContracts({ ...shared, deadline: now + 45n });
    const voidTerms = { ...shared, expiry: now + 50n, voidAfter: 5n, deadline: now + 3_600n };
    const voidFill = bindContracts(voidTerms);
    const deskScript = payoutVtxo(deskPk, serverKey, EXIT);
    assert.equal(bytesToHex(fill.writerPkScript), bytesToHex(deskScript.pkScript));
    assert.equal(bytesToHex(fill.holderPkScript), bytesToHex(bettorVtxo.pkScript));
    const deskAddress = deskScript.address(network.hrp, serverKey).encode();
    console.log("predict intent", fill.intentAddress);
    console.log("predict vault", fill.vaultAddress);

    arkSend(regtestDir, [
      { to: fill.intentAddress, amount: Number(stake) },
      { to: cancel.intentAddress, amount: Number(stake) },
      { to: voidFill.intentAddress, amount: Number(stake) },
      { to: deskAddress, amount: Number(payout * 2n + 2_000n) },
    ]);
    const fillIntent = deskClient.contract(intentProgram(), fill.intent);
    const cancelIntent = bettorClient.contract(intentProgram(), cancel.intent);
    const voidIntent = deskClient.contract(intentProgram(), voidFill.intent);
    await waitFor(async () => (await fillIntent.getUtxos()).some((coin) => BigInt(coin.value) >= stake), "stake");
    await waitFor(async () => (await cancelIntent.getUtxos()).some((coin) => BigInt(coin.value) >= stake), "unfilled stake");
    await waitFor(async () => (await voidIntent.getUtxos()).some((coin) => BigInt(coin.value) >= stake), "void stake");
    await waitFor(async () => (await scriptCoins(indexer, deskScript.pkScript)).some((coin) => BigInt(coin.value) >= payout * 2n), "desk float");

    const deskBefore = ids(await scriptCoins(indexer, deskScript.pkScript));
    const row = quoteRow({
      rfqId: "11".repeat(32),
      bound: fill,
      now,
      expiry: Number(expiry),
      deadline: Number(now + 3_600n),
      collateral: payout,
      premium: stake,
      strike: line,
      writerPk: deskPk,
      holderPk: bettorKey,
      oraclePkHex,
    });
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
    await waitFor(async () => (await scriptCoins(indexer, deskScript.pkScript)).some((coin) => BigInt(coin.value) >= payout), "desk float for void");

    const voidRow = quoteRow({
      rfqId: "fe".repeat(32),
      bound: voidFill,
      now,
      expiry: Number(voidTerms.expiry),
      deadline: Number(now + 3_600n),
      collateral: payout,
      premium: stake,
      strike: line,
      writerPk: deskPk,
      holderPk: bettorKey,
      oraclePkHex,
    });
    const voidFilled = await fillQuote({
      client: deskClient,
      deskScript,
      row: voidRow,
      now: Number(now),
      ark: deskClient.arkProvider as RestArkProvider,
      termsFor: () => voidTerms,
    });
    console.log("predict void finalize", voidFilled.result, voidFilled.txid ?? "");
    assert.equal(voidFilled.result, "filled", `void finalize ${voidFilled.result}`);
    const voidVault = deskClient.contract(predictVaultProgram(), voidFill.vault);
    await waitFor(async () => (await voidVault.getUtxos()).some((coin) => BigInt(coin.value) === payout), "predict void vault");

    const earlyVoid = await refundQuote({
      chain: indexer,
      serverKey,
      emulatorKey: bettorClient.emulatorKey!,
      emulator,
      checkpoint: deskClient.checkpoint,
      fillTxid: voidFilled.txid,
      terms: voidTerms,
      now: Number(voidTerms.expiry),
    });
    assert.deepEqual(earlyVoid, { result: "waiting", reason: "early" });

    const cancelCoin = (await cancelIntent.getUtxos()).find((coin) => BigInt(coin.value) >= stake);
    assert.ok(cancelCoin, "unfilled stake missing");
    await sleepUntil(Number(cancel.intent.deadline) + 2, "cancel");
    const bettorAtCancel = ids(await scriptCoins(indexer, cancel.userPkScript));
    const refunded = await bettorClient.contract(intentProgram(), cancel.intent).functions
      .cancel()
      .from(cancelCoin)
      .to(cancel.userPkScript, BigInt(cancelCoin.value))
      .send();
    console.log("predict cancel refund", refunded.txid);
    await waitFor(async () => fresh(await scriptCoins(indexer, cancel.userPkScript), bettorAtCancel, stake), "cancel refund");

    await sleepUntil(Number(voidTerms.expiry + voidTerms.voidAfter) + 2, "predict void refund");
    const bettorBeforeVoid = ids(await scriptCoins(indexer, voidFill.holderPkScript));
    const deskBeforeVoid = ids(await scriptCoins(indexer, deskScript.pkScript));
    let voided: Awaited<ReturnType<typeof refundQuote>> | undefined;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        voided = await refundQuote({
          chain: indexer,
          serverKey,
          emulatorKey: bettorClient.emulatorKey!,
          emulator,
          checkpoint: deskClient.checkpoint,
          fillTxid: voidFilled.txid,
          terms: voidTerms,
          now: Math.floor(Date.now() / 1000),
        });
        console.log("predict void", voided.result, "txid" in voided ? voided.txid : "", `(${attempt})`);
        if (voided.result === "refunded") break;
      } catch (err) {
        console.log("predict void retry", err instanceof Error ? err.message : String(err), `(${attempt})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(voided && voided.result === "refunded", `void ${voided?.result}`);
    assert.equal(voided.holder, stake);
    assert.equal(voided.writer, payout - stake);
    await waitFor(async () => fresh(await scriptCoins(indexer, voidFill.holderPkScript), bettorBeforeVoid, stake), "void stake back");
    await waitFor(async () => fresh(await scriptCoins(indexer, deskScript.pkScript), deskBeforeVoid, payout - stake), "void house share");
    await waitFor(async () => (await voidVault.getUtxos()).length === 0, "predict void vault spent");

    const expiryLag = Number(FIX_EXPIRY_LAG);
    await sleepUntil(Number(expiry), "predict sample");
    const intent = await fetchWindowIntent(Number(expiry), expiryLag);
    const sample = (await oracleCall(oracle.url, "/api/intent", {
      price: intent.price.toString(),
      time: intent.time,
      nonce: intent.nonce.toString(),
      intentExpiry: intent.intentExpiry,
      sig: bytesToHex(intent.sig),
    })).json;
    const cents = centsOf(intent.price);
    assert.equal(sample.price, cents.toString(), `sample ${JSON.stringify(sample)}`);
    await sleepUntil(Number(expiry) + expiryLag + 32, "predict fixing");

    const fetched = await fetchOracleFixing(oracle.url, Number(expiry), oraclePkHex);
    assert.equal(fetched.status, 200, fetched.error);
    assert.ok(fetched.fixing, "oracle fixing missing");
    assert.equal(fetched.fixing.cents, cents);

    const bettorBefore = ids(await scriptCoins(indexer, fill.holderPkScript));
    let settled: Awaited<ReturnType<typeof settlePredictQuote>> | undefined;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      settled = await settlePredictQuote({
        chain: indexer,
        serverKey,
        emulatorKey: bettorClient.emulatorKey!,
        emulator,
        checkpoint: deskClient.checkpoint,
        fillTxid: filled.txid,
        terms: { ...shared, deadline: now + 3_600n },
        fixing: fetched.fixing,
        now: Math.floor(Date.now() / 1000),
      });
      console.log("predict settle", settled.result, "txid" in settled ? settled.txid : "", `(${attempt})`);
      if (settled.result === "settled" && settled.price != null) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.ok(settled && settled.result === "settled" && settled.price != null, `settle ${settled?.result}`);
    if (!settled || settled.result !== "settled" || settled.price == null) return;
    assert.equal(settled.price, cents);
    assert.equal(settled.holder, payout);
    assert.equal(settled.writer, 0n);
    await waitFor(
      async () => fresh(await scriptCoins(indexer, fill.holderPkScript), bettorBefore, payout),
      "payout to the bettor",
    );
    await waitFor(async () => (await vault.getUtxos()).length === 0, "predict vault spent");
    console.log("predict settled", settled.txid, "bettor", settled.holder?.toString());
  } finally {
    await oracle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

function quoteRow(opts: {
  rfqId: string;
  bound: ReturnType<typeof bindContracts>;
  now: bigint;
  expiry: number;
  deadline: number;
  collateral: bigint;
  premium: bigint;
  strike: bigint;
  writerPk: Uint8Array;
  holderPk: Uint8Array;
  oraclePkHex: string;
}): QuoteRow {
  return {
    rfqId: opts.rfqId,
    collateral: opts.collateral.toString(),
    premium: opts.premium.toString(),
    kind: 2,
    strike: opts.strike.toString(),
    expiry: opts.expiry,
    deadline: opts.deadline,
    validUntil: Number(opts.now + 30n),
    exit: Number(EXIT),
    writerPubkey: bytesToHex(opts.writerPk),
    writerPkScript: bytesToHex(opts.bound.writerPkScript),
    holderPubkey: bytesToHex(opts.holderPk),
    holderPkScript: bytesToHex(opts.bound.holderPkScript),
    oraclePubkey: opts.oraclePkHex,
    backupPubkey: REGTEST_EMULATOR_PUBKEY.slice(2),
    voidAfter: Number(PREDICT_VOID_AFTER),
    fallbackDelay: Number(PREDICT_FALLBACK_DELAY),
    finalExitDelay: Number(PREDICT_FINAL_EXIT_DELAY),
    intentAddress: opts.bound.intentAddress,
    vaultAddress: opts.bound.vaultAddress,
    status: "open",
    createdAt: Number(opts.now),
    clientPubkey: bytesToHex(opts.holderPk),
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

async function fetchWindowIntent(expiry: number, expiryLag: number) {
  const deadline = expiry + expiryLag;
  while (Math.floor(Date.now() / 1000) <= deadline) {
    try {
      const intent = await fetchPinnedIntent();
      if (intent.time >= expiry && intent.time <= deadline) return intent;
    } catch (err) {
      console.log("dia retry", err instanceof Error ? err.message : String(err));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("DIA timestamp is outside the expiry window");
}

function nextGridExpiry(now: bigint, minLeft = 100n): bigint {
  const first = ((now / 300n) + 1n) * 300n;
  return first - now >= minLeft ? first : first + 300n;
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
