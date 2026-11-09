import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, asset, CSVMultisigTapscript, Extension, networks, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

import { beaconIdOf, bindBeacon, decodeState, genesisState, nextState, priceValue, sampleDigest, statePacketOf } from "../protocol/beacon.ts";
import { EXIT } from "../protocol/constants.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { createOracle, dueExpiries, skippedPublish, type HeldCoin, type OracleDeps, type OracleWallet } from "./service.ts";
import { chooseSample, loadStore, pruneSamples, SAMPLE_HISTORY_S, saveStore } from "./store.ts";

const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";

spawnSync("pnpm", ["-s", "oracle:page"], { cwd: path.resolve(import.meta.dirname, ".."), stdio: "inherit" });

function secret(byte: number): Uint8Array {
  return Uint8Array.from(hex.decode(byte.toString(16).padStart(2, "0").repeat(32)));
}

async function boot(extra: Partial<OracleDeps> & { adminToken?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-"));
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
  const oracle = await createOracle({
    dataDir: dir,
    adminToken: "test-token",
    oracleKey: secret(9),
    emulatorKey,
    wallet,
    indexer: {
      async getVtxos(opts) {
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
      async getVirtualTxs(txids) {
        if (!creating || txids[0] !== creating.id) return { txs: [] };
        return { txs: [base64.encode(creating.toPSBT())] };
      },
    },
    emulator: {
      async submitTx(arkTx) {
        submitted.push(arkTx);
        return { signedArkTx: arkTx };
      },
    },
    now: () => 1_700_000_000 + 60,
    ...extra,
  });
  return { oracle, dir, recorded, submitted, serverKey, emulatorKey, other, wallet, close: async () => { await oracle.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function call(url: string, pathName: string, body?: unknown, token?: string) {
  const res = await fetch(url + pathName, {
    method: body === undefined && pathName.startsWith("/api/") && pathName !== "/api/status" ? "POST" : body === undefined ? "GET" : "POST",
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
  const ctx = await boot();
  try {
    const home = await fetch(ctx.oracle.url + "/");
    assert.equal(home.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'");
    assert.equal(home.headers.get("access-control-allow-origin"), null);
    const html = await home.text();
    assert.match(html, /src="\/page\.js"/);
    assert.match(html, /id="settle-price"/);
    assert.match(html, /id="publish-price"/);
    assert.match(html, /id="payout"/);
    assert.match(html, /id="sample-time"/);
    assert.match(html, /Testing only/);
    const timeInput = html.match(/<input id="sample-time"[^>]*>/)?.[0] ?? "";
    assert.equal(timeInput.includes("value="), false);
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
    assert.equal(open.json.samples, 0);
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
      signers: [schnorr.getPublicKey(secret(9))],
      threshold: 1n,
      domain: new TextEncoder().encode("BTCUSD-FIX"),
      expiryLag: 60n,
      readFee: 1_000n,
      adminPk: schnorr.getPublicKey(secret(9)),
      exit: EXIT,
      serverKey: ctx.serverKey,
      emulatorKey: ctx.emulatorKey,
    });
    assert.equal(status.json.address, bound.address);

    const expiry = 1_700_000_000n;
    const huge = await fetch(ctx.oracle.url + "/api/samples", { method: "POST", body: "x".repeat(5000), headers: { "content-type": "application/json", authorization: "Bearer test-token" } });
    assert.equal(huge.status, 413);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "10000000", extra: 1 }, "test-token")).status, 400);
    const recorded = await call(ctx.oracle.url, "/api/samples", { price: "10000000" }, "test-token");
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    const againSample = await call(ctx.oracle.url, "/api/samples", { price: "10000000" }, "test-token");
    assert.equal(againSample.status, 200);
    assert.equal(againSample.json.duplicate, true);
    const historyRes = await fetch(ctx.oracle.url + `/api/prices?from=${expiry}&to=${expiry + 60n}`);
    const history = (await historyRes.json()) as { samples: Record<string, unknown>[] };
    assert.equal(history.samples.length, 1);
    assert.equal("sigs" in history.samples[0]!, false);

    const disabled = await boot({ adminToken: undefined, now: () => Number(expiry + 60n) });
    assert.equal((await call(disabled.oracle.url, "/api/samples", { price: "1" }, "test-token")).status, 404);
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
    const again = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(again.status, 409);
    const after = await call(ctx.oracle.url, "/api/status");
    assert.deepEqual(after.json.fixings, [{ expiry: Number(expiry), price: "10000000", time: Number(expiry + 60n), txid: published.json.txid }]);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    const next = nextState(genesisState(), expiry, priceValue(10_000_000n, expiry + 60n));
    assert.deepEqual(statePacketOf(tx), next);
    const witness = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.witness!;
    const ctrl = beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid;
    const digest = sampleDigest(ctrl, expiry, 10_000_000n, expiry + 60n);
    const pubkey = schnorr.getPublicKey(secret(9));
    let found = false;
    for (let i = 0; i + 64 <= witness.length; i += 1) {
      try {
        if (schnorr.verify(witness.subarray(i, i + 64), digest, pubkey)) found = true;
      } catch {
        // not a signature at this offset
      }
    }
    assert.equal(found, true, bytesToHex(witness));
    const shifted = sampleDigest(ctrl, expiry, 10_000_001n, expiry + 60n);
    let shiftedOk = false;
    for (let i = 0; i + 64 <= witness.length; i += 1) {
      try {
        if (schnorr.verify(witness.subarray(i, i + 64), shifted, pubkey)) shiftedOk = true;
      } catch {
        // a one-cent change is not this signature
      }
    }
    assert.equal(shiftedOk, false);
  } finally {
    await ctx.close();
  }
});

test("admin backdate publishes a sample inside a closed window", async () => {
  const expiry = 1_791_821_976;
  const sampleTime = 1_791_822_006;
  const price = "8277570";
  const ctx = await boot({ now: () => expiry + 120 });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price, time: sampleTime })).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price, time: 0 }, "test-token")).status, 400);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price, time: expiry + 121 }, "test-token")).status, 400);
    const beforeKey = await call(ctx.oracle.url, "/api/samples", { price: "1", time: expiry - 1 }, "test-token");
    assert.equal(beforeKey.status, 200, JSON.stringify(beforeKey.json));
    const recorded = await call(ctx.oracle.url, "/api/samples", { price, time: sampleTime }, "test-token");
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    assert.equal(recorded.json.time, sampleTime);
    assert.equal(recorded.json.price, price);
    const published = await call(ctx.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.expiry, expiry);
    assert.equal(published.json.price, price);
    assert.equal(published.json.time, sampleTime);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    assert.deepEqual(statePacketOf(tx), nextState(genesisState(), BigInt(expiry), priceValue(BigInt(price), BigInt(sampleTime))));
    const witness = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.witness!;
    const digest = sampleDigest(beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid, BigInt(expiry), BigInt(price), BigInt(sampleTime));
    const pubkey = schnorr.getPublicKey(secret(9));
    let found = false;
    for (let i = 0; i + 64 <= witness.length; i += 1) {
      try {
        if (schnorr.verify(witness.subarray(i, i + 64), digest, pubkey)) found = true;
      } catch {
        // not a signature at this offset
      }
    }
    assert.equal(found, true, bytesToHex(witness));
  } finally {
    await ctx.close();
  }
});

