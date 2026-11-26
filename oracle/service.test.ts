import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, asset, CSVMultisigTapscript, Extension, networks, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

import { beaconIdOf, bindBeacon, decodeState, genesisState, nextState, predictFixDigest, priceValue, statePacketOf } from "../protocol/beacon.ts";
import { centsOf, intentSigned, SCALE, type DiaIntent } from "../protocol/dia.ts";
import {
  BEACON_READ_FEE,
  EXIT,
  OPTION_VAULT_PROGRAM_ID,
  PAIR,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VAULT_PROGRAM_ID,
  PREDICT_VOID_AFTER,
} from "../protocol/constants.ts";
import { bindContracts } from "../protocol/contracts.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { createOracle, dueExpiries, duePositionExpiries, skippedPublish, type HeldCoin, type OracleDeps, type OracleWallet } from "./service.ts";
import { chooseSample, chooseStrictSample, FIXING_GRACE_S, FIXING_HISTORY_S, loadStore, pruneFixings, pruneSamples, SAMPLE_HISTORY_S, saveStore, windowSettled, type StoredSample } from "./store.ts";
import { parseOracleFixing } from "../settle/oracle.ts";

const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";

spawnSync("pnpm", ["-s", "oracle:page"], { cwd: path.resolve(import.meta.dirname, ".."), stdio: "inherit" });

function secret(byte: number): Uint8Array {
  return Uint8Array.from(hex.decode(byte.toString(16).padStart(2, "0").repeat(32)));
}

async function boot(extra: Partial<OracleDeps> & { adminToken?: string; samples?: StoredSample[] } = {}) {
  const { samples, ...depsExtra } = extra;
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-"));
  if (samples?.length) {
    await saveStore(dir, { assetId: null, issueTxid: null, deployTxid: null, samples, fixings: [] });
  }
  const serverKey = await SingleKey.fromHex(hex.encode(secret(1))).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex(hex.encode(secret(2))).compressedPublicKey();
  const recorded: { outputs?: { script: Uint8Array; amount: bigint }[]; issue?: { amount: bigint } } = {};
  let assetId = "";
  const issueTxid = "ee".repeat(32);
  const other = asset.AssetId.create("ab".repeat(32), 1);
  const wallet: OracleWallet = {
    assetManager: {
      async issue(params) {
        recorded.issue = params;
        assetId = asset.AssetId.create(issueTxid, 0).toString();
        return { arkTxId: issueTxid, assetId };
      },
    },
    async getAddress() {
      return new ArkAddress(serverKey, new Uint8Array(32).fill(4), networks.mutinynet.hrp).encode();
    },
    async getVtxos() {
      const coin: HeldCoin = {
        txid: issueTxid,
        vout: 0,
        value: 10_000,
        assets: [
          { assetId, amount: 1n },
          { assetId: other.toString(), amount: 5n },
        ],
      };
      return [coin];
    },
    async buildAndSubmitOffchainTx(_inputs, outputs) {
      recorded.outputs = outputs;
      return { arkTxid: "dd".repeat(32), signedCheckpointTxs: [] };
    },
    arkServerPublicKey: serverKey,
    serverUnrollScript: CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_HEX)),
  };
  let creating: Transaction | undefined;
  const submitted: string[] = [];
  const indexer = {
    async getVtxos(opts: { scripts: string[] }) {
      const script = hex.decode(opts.scripts[0]!);
      const last = submitted.at(-1);
      if (last) {
        creating = Transaction.fromPSBT(base64.decode(last));
      } else {
        creating = new Transaction({ version: 3, allowUnknownOutputs: true });
        creating.addInput({ txid: new Uint8Array(32).fill(8), index: 1 });
        creating.addOutput({ script, amount: 330n });
        creating.addOutput(Extension.create([statePacket(genesisState())]).txOut());
      }
      const dust = { txid: "11".repeat(32), vout: 0, value: 1 };
      return { vtxos: [dust, { txid: creating.id, vout: 0, value: 330, assets: [{ assetId, amount: 1n }] }] };
    },
    async getVirtualTxs(txids: string[]) {
      if (!creating || txids[0] !== creating.id) return { txs: [] };
      return { txs: [base64.encode(creating.toPSBT())] };
    },
  };
  const emulator = {
    async submitTx(arkTx: string, checkpointTxs: string[] = []) {
      submitted.push(arkTx);
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
    },
  };
  const oracle = await createOracle({
    dataDir: dir,
    adminToken: "test-token",
    oracleKey: secret(9),
    emulatorKey,
    wallet,
    indexer,
    emulator,
    now: () => 1_700_000_000 + 60,
    ...depsExtra,
  });
  return { oracle, dir, recorded, submitted, serverKey, emulatorKey, other, wallet, indexer, emulator, close: async () => { await oracle.close(); await rm(dir, { recursive: true, force: true }); } };
}

const DIA_SIG = "11".repeat(64);

/** A DIA intent whose 18-decimal price scales to `cents` with no remainder. */
function diaSample(cents: string | number, time: number) {
  return {
    price: (BigInt(cents) * SCALE).toString(),
    time,
    nonce: "1",
    intentExpiry: time + 3_600,
    sig: DIA_SIG,
  };
}

/** Bypasses `/api/intent` signature checks. For publish-path unit tests only. */
function storedSample(cents: string | number, time: number): StoredSample {
  return {
    price: String(cents),
    time,
    raw: (BigInt(cents) * SCALE).toString(),
    nonce: "1",
    intentExpiry: time + 3_600,
    sig: DIA_SIG,
  };
}

/** A real Lasernet OracleUpdate signed by the pinned DIA key. */
const RECORDED: DiaIntent = {
  price: 63907720609324293160960n,
  time: 1794696202,
  nonce: 1793790301274550603n,
  intentExpiry: 1794699802,
  sig: Buffer.from("c7036e95adf3073c3cd65e440505f447ff9397685952de165a2871f28fc24b5b2764dfd31c3a6e1cb2d8378175227fa523616c7fe9ca4cd6c752494a5598209e", "hex"),
};

function recordedBody(intent: DiaIntent = RECORDED) {
  return {
    price: intent.price.toString(),
    time: intent.time,
    nonce: intent.nonce.toString(),
    intentExpiry: intent.intentExpiry,
    sig: bytesToHex(intent.sig),
  };
}

async function call(url: string, pathName: string, body?: unknown, token?: string) {
  const isGetApi = pathName === "/api/status" || pathName.startsWith("/api/fixing") || pathName.startsWith("/api/prices");
  const res = await fetch(url + pathName, {
    method: body === undefined && pathName.startsWith("/api/") && !isGetApi ? "POST" : body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
}

test("chooseSample stays inside the expiry lag", () => {
  const expiry = 1_000_000;
  const lag = 60;
  const old = { time: expiry - lag - 1, price: "1" };
  const near = { time: expiry - lag, price: "2" };
  const inside = { time: expiry + 10, price: "3" };
  const later = { time: expiry + 20, price: "5" };
  const after = { time: expiry + lag + 1, price: "4" };
  assert.equal(chooseSample([old, near], expiry, lag)?.price, "2");
  assert.equal(chooseSample([old], expiry, lag), null);
  assert.equal(chooseSample([near, inside, after], expiry, lag)?.price, "3");
  assert.equal(chooseSample([inside, later, old], expiry, lag)?.price, "5");
  assert.equal(chooseSample([after], expiry, lag), null);
});

test("a stored sample keeps its price and drops a keyless signature", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-store-"));
  try {
    await saveStore(dir, {
      assetId: null,
      issueTxid: null,
      deployTxid: null,
      samples: [{ price: "10", time: 50, sigs: ["aa".repeat(64)] } as { price: string; time: number }],
      fixings: [],
    });
    const loaded = await loadStore(dir);
    assert.equal(loaded.samples[0]?.price, "10");
    assert.equal(loaded.samples[0]?.time, 50);
    assert.equal("sigs" in (loaded.samples[0] ?? {}), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("price history keeps one day", () => {
  const now = 2_000_000;
  const kept = pruneSamples([
    { price: "1", time: now - SAMPLE_HISTORY_S - 1 },
    { price: "2", time: now - SAMPLE_HISTORY_S },
  ], now);
  assert.deepEqual(kept.map((sample) => sample.price), ["2"]);
});

test("status, admin order, deploy change, and a print that becomes a fixing", async () => {
  const expiry = 1_700_000_100n;
  const ctx = await boot({ now: () => Number(expiry + 60n), samples: [storedSample("10000000", Number(expiry + 60n))] });
  try {
    const home = await fetch(ctx.oracle.url + "/");
    assert.equal(home.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'");
    assert.equal(home.headers.get("access-control-allow-origin"), null);
    const html = await home.text();
    assert.match(html, /src="\/page\.js"/);
    assert.match(html, /id="settle-price"/);
    assert.match(html, /id="publish-price"/);
    assert.match(html, /id="payout"/);
    assert.doesNotMatch(html, /id="sample-time"/);
    assert.doesNotMatch(html, /publish-price" type="submit"/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)/);
    assert.equal((await fetch(ctx.oracle.url + "/page.js")).status, 200);
    assert.equal((await fetch(ctx.oracle.url + "/page.css")).status, 200);

    const open = await call(ctx.oracle.url, "/api/status");
    assert.equal(open.status, 200);
    assert.equal(JSON.stringify(open.json).includes(hex.encode(secret(9))), false);
    assert.equal((open.json.args as { domain: string }).domain, hex.encode(new TextEncoder().encode("BTCUSD-FIX")));
    assert.equal((open.json.args as { expiryLag: number }).expiryLag, 60);
    assert.equal((open.json.args as { readFee: number }).readFee, 1_000);
    assert.equal(open.json.samples, 1);
    assert.equal("minValue" in (open.json.args as object), false);
    assert.equal((open.json.args as { exit: number }).exit, 2048);
    assert.equal((open.json.args as { adminPk: string }).adminPk, hex.encode(schnorr.getPublicKey(secret(9))));
    assert.match(String(open.json.wallet), /^tark1/);
    assert.equal(open.json.balance, "10000");

    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "nope")).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {})).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 400);

    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 200);
    assert.deepEqual(ctx.recorded.issue, { amount: 1n });
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 409);

    const deployed = await call(ctx.oracle.url, "/api/deploy", {}, "test-token");
    assert.equal(deployed.status, 200);
    const outputs = ctx.recorded.outputs!;
    assert.equal(outputs[0]!.amount, 330n);
    assert.equal(outputs[1]!.amount, 9_670n);
    const groups = Extension.fromBytes(outputs[2]!.script).getAssetPacket()!.groups;
    assert.equal(groups[0]!.outputs[0]!.vout, 0);
    assert.equal(groups[1]!.outputs[0]!.vout, 1);
    assert.equal(groups[1]!.assetId!.toString(), ctx.other.toString());

    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.issueTxid, "ee".repeat(32));
    assert.equal((status.json.args as { ctrlTxid: string }).ctrlTxid, bytesToHex(beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid));
    const bound = bindBeacon({
      id: beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)),
      domain: new TextEncoder().encode("BTCUSD-FIX"),
      expiryLag: 60n,
      readFee: 1_000n,
      adminPk: schnorr.getPublicKey(secret(9)),
      exit: EXIT,
      serverKey: ctx.serverKey,
      emulatorKey: ctx.emulatorKey,
    });
    assert.equal(status.json.address, bound.address);

    const huge = await fetch(ctx.oracle.url + "/api/intent", { method: "POST", body: "x".repeat(5000), headers: { "content-type": "application/json", authorization: "Bearer test-token" } });
    assert.equal(huge.status, 413);
    assert.equal((await call(ctx.oracle.url, "/api/intent", { ...diaSample("10000000", 1_700_000_060), extra: 1 }, "test-token")).status, 400);
    const historyRes = await fetch(ctx.oracle.url + `/api/prices?from=${expiry}&to=${expiry + 60n}`);
    const history = (await historyRes.json()) as { samples: Record<string, unknown>[] };
    assert.equal(history.samples.length, 1);
    assert.equal("sigs" in history.samples[0]!, false);

    const disabled = await boot({ adminToken: undefined, now: () => Number(expiry + 60n) });
    assert.equal((await call(disabled.oracle.url, "/api/intent", diaSample("1", 1), "test-token")).status, 404);
    await disabled.close();

    assert.equal((await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) })).status, 401);
    const incomplete = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry - 86_400n) }, "test-token");
    assert.equal(incomplete.status, 400);
    const tooSoon = await createOracle({
      dataDir: ctx.dir,
      adminToken: "test-token",
      oracleKey: secret(9),
      emulatorKey: ctx.emulatorKey,
      now: () => Number(expiry + 59n),
    });
    const early = await call(tooSoon.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(early.status, 400);
    await tooSoon.close();

    const published = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.price, "10000000");
    assert.equal(ctx.submitted.length, 1);
    const offGrid = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) + 60 }, "test-token");
    assert.equal(offGrid.status, 400);
    assert.equal(offGrid.json.error, "expiry grid");
    const again = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(again.status, 409);
    const after = await call(ctx.oracle.url, "/api/status");
    const fixing = (after.json.fixings as { expiry: number; price: string; time: number; txid: string }[])[0]!;
    assert.equal(fixing.expiry, Number(expiry));
    assert.equal(fixing.price, "10000000");
    assert.equal(fixing.time, Number(expiry + 60n));
    assert.equal(fixing.txid, published.json.txid);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    const next = nextState(genesisState(), expiry, priceValue(10_000_000n, expiry + 60n));
    assert.deepEqual(statePacketOf(tx), next);
    const witness = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.witness!;
    assert.ok(bytesToHex(witness).includes(DIA_SIG), bytesToHex(witness));
  } finally {
    await ctx.close();
  }
});