function verifies(sig: Uint8Array, digest: Uint8Array, pub: Uint8Array): boolean {
  try {
    return schnorr.verify(sig, digest, pub) === true;
  } catch {
    return false;
  }
}

test("a print before the expiry is rejected and a print inside the minute is accepted", async () => {
  const expiry = 1_700_000_000;
  const ctx = await boot({ now: () => expiry + 120 });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    const early = await call(ctx.oracle.url, "/api/samples", { price: "10000000", time: expiry - 1 }, "test-token");
    assert.equal(early.status, 200, JSON.stringify(early.json));
    const rejected = await call(ctx.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, "sample before expiry");
    assert.equal(ctx.submitted.length, 0);

    const inside = await call(ctx.oracle.url, "/api/samples", { price: "10000000", time: expiry + 30 }, "test-token");
    assert.equal(inside.status, 200, JSON.stringify(inside.json));
    const accepted = await call(ctx.oracle.url, "/api/publish", { expiry }, "test-token");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.price, "10000000");
    assert.equal(accepted.json.time, expiry + 30);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    assert.deepEqual(statePacketOf(tx), nextState(genesisState(), BigInt(expiry), priceValue(10_000_000n, BigInt(expiry + 30))));
  } finally {
    await ctx.close();
  }
});

test("a one-cent price change fails verification", async () => {
  const secretKey = secret(9);
  const pub = schnorr.getPublicKey(secretKey);
  const ctrl = beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid;
  const expiry = 1_700_000_000n;
  const price = 8_277_570n;
  const time = expiry + 15n;
  const digest = sampleDigest(ctrl, expiry, price, time);
  const sig = await SingleKey.fromHex(hex.encode(secretKey)).signSchnorrDeterministic(digest);
  assert.equal(verifies(sig, digest, pub), true);
  assert.equal(verifies(sig, sampleDigest(ctrl, expiry, price + 1n, time), pub), false);
  assert.equal(verifies(sig, sampleDigest(ctrl, expiry + 60n, price, time), pub), false);
});

test("an evicted expiry is rewritten with the same price and time", async () => {
  const base = 1_700_000_000;
  const ctx = await boot({ now: () => base + 800 + 60 });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "111", time: base + 10 }, "test-token")).status, 200);
    const first = await call(ctx.oracle.url, "/api/publish", { expiry: base }, "test-token");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.price, "111");
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "999", time: base + 50 }, "test-token")).status, 200);
    for (let i = 1; i <= 8; i += 1) {
      const expiry = base + i * 100;
      assert.equal((await call(ctx.oracle.url, "/api/samples", { price: String(2_000 + i), time: expiry + 10 }, "test-token")).status, 200);
      const published = await call(ctx.oracle.url, "/api/publish", { expiry }, "test-token");
      assert.equal(published.status, 200, JSON.stringify(published.json));
    }
    const again = await call(ctx.oracle.url, "/api/publish", { expiry: base }, "test-token");
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.price, "111");
    assert.equal(again.json.time, base + 10);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted.at(-1)!));
    const decoded = decodeState(statePacketOf(tx));
    assert.equal(decoded.slots[0]?.expiry, BigInt(base));
    assert.deepEqual(decoded.slots[0]?.value, priceValue(111n, BigInt(base + 10)));
    assert.equal(decoded.slots.some((item) => item.expiry === BigInt(base + 100)), false);
  } finally {
    await ctx.close();
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
    assert.equal(state?.settings?.hasPendingTx, true);
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
    quote: async () => 8_275_570n,
    sampleEveryMs: 60_000,
    now: () => 1_791_822_000,
  });
  try {
    assert.equal((await call(oracle.url, "/api/samples", { price: "1" })).status, 404);
    let samples = 0;
    let latest: { price?: string; time?: number } | null = null;
    for (let i = 0; i < 40 && samples < 1; i++) {
      const status = await call(oracle.url, "/api/status");
      samples = Number(status.json.samples);
      latest = status.json.latest as { price?: string; time?: number } | null;
      if (samples < 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(samples, 1);
    assert.equal(latest?.price, "8275570");
    assert.equal(latest?.time, 1_791_822_000);
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a print before the expiry or after the close is skipped on the minute pass", async () => {
  assert.equal(skippedPublish("sample before expiry"), true);
  assert.equal(skippedPublish("sample after close"), true);
  assert.equal(skippedPublish("beacon coin"), false);
  const expiry = 1_700_000_000;
  const later = expiry + 80;
  const ctx = await boot({ now: () => expiry + 200, announcedExpiries: () => [expiry, later] });
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "10000000", time: expiry - 1 }, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "10000000", time: later + 61 }, "test-token")).status, 200);
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
  const expiry = 1_700_000_000;
  const done = new Set<number>([expiry - 10]);
  assert.deepEqual(dueExpiries([expiry + 86_400, expiry, expiry, expiry - 10], expiry + 60, done), [expiry]);
  assert.deepEqual(dueExpiries([expiry], expiry + 59, done), []);
});

test("the minute pass publishes an announced expiry once a sample exists", async () => {
  const expiry = 1_700_000_000;
  const later = expiry + 86_400;
  const missed = expiry - 120;
  const announced = new Set<number>([later, expiry, missed]);
  const ctx = await boot({ now: () => expiry + 60, announcedExpiries: () => announced });
  try {
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 200);
    await ctx.oracle.publishAnnounced();
    assert.deepEqual((await call(ctx.oracle.url, "/api/status")).json.fixings, []);
    assert.equal((await call(ctx.oracle.url, "/api/samples", { price: "10000000" }, "test-token")).status, 200);
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