test("admin backdate publishes a sample inside a closed window", async () => {
  const expiry = 1_791_822_000;
  const sampleTime = 1_791_822_030;
  const price = "8277570";
  const ctx = await boot({
    now: () => expiry + 120,
    samples: [storedSample("1", expiry - 1), storedSample(price, sampleTime)],
  });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/intent", diaSample(price, sampleTime))).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/intent", diaSample(price, 0), "test-token")).status, 400);
    assert.equal((await call(ctx.oracle.url, "/api/intent", diaSample(price, expiry + 121), "test-token")).status, 400);
    const published = await call(ctx.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.expiry, expiry);
    assert.equal(published.json.price, price);
    assert.equal(published.json.time, sampleTime);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    assert.deepEqual(statePacketOf(tx), nextState(genesisState(), BigInt(expiry), priceValue(BigInt(price), BigInt(sampleTime))));
    const witness = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.witness!;
    assert.ok(bytesToHex(witness).includes(DIA_SIG), bytesToHex(witness));
  } finally {
    await ctx.close();
  }
});

test("a print before the expiry is rejected and a print inside the minute is accepted", async () => {
  const expiry = 1_700_000_100;
  const early = await boot({ now: () => expiry + 120, samples: [storedSample("10000000", expiry - 1)] });
  try {
    assert.equal((await call(early.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(early.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    const rejected = await call(early.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, "sample before expiry");
    assert.equal(early.submitted.length, 0);
  } finally {
    await early.close();
  }
  const inside = await boot({ now: () => expiry + 120, samples: [storedSample("10000000", expiry + 30)] });
  try {
    assert.equal((await call(inside.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(inside.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    const accepted = await call(inside.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.price, "10000000");
    assert.equal(accepted.json.time, expiry + 30);
    const tx = Transaction.fromPSBT(base64.decode(inside.submitted[0]!));
    assert.deepEqual(statePacketOf(tx), nextState(genesisState(), BigInt(expiry), priceValue(10_000_000n, BigInt(expiry + 30))));
  } finally {
    await inside.close();
  }
});

test("evicted or earlier closes cannot be rewritten once the beacon advances", async () => {
  const base = 1_700_000_100;
  const now = () => base + 8 * 300 + 60;
  const ctx = await boot({ now, samples: [storedSample("111", base + 10)] });
  let restarted: Awaited<ReturnType<typeof createOracle>> | null = null;
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    const first = await call(ctx.oracle.url, "/api/publish", { expiry: base }, "test-token");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.price, "111");
    await ctx.oracle.close();
    const file = await loadStore(ctx.dir);
    file.samples.push(storedSample("999", base + 50));
    for (let i = 1; i <= 8; i += 1) file.samples.push(storedSample(String(2_000 + i), base + i * 300 + 10));
    await saveStore(ctx.dir, file);
    restarted = await createOracle({
      dataDir: ctx.dir,
      adminToken: "test-token",
      oracleKey: secret(9),
      emulatorKey: ctx.emulatorKey,
      wallet: ctx.wallet,
      indexer: ctx.indexer,
      emulator: ctx.emulator,
      now,
    });
    for (let i = 1; i <= 8; i += 1) {
      const expiry = base + i * 300;
      const published = await call(restarted.url, "/api/publish", { expiry }, "test-token");
      assert.equal(published.status, 200, JSON.stringify(published.json));
    }
    const replay = await call(restarted.url, "/api/publish", { expiry: base }, "test-token");
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error, "expiry order");
  } finally {
    await ctx.oracle.close().catch(() => {});
    await restarted?.close().catch(() => {});
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("issue refuses an empty wallet with fund wallet", async () => {
  const ctx = await boot();
  ctx.wallet.getVtxos = async () => [];
  try {
    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.balance, "0");
    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 400);
    assert.equal(issued.json.error, "fund wallet");
  } finally {
    await ctx.close();
  }
});

test("recover finalizes pending and can adopt an issued unit", async () => {
  const ctx = await boot();
  const finalized: string[] = [];
  let state: { settings?: { hasPendingTx?: boolean } } | null = null;
  const issuedId = asset.AssetId.create("ee".repeat(32), 0).toString();
  ctx.wallet.walletRepository = {
    async getWalletState() {
      return state;
    },
    async saveWalletState(next) {
      state = next;
    },
  };
  ctx.wallet.finalizePendingTxs = async () => {
    finalized.push("aa".repeat(32));
    return { finalized: ["aa".repeat(32)], pending: ["aa".repeat(32)] };
  };
  ctx.wallet.getVtxos = async () => [
    { txid: "ee".repeat(32), vout: 0, value: 10_000, assets: [{ assetId: issuedId, amount: 1n }] },
  ];
  try {
    const first = await call(ctx.oracle.url, "/api/recover", {}, "test-token");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(finalized, ["aa".repeat(32)]);
    assert.equal((state as { settings?: { hasPendingTx?: boolean } } | null)?.settings?.hasPendingTx, true);
    assert.equal((first.json.adopted as { txid: string }).txid, "ee".repeat(32));
    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.issueTxid, "ee".repeat(32));
    assert.equal(status.json.assetId, issuedId);
  } finally {
    await ctx.close();
  }
});

test("the sampler stores a price without the admin route", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-sample-"));
  const issueTxid = "ee".repeat(32);
  const assetId = asset.AssetId.create(issueTxid, 0).toString();
  await writeFile(path.join(dir, "oracle.json"), JSON.stringify({
    assetId,
    issueTxid,
    deployTxid: null,
    samples: [],
    fixings: [],
  }));
  const emulatorKey = await SingleKey.fromHex(hex.encode(secret(2))).compressedPublicKey();
  const oracle = await createOracle({
    dataDir: dir,
    oracleKey: secret(9),
    emulatorKey,
    pull: async () => RECORDED,
    sampleEveryMs: 60_000,
    now: () => RECORDED.time,
  });
  try {
    assert.equal((await call(oracle.url, "/api/intent", diaSample("1", 1))).status, 404);
    let samples = 0;
    let latest: { price?: string; time?: number } | null = null;
    for (let i = 0; i < 40 && samples < 1; i++) {
      const status = await call(oracle.url, "/api/status");
      samples = Number(status.json.samples);
      latest = status.json.latest as { price?: string; time?: number } | null;
      if (samples < 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(samples, 1);
    assert.equal(latest?.price, centsOf(RECORDED.price).toString());
    assert.equal(latest?.time, RECORDED.time);
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a print before the expiry or after the close is skipped on the minute pass", async () => {
  assert.equal(skippedPublish("sample before expiry"), true);
  assert.equal(skippedPublish("sample after close"), true);
  assert.equal(skippedPublish("beacon coin"), false);
  const expiry = 1_700_000_100;
  const later = expiry + 300;
  const ctx = await boot({
    now: () => later + 200,
    announcedExpiries: () => [expiry, later],
    samples: [storedSample("10000000", expiry - 1), storedSample("10000000", later + 61)],
  });
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await ctx.oracle.publishAnnounced();
    assert.equal(ctx.submitted.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual((await call(ctx.oracle.url, "/api/status")).json.fixings, []);
  } finally {
    console.error = log;
    await ctx.close();
  }
});

test("only a closed announced expiry is published, and a missing sample is skipped", () => {
  const expiry = 1_700_000_100;
  const done = new Set<number>([expiry - 300]);
  assert.deepEqual(dueExpiries([expiry + 86_400, expiry, expiry, expiry - 300, expiry - 10], expiry + 60, done), [expiry]);
  assert.deepEqual(dueExpiries([expiry], expiry + 59, done), []);
});

test("the minute pass publishes an announced expiry once a sample exists", async () => {
  const expiry = 1_700_000_100;
  const later = expiry + 86_400;
  const missed = expiry - 300;
  const announced = new Set<number>([later, expiry, missed]);
  const empty = await boot({ now: () => expiry + 60, announcedExpiries: () => announced });
  try {
    assert.equal((await call(empty.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(empty.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await empty.oracle.publishAnnounced();
    assert.deepEqual((await call(empty.oracle.url, "/api/status")).json.fixings, []);
  } finally {
    await empty.close();
  }
  const ctx = await boot({
    now: () => expiry + 60,
    announcedExpiries: () => announced,
    samples: [storedSample("10000000", expiry + 60)],
  });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await ctx.oracle.publishAnnounced();
    const fixings = (await call(ctx.oracle.url, "/api/status")).json.fixings as { expiry: number; price: string }[];
    assert.equal(fixings.length, 1);
    assert.equal(fixings[0]?.expiry, expiry);
    assert.equal(fixings[0]?.price, "10000000");
    assert.equal(ctx.submitted.length, 1);
    await ctx.oracle.publishAnnounced();
    assert.equal(ctx.submitted.length, 1);
    assert.equal(((await call(ctx.oracle.url, "/api/status")).json.fixings as unknown[]).length, 1);
  } finally {
    await ctx.close();
  }
});

test("duePositionExpiries filters by beacon, freshness, 5-minute grid, oldest-first, and cap", () => {
  const ourTxid = "ee".repeat(32);
  const assetId = asset.AssetId.create(ourTxid, 0).toString();
  const base = 1_700_000_100;
  const make = (over: Partial<OptionPosition>): OptionPosition => ({
    v: 1,
    type: "option_position",
    program_id: PREDICT_VAULT_PROGRAM_ID,
    rfq_id: "11".repeat(32),
    pair: PAIR,
    kind: 2,
    collateral: "95000",
    strike: "8000000",
    expiry: base,
    exit: 2048,
    writer_pubkey: "21".repeat(32),
    writer_pk_script: `5120${"21".repeat(32)}`,
    holder_pubkey: "22".repeat(32),
    holder_pk_script: `5120${"22".repeat(32)}`,
    beacon_txid: ourTxid,
    beacon_gidx: 0,
    vault_address: "tark1vault",
    fill_txid: "aa".repeat(32),
    ...over,
  });
  const now = base + 1_800;
  const positions: OptionPosition[] = [
    make({ rfq_id: "01".repeat(32), beacon_txid: "ff".repeat(32), expiry: base }),
    make({ rfq_id: "02".repeat(32), beacon_gidx: 1, expiry: base }),
    make({ rfq_id: "03".repeat(32), expiry: base - 3_600 }),
    make({ rfq_id: "04".repeat(32), expiry: base + 60 }),
    make({ rfq_id: "05".repeat(32), kind: 0, program_id: OPTION_VAULT_PROGRAM_ID, expiry: base + 60 }),
    make({ rfq_id: "06".repeat(32), expiry: base + 300 }),
    make({ rfq_id: "07".repeat(32), expiry: base + 600 }),
    make({ rfq_id: "08".repeat(32), expiry: base + 900 }),
    make({ rfq_id: "09".repeat(32), expiry: base + 1_200 }),
    make({ rfq_id: "0a".repeat(32), kind: 0, program_id: OPTION_VAULT_PROGRAM_ID, expiry: base + 1_500 }),
    make({ rfq_id: "0b".repeat(32), expiry: base + 1_800 }),
  ];
  const due = duePositionExpiries(positions, { assetId, now, done: new Set() });
  assert.deepEqual(due.map((item) => item.expiry), [base + 300, base + 600, base + 900, base + 1_200]);
  const done = new Set([base + 300]);
  const next = duePositionExpiries(positions, { assetId, now, done });
  assert.deepEqual(next.map((item) => item.expiry), [base + 600, base + 900, base + 1_200, base + 1_500]);
});

test("publishAnnounced requires a derived vault address funded to at least collateral", async () => {
  const expiry = 1_700_000_100;
  const ourTxid = "ee".repeat(32);
  const serverKey = await SingleKey.fromHex(hex.encode(secret(1))).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex(hex.encode(secret(2))).compressedPublicKey();
  const deskPk = await SingleKey.fromHex(hex.encode(secret(21))).xOnlyPublicKey();
  const bettorPk = await SingleKey.fromHex(hex.encode(secret(22))).xOnlyPublicKey();
  const beacon = beaconIdOf(asset.AssetId.create(ourTxid, 0));
  const derive = (exp: number) => bindContracts({
    kind: 0,
    strike: 8_000_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: BigInt(exp),
    deadline: BigInt(exp),
    exit: EXIT,
    writerPk: deskPk,
    holderPk: bettorPk,
    beacon,
    readFee: BEACON_READ_FEE,
    serverKey,
    emulatorKey,
  });
  const liveVault = derive(expiry);
  const shortVault = derive(expiry - 300);
  const arbitraryAddr = new ArkAddress(serverKey, new Uint8Array(32).fill(5), networks.mutinynet.hrp);
  const liveScriptHex = bytesToHex(liveVault.vaultPkScript);
  const shortScriptHex = bytesToHex(shortVault.vaultPkScript);
  const arbitraryScriptHex = bytesToHex(arbitraryAddr.pkScript);
  const pruned: number[] = [];
  let creating: Transaction | undefined;
  const submitted: string[] = [];
  let assetId = "";
  const makePos = (rfqByte: string, exp: number, bound: ReturnType<typeof derive>, vaultAddress: string): OptionPosition => ({
    v: 1,
    type: "option_position",
    program_id: OPTION_VAULT_PROGRAM_ID,
    rfq_id: rfqByte.repeat(32),
    pair: PAIR,
    kind: 0,
    collateral: "95000",
    strike: "8000000",
    expiry: exp,
    exit: Number(EXIT),
    writer_pubkey: bytesToHex(deskPk),
    writer_pk_script: bytesToHex(bound.writerPkScript),
    holder_pubkey: bytesToHex(bettorPk),
    beacon_txid: ourTxid,
    beacon_gidx: 0,
    vault_address: vaultAddress,
    fill_txid: rfqByte.repeat(32),
  });
  const announced: OptionPosition[] = [
    makePos("aa", expiry - 600, liveVault, arbitraryAddr.encode()),
    makePos("bb", expiry - 300, shortVault, shortVault.vaultAddress),
    makePos("cc", expiry, liveVault, liveVault.vaultAddress),
  ];
  const ctx = await boot({
    now: () => expiry + 120,
    samples: [storedSample("9800000", expiry - 600 + 10), storedSample("9900000", expiry - 300 + 10), storedSample("10000000", expiry + 10)],
    announcedPositions: () => announced,
    onPublishedExpiry: (exp) => pruned.push(exp),
    indexer: {
      async getVtxos(opts) {
        if (opts.scripts.includes(liveScriptHex)) {
          return { vtxos: [{ txid: "cc".repeat(32), vout: 1, value: 95_000 }] };
        }
        if (opts.scripts.includes(shortScriptHex)) {
          return { vtxos: [{ txid: "bb".repeat(32), vout: 1, value: 1_000 }] };
        }
        if (opts.scripts.includes(arbitraryScriptHex)) {
          return { vtxos: [{ txid: "aa".repeat(32), vout: 1, value: 95_000 }] };
        }
        const script = hex.decode(opts.scripts[0]!);
        const last = submitted.at(-1);
        if (last) {
          creating = Transaction.fromPSBT(base64.decode(last));
        } else {
          creating = new Transaction({ version: 3, allowUnknownOutputs: true });
          creating.addInput({ txid: new Uint8Array(32).fill(8), index: 1 });
          creating.addOutput({ script, amount: 330n });
          creating.addOutput(Extension.create([statePacket(genesisState())]).txOut());
        }
        return { vtxos: [{ txid: creating.id, vout: 0, value: 330, assets: [{ assetId, amount: 1n }] }] };
      },
      async getVirtualTxs(txids) {
        if (!creating || txids[0] !== creating.id) return { txs: [] };
        return { txs: [base64.encode(creating.toPSBT())] };
      },
    },
    emulator: {
      async submitTx(arkTx, checkpointTxs = []) {
        submitted.push(arkTx);
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
      },
    },
  });
  try {
    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 200);
    assetId = String(issued.json.assetId);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await ctx.oracle.publishAnnounced();
    const fixings = (await call(ctx.oracle.url, "/api/status")).json.fixings as { expiry: number; price: string }[];
    assert.deepEqual(fixings.map((f) => f.expiry), [expiry]);
    assert.deepEqual(pruned, [expiry]);
  } finally {
    await ctx.close();
  }
});

test("an intent is stored only when the pinned DIA key signed it", async () => {
  assert.equal(intentSigned(RECORDED), true);
  const ctx = await boot({ now: () => RECORDED.time });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    const bad = await call(ctx.oracle.url, "/api/intent", { ...recordedBody(), sig: "ab".repeat(64) }, "test-token");
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "dia signature");
    const tampered = await call(ctx.oracle.url, "/api/intent", recordedBody({ ...RECORDED, price: RECORDED.price + 1n }), "test-token");
    assert.equal(tampered.status, 400);
    assert.equal(tampered.json.error, "dia signature");
    const stored = await call(ctx.oracle.url, "/api/intent", recordedBody(), "test-token");
    assert.equal(stored.status, 200, JSON.stringify(stored.json));
    assert.equal(stored.json.price, centsOf(RECORDED.price).toString());
    assert.equal(stored.json.time, RECORDED.time);
    const again = await call(ctx.oracle.url, "/api/intent", recordedBody(), "test-token");
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.samples, 1);
  } finally {
    await ctx.close();
  }
});

test("ingestIntent stores distinct DIA intents immediately, skips before issue, and exposes signed samples", async () => {
  const ctx = await boot({ now: () => RECORDED.time });
  try {
    await ctx.oracle.ingestIntent(RECORDED);
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.samples, 0);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    await ctx.oracle.ingestIntent(RECORDED);
    await ctx.oracle.ingestIntent(RECORDED);
    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.samples, 1);
    assert.equal((status.json.latest as { price?: string } | null)?.price, centsOf(RECORDED.price).toString());
    const res = await fetch(`${ctx.oracle.url}/api/prices?from=${RECORDED.time - 10}&to=${RECORDED.time + 10}&signed=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { samples: { price: string; time: number; raw?: string; nonce?: string; intentExpiry?: number; sig?: string }[] };
    assert.equal(body.samples.length, 1);
    assert.equal(body.samples[0]?.raw, RECORDED.price.toString());
    assert.equal(body.samples[0]?.nonce, RECORDED.nonce.toString());
    assert.equal(body.samples[0]?.intentExpiry, RECORDED.intentExpiry);
    assert.equal(body.samples[0]?.sig, bytesToHex(RECORDED.sig));
  } finally {
    await ctx.close();
  }
});

test("status reports beaconExpiry for live and past coins, and 0 when deployed coin is swept or missing", async () => {
  const expectedExpiry = 1_700_050_000;
  let assetId = "";
  let vtxos: HeldCoin[] = [];
  const ctx = await boot({
    indexer: {
      async getVtxos() {
        return { vtxos };
      },
      async getVirtualTxs() {
        return { txs: [] };
      },
    },
  });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.beaconExpiry, null);
    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 200);
    assetId = String(issued.json.assetId);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);

    vtxos = [];
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.beaconExpiry, 0);

    vtxos = [{ txid: "aa".repeat(32), vout: 0, value: 330, isSwept: true, expiresAt: new Date(expectedExpiry * 1000), assets: [{ assetId, amount: 1n }] }];
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.beaconExpiry, 0);

    const pastExpiry = 1_699_000_000;
    vtxos = [{ txid: "aa".repeat(32), vout: 0, value: 330, expiresAt: new Date(pastExpiry * 1000), assets: [{ assetId, amount: 1n }] }];
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.beaconExpiry, pastExpiry);

    vtxos = [{ txid: "aa".repeat(32), vout: 0, value: 330, expiresAt: new Date(expectedExpiry * 1000), assets: [{ assetId, amount: 1n }] }];
    assert.equal((await call(ctx.oracle.url, "/api/status")).json.beaconExpiry, expectedExpiry);
  } finally {
    await ctx.close();
  }
});

test("duePositionExpiries restricts auto-publishing to allowedPubkey when configured", () => {
  const txid = "ee".repeat(32);
  const assetId = asset.AssetId.create(txid, 0).toString();
  const desk = "11".repeat(32);
  const attacker = "99".repeat(32);
  const base = 1_700_000_100;
  const make = (rfq: string, writer: string, holder: string, expiry: number): OptionPosition => ({
    v: 1,
    type: "option_position",
    program_id: OPTION_VAULT_PROGRAM_ID,
    rfq_id: rfq.repeat(32),
    pair: PAIR,
    kind: 0,
    collateral: "50000",
    strike: "9000000",
    expiry,
    exit: Number(EXIT),
    writer_pubkey: writer,
    writer_pk_script: "5120" + "22".repeat(32),
    holder_pubkey: holder,
    beacon_txid: txid,
    beacon_gidx: 0,
    vault_address: "tark1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    fill_txid: rfq.repeat(32),
  });
  const positions = [
    make("aa", attacker, attacker, base + 900),
    make("bb", desk, attacker, base + 600),
    make("cc", attacker, desk, base + 300),
    make("dd", desk, attacker, base + 450),
  ];
  const filtered = duePositionExpiries(positions, { assetId, now: base + 1_200, done: new Set(), allowedPubkey: desk });
  assert.deepEqual(filtered.map((item) => item.expiry), [base + 300, base + 600]);
});

test("renew refuses with 409 live vault open while any filled position vault is unspent, and ignores unfunded announcements", async () => {
  const expiry = 1_700_000_100;
  const ourTxid = "ee".repeat(32);
  const serverKey = await SingleKey.fromHex(hex.encode(secret(1))).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex(hex.encode(secret(2))).compressedPublicKey();
  const deskPk = await SingleKey.fromHex(hex.encode(secret(21))).xOnlyPublicKey();
  const bettorPk = await SingleKey.fromHex(hex.encode(secret(22))).xOnlyPublicKey();
  const beacon = beaconIdOf(asset.AssetId.create(ourTxid, 0));
  const liveVault = bindContracts({
    kind: 0,
    strike: 8_000_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: BigInt(expiry),
    deadline: BigInt(expiry),
    exit: EXIT,
    writerPk: deskPk,
    holderPk: bettorPk,
    beacon,
    readFee: BEACON_READ_FEE,
    serverKey,
    emulatorKey,
  });
  const fakeVault = bindContracts({
    kind: 0,
    strike: 8_500_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: BigInt(expiry + 3_600),
    deadline: BigInt(expiry + 3_600),
    exit: EXIT,
    writerPk: deskPk,
    holderPk: bettorPk,
    beacon,
    readFee: BEACON_READ_FEE,
    serverKey,
    emulatorKey,
  });
  const liveScriptHex = bytesToHex(liveVault.vaultPkScript);
  const fakeScriptHex = bytesToHex(fakeVault.vaultPkScript);
  let clock = expiry - 60;
  let vaultLive = true;
  let assetId = "";
  let creating: Transaction | undefined;
  let reboardReached = false;
  const announced: OptionPosition[] = [
    {
      v: 1,
      type: "option_position",
      program_id: OPTION_VAULT_PROGRAM_ID,
      rfq_id: "cc".repeat(32),
      pair: PAIR,
      kind: 0,
      collateral: "95000",
      strike: "8000000",
      expiry,
      exit: Number(EXIT),
      writer_pubkey: bytesToHex(deskPk),
      writer_pk_script: bytesToHex(liveVault.writerPkScript),
      holder_pubkey: bytesToHex(bettorPk),
      beacon_txid: ourTxid,
      beacon_gidx: 0,
      vault_address: liveVault.vaultAddress,
      fill_txid: "cc".repeat(32),
    },
    {
      v: 1,
      type: "option_position",
      program_id: OPTION_VAULT_PROGRAM_ID,
      rfq_id: "dd".repeat(32),
      pair: PAIR,
      kind: 0,
      collateral: "95000",
      strike: "8500000",
      expiry: expiry + 3_600,
      exit: Number(EXIT),
      writer_pubkey: bytesToHex(deskPk),
      writer_pk_script: bytesToHex(fakeVault.writerPkScript),
      holder_pubkey: bytesToHex(bettorPk),
      beacon_txid: ourTxid,
      beacon_gidx: 0,
      vault_address: fakeVault.vaultAddress,
      fill_txid: "dd".repeat(32),
    },
  ];
  const ctx = await boot({
    now: () => clock,
    announcedPositions: () => announced,
    sdkNetwork: networks.mutinynet,
    arkProvider: {} as unknown as OracleDeps["arkProvider"],
    emulator: {
      async submitTx(arkTx, checkpointTxs = []) {
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
      },
      async submitIntent() {
        reboardReached = true;
        throw new Error("reboard-sentinel");
      },
    },
    indexer: {
      async getVtxos(opts) {
        if (opts.scripts.includes(liveScriptHex)) {
          return { vtxos: vaultLive ? [{ txid: "cc".repeat(32), vout: 1, value: 95_000 }] : [] };
        }
        if (opts.scripts.includes(fakeScriptHex)) {
          return { vtxos: [] };
        }
        const script = hex.decode(opts.scripts[0]!);
        if (!creating) {
          creating = new Transaction({ version: 3, allowUnknownOutputs: true });
          creating.addInput({ txid: new Uint8Array(32).fill(8), index: 1 });
          creating.addOutput({ script, amount: 330n });
          creating.addOutput(Extension.create([statePacket(genesisState())]).txOut());
        }
        return { vtxos: [{ txid: creating.id, vout: 0, value: 330, assets: [{ assetId, amount: 1n }] }] };
      },
      async getVirtualTxs(txids) {
        if (!creating || txids[0] !== creating.id) return { txs: [] };
        return { txs: [base64.encode(creating.toPSBT())] };
      },
    },
  });
  try {
    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 200);
    assetId = String(issued.json.assetId);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);

    // Unexpired filled vault blocks renew.
    const beforeExpiry = await call(ctx.oracle.url, "/api/renew", {}, "test-token");
    assert.equal(beforeExpiry.status, 409);
    assert.equal(beforeExpiry.json.error, "live vault open");
    assert.equal(reboardReached, false);

    // Expired/attested-but-unsettled vault still blocks renew.
    clock = expiry + 600;
    const afterExpiry = await call(ctx.oracle.url, "/api/renew", {}, "test-token");
    assert.equal(afterExpiry.status, 409);
    assert.equal(afterExpiry.json.error, "live vault open");
    assert.equal(reboardReached, false);

    // Once settled, renew passes the guard (ignoring the unfunded future announcement) and enters reboard.
    vaultLive = false;
    const afterSettle = await call(ctx.oracle.url, "/api/renew", {}, "test-token");
    assert.equal(reboardReached, true);
    assert.equal(afterSettle.status, 500);
  } finally {
    await ctx.close();
  }
});

test("publishAnnounced does not leapfrog to a later close when an earlier close fails transiently", async () => {
  const first = 1_700_000_100;
  const second = first + 300;
  let failOnce = true;
  const submitted: string[] = [];
  const ctx = await boot({
    now: () => second + 120,
    announcedExpiries: () => [second, first],
    samples: [storedSample("9900000", first + 10), storedSample("10000000", second + 10)],
    emulator: {
      async submitTx(arkTx, checkpointTxs = []) {
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary emulator outage");
        }
        submitted.push(arkTx);
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
      },
    },
  });
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await ctx.oracle.publishAnnounced();
    // First close failed transiently; second close must NOT be published out of order.
    assert.equal(submitted.length, 0);
    assert.deepEqual((await call(ctx.oracle.url, "/api/status")).json.fixings, []);

    // Next pass recovers and publishes both in strict chronological order.
    await ctx.oracle.publishAnnounced();
    const fixings = (await call(ctx.oracle.url, "/api/status")).json.fixings as { expiry: number }[];
    assert.deepEqual(fixings.map((f) => f.expiry), [first, second]);
  } finally {
    console.error = log;
    await ctx.close();
  }
});

test("stateless oracle waits for window settlement before freezing, signs idempotently, and prunes old fixings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-stateless-"));
  const expiry = 1_700_000_100; // multiple of 300
  const oracleKey = secret(9);
  const oraclePk = schnorr.getPublicKey(oracleKey);
  const oraclePkHex = bytesToHex(oraclePk);
  await saveStore(dir, {
    assetId: null,
    issueTxid: null,
    deployTxid: null,
    samples: [storedSample("9950000", expiry + 12)],
    fixings: [],
  });
  let clock = expiry + 59;
  const oracle = await createOracle({
    dataDir: dir,
    oracleKey,
    stateless: true,
    now: () => clock,
  });
  try {
    const status = await call(oracle.url, "/api/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.json.pubkeys, [oraclePkHex]);
    assert.equal((status.json.args as { adminPk?: string }).adminPk, oraclePkHex);
    assert.equal(status.json.assetId, null);

    // Before expiry + 60, off-grid, and future closes all fail cleanly.
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry}`)).status, 400);
    clock = expiry + 60;
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 60}`)).status, 400);
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 300}`)).status, 400);

    // At expiry + 60 without a post-window sample (> expiry + 60) and before grace expires, returns 425 (do not prematurely freeze).
    const waiting = await call(oracle.url, `/api/fixing?expiry=${expiry}`);
    assert.equal(waiting.status, 425, JSON.stringify(waiting.json));
    assert.equal(waiting.json.error, "waiting for close print");

    // Once grace elapses (expiry + 60 + FIXING_GRACE_S), concurrent callers get the exact same canonical fixing.
    clock = expiry + 60 + FIXING_GRACE_S;
    const [first, concurrent] = await Promise.all([
      call(oracle.url, `/api/fixing?expiry=${expiry}`),
      call(oracle.url, `/api/fixing?expiry=${expiry}`),
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(concurrent.status, 200);
    assert.deepEqual(concurrent.json, first.json);
    assert.equal(first.json.expiry, expiry);
    assert.equal(first.json.price, "9950000");
    assert.equal(first.json.time, expiry + 12);
    assert.equal(first.json.oraclePk, oraclePkHex);
    const digest = predictFixDigest({ expiry: BigInt(expiry), cents: 9_950_000n, time: BigInt(expiry + 12) });
    assert.equal(schnorr.verify(hex.decode(String(first.json.oracleSig)), digest, oraclePk), true);
    const persisted = await loadStore(dir);
    assert.equal(persisted.fixings.filter((row) => row.expiry === expiry).length, 1);

    // Missing sample on an already-closed window past grace returns 404 (never falls back to pre-expiry sample).
    clock = expiry + 360 + FIXING_GRACE_S;
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 300}`)).status, 404);
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deterministic fixing waits for a post-window print so a late in-window sample is included", async () => {
  const expiry = 1_794_696_000;
  const lag = 60;
  assert.equal(windowSettled([{ time: expiry + 10 }], expiry, lag, expiry + 60), false);
  assert.equal(windowSettled([{ time: expiry + 10 }, { time: expiry + 60 }], expiry, lag, expiry + 60), false);
  assert.equal(windowSettled([{ time: expiry + 10 }, { time: expiry + 61 }], expiry, lag, expiry + 60), true);
  assert.equal(windowSettled([{ time: expiry + 10 }], expiry, lag, expiry + 60 + FIXING_GRACE_S), true);
  assert.equal(chooseStrictSample([{ time: expiry - 1, price: "1" }], expiry, lag), null);
  assert.equal(chooseStrictSample([{ time: expiry + 10, price: "1" }, { time: expiry + 58, price: "2" }, { time: expiry + 62, price: "3" }], expiry, lag)?.price, "2");

  const pruned = pruneFixings([
    { expiry: expiry - FIXING_HISTORY_S - 1, price: "1", txid: "" },
    { expiry: expiry - FIXING_HISTORY_S, price: "2", txid: "" },
  ], expiry);
  assert.deepEqual(pruned.map((row) => row.price), ["2"]);

  // A real DIA sample inside [expiry, expiry + 60] passes parseOracleFixing, and forged/mismatched signatures fail.
  const oracleKey = secret(11);
  const oraclePk = schnorr.getPublicKey(oracleKey);
  const oraclePkHex = bytesToHex(oraclePk);
  const recExpiry = Math.floor(RECORDED.time / 300) * 300; // 1794696000; RECORDED.time = 1794696202 -> wait: shift by grid
  assert.equal(recExpiry % 300, 0);
  // RECORDED.time is 1794696202 (202s past 1794696000); check parseOracleFixing rejects out-of-window timestamps and forged oracleSig.
  const badWindow = parseOracleFixing({
    expiry: recExpiry,
    price: centsOf(RECORDED.price).toString(),
    time: RECORDED.time,
    raw: RECORDED.price.toString(),
    nonce: RECORDED.nonce.toString(),
    intentExpiry: RECORDED.intentExpiry,
    sig: bytesToHex(RECORDED.sig),
    oracleSig: bytesToHex(schnorr.sign(predictFixDigest({ expiry: BigInt(recExpiry), cents: centsOf(RECORDED.price), time: BigInt(RECORDED.time) }), oracleKey)),
    oraclePk: oraclePkHex,
  }, oraclePkHex);
  assert.equal(badWindow, null);

  // Real recorded print inside [1795593000, 1795593060] passes and rejects wrong oracle key or tampered sig.
  const inWindow = {
    expiry: 1_795_593_000,
    price: "5872826",
    time: 1_795_593_002,
    raw: "58728258984125017358336",
    nonce: "1793790301274586439",
    intentExpiry: 1_795_596_602,
    sig: "7980c73f7210211fd2887cc55bd0df6e049ccb57771131a81ed1bb655a6b52887fa15bb26be0e35f0de52badce56190ec3df541814e8652d0f9314a088c26280",
    oracleSig: bytesToHex(schnorr.sign(predictFixDigest({ expiry: 1_795_593_000n, cents: 5_872_826n, time: 1_795_593_002n }), oracleKey)),
    oraclePk: oraclePkHex,
  };
  const valid = parseOracleFixing(inWindow, oraclePkHex);
  assert.ok(valid);
  assert.equal(valid.cents, 5_872_826n);
  assert.equal(parseOracleFixing(inWindow, "00".repeat(32)), null);
  assert.equal(parseOracleFixing({ ...inWindow, oracleSig: "aa".repeat(64) }, oraclePkHex), null);
  assert.equal(parseOracleFixing({ ...inWindow, sig: "bb".repeat(64) }, oraclePkHex), null);
});
