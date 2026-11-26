import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

import { centsOf, intentSigned, SCALE, type DiaIntent } from "../protocol/dia.ts";
import { predictFixDigest } from "../protocol/fixing.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { parseOracleFixing } from "../settle/oracle.ts";
import { createOracle } from "./service.ts";
import {
  chooseSample,
  FIXING_GRACE_S,
  FIXING_HISTORY_S,
  openOracleStore,
  pruneFixings,
  pruneSamples,
  SAMPLE_HISTORY_S,
  windowSettled,
  type StoredFixing,
  type StoredSample,
} from "./store.ts";

function secret(byte: number): Uint8Array {
  return Uint8Array.from(hex.decode(byte.toString(16).padStart(2, "0").repeat(32)));
}

const DIA_SIG = "11".repeat(64);

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

/** Real Lasernet BTC/USD OracleUpdate prints signed by the pinned DIA key on 5-minute closes. */
const RECORDED: DiaIntent = {
  price: 58728258984125017358336n,
  time: 1795593002,
  nonce: 1793790301274586439n,
  intentExpiry: 1795596602,
  sig: Buffer.from("7980c73f7210211fd2887cc55bd0df6e049ccb57771131a81ed1bb655a6b52887fa15bb26be0e35f0de52badce56190ec3df541814e8652d0f9314a088c26280", "hex"),
};

const RECORDED_LATER: DiaIntent = {
  price: 58625783362453267021824n,
  time: 1795593302,
  nonce: 1793790301274586451n,
  intentExpiry: 1795596902,
  sig: Buffer.from("20ff8e96d370f05b83595e832a8825505ccdaa12633f2ef12186cc851ed0af0d1b4a3b1cd5a066df39fe5c244748997f06c367ee9b60ed2bc7378590eaf07af4", "hex"),
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
  const res = await fetch(url + pathName, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
}

test("chooseSample picks the newest sample strictly inside [expiry, expiry + lag]", () => {
  const expiry = 1_000_000;
  const lag = 60;
  const before = { time: expiry - 1, price: "1" };
  const atOpen = { time: expiry, price: "2" };
  const inside = { time: expiry + 10, price: "3" };
  const later = { time: expiry + 20, price: "5" };
  const atClose = { time: expiry + lag, price: "6" };
  const after = { time: expiry + lag + 1, price: "4" };

  assert.equal(chooseSample([before], expiry, lag), null);
  assert.equal(chooseSample([after], expiry, lag), null);
  assert.equal(chooseSample([before, after], expiry, lag), null);
  assert.equal(chooseSample([before, atOpen], expiry, lag)?.price, "2");
  assert.equal(chooseSample([before, inside, after], expiry, lag)?.price, "3");
  assert.equal(chooseSample([inside, later, before], expiry, lag)?.price, "5");
  assert.equal(chooseSample([inside, atClose, after], expiry, lag)?.price, "6");
});

test("SQLite WAL store uses WAL + synchronous=FULL, migrates legacy oracle.json once, and enforces anti-equivocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-store-"));
  try {
    const legacyFixing: StoredFixing = {
      expiry: 1_795_593_000,
      price: "5872826",
      time: 1_795_593_002,
      raw: "58728258984125017358336",
      nonce: "1793790301274586439",
      intentExpiry: 1_795_596_602,
      sig: DIA_SIG,
      oracleSig: "aa".repeat(64),
    };
    await writeFile(path.join(dir, "oracle.json"), JSON.stringify({
      assetId: "legacy-ignored",
      issueTxid: "ee".repeat(32),
      deployTxid: "dd".repeat(32),
      samples: [{ price: "10", time: 50, sigs: ["aa".repeat(64)] }],
      fixings: [legacyFixing],
    }));

    const store = await openOracleStore(dir);
    try {
      assert.equal(store.journalMode(), "wal");
      assert.equal(store.synchronousMode(), 2); // FULL
      assert.equal(existsSync(path.join(dir, "oracle.json")), false);
      assert.equal(existsSync(path.join(dir, "oracle.json.migrated")), true);
      assert.equal(store.sampleCount(), 1);
      assert.equal(store.latestSample()?.price, "10");
      assert.equal(store.latestSample()?.time, 50);
      assert.equal(store.fixingCount(), 1);
      assert.deepEqual(store.getFixing(legacyFixing.expiry), legacyFixing);

      // Anti-equivocation: inserting a conflicting fixing for the same expiry keeps the original row intact.
      const conflicting: StoredFixing = {
        ...legacyFixing,
        price: "9999999",
        time: 1_795_593_050,
        oracleSig: "bb".repeat(64),
      };
      const returned = store.insertFixing(conflicting);
      assert.deepEqual(returned, legacyFixing);
      assert.deepEqual(store.getFixing(legacyFixing.expiry), legacyFixing);
      assert.equal(store.fixingCount(), 1);
    } finally {
      store.close();
    }
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

test("status, /api/intent validation, auth, and /api/prices", async () => {
  assert.equal(intentSigned(RECORDED), true);
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-svc-"));
  const oracleKey = secret(9);
  const oraclePkHex = bytesToHex(schnorr.getPublicKey(oracleKey));
  const oracle = await createOracle({
    dataDir: dir,
    adminToken: "test-token",
    oracleKey,
    finalizeEveryMs: 0,
    now: () => RECORDED.time,
  });
  try {
    const status = await call(oracle.url, "/api/status");
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(JSON.stringify(status.json).includes(hex.encode(oracleKey)), false);
    assert.deepEqual(status.json.pubkeys, [oraclePkHex]);
    assert.equal((status.json.args as { domain: string }).domain, hex.encode(new TextEncoder().encode("BTCUSD-FIX")));
    assert.equal((status.json.args as { expiryLag: number }).expiryLag, 60);
    assert.equal((status.json.args as { adminPk: string }).adminPk, oraclePkHex);
    assert.equal(status.json.samples, 0);
    assert.equal(status.json.fixingCount, 0);

    // Auth, size cap, unknown field, future timestamp, and bad signature are rejected.
    assert.equal((await call(oracle.url, "/api/intent", recordedBody())).status, 401);
    assert.equal((await call(oracle.url, "/api/intent", recordedBody(), "wrong")).status, 401);
    const huge = await fetch(oracle.url + "/api/intent", {
      method: "POST",
      body: "x".repeat(5000),
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    });
    assert.equal(huge.status, 413);
    assert.equal((await call(oracle.url, "/api/intent", { ...recordedBody(), extra: 1 }, "test-token")).status, 400);
    assert.equal((await call(oracle.url, "/api/intent", recordedBody({ ...RECORDED, time: RECORDED.time + 1 }), "test-token")).status, 400);
    const badSig = await call(oracle.url, "/api/intent", { ...recordedBody(), sig: "ab".repeat(64) }, "test-token");
    assert.equal(badSig.status, 400);
    assert.equal(badSig.json.error, "dia signature");
    const tampered = await call(oracle.url, "/api/intent", recordedBody({ ...RECORDED, price: RECORDED.price + 1n }), "test-token");
    assert.equal(tampered.status, 400);
    assert.equal(tampered.json.error, "dia signature");

    // Valid DIA intent stores once and deduplicates retries.
    const stored = await call(oracle.url, "/api/intent", recordedBody(), "test-token");
    assert.equal(stored.status, 200, JSON.stringify(stored.json));
    assert.equal(stored.json.price, centsOf(RECORDED.price).toString());
    assert.equal(stored.json.time, RECORDED.time);
    const dup = await call(oracle.url, "/api/intent", recordedBody(), "test-token");
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);

    const unsigned = await call(oracle.url, `/api/prices?from=${RECORDED.time - 10}&to=${RECORDED.time + 10}`);
    const unsignedRows = unsigned.json.samples as Record<string, unknown>[];
    assert.equal(unsignedRows.length, 1);
    assert.equal("sig" in unsignedRows[0]!, false);

    const signed = await call(oracle.url, `/api/prices?from=${RECORDED.time - 10}&to=${RECORDED.time + 10}&signed=1`);
    const signedRows = signed.json.samples as Record<string, unknown>[];
    assert.equal(signedRows.length, 1);
    assert.equal(signedRows[0]?.raw, RECORDED.price.toString());
    assert.equal(signedRows[0]?.nonce, RECORDED.nonce.toString());
    assert.equal(signedRows[0]?.intentExpiry, RECORDED.intentExpiry);
    assert.equal(signedRows[0]?.sig, bytesToHex(RECORDED.sig));
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sampler stores DIA intents without adminToken configured", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-sample-"));
  const oracle = await createOracle({
    dataDir: dir,
    oracleKey: secret(9),
    pull: async () => RECORDED,
    sampleEveryMs: 60_000,
    finalizeEveryMs: 0,
    now: () => RECORDED.time,
  });
  try {
    assert.equal((await call(oracle.url, "/api/intent", recordedBody(), "any")).status, 404);
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

test("GET /api/fixing is strictly read-only, proactive finalizer commits canonical fixings to SQLite WAL, and restarts preserve them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-fixing-"));
  const expiry = 1_700_000_100; // multiple of 300
  const oracleKey = secret(9);
  const oraclePk = schnorr.getPublicKey(oracleKey);
  const oraclePkHex = bytesToHex(oraclePk);
  const seed = await openOracleStore(dir);
  seed.insertSample(storedSample("9900000", expiry - 1));
  seed.insertSample(storedSample("9950000", expiry + 12));
  seed.close();

  let clock = expiry + 59;
  const oracle = await createOracle({
    dataDir: dir,
    oracleKey,
    finalizeEveryMs: 0, // control finalizer explicitly to assert GET /api/fixing never mutates state
    now: () => clock,
  });
  let restarted: Awaited<ReturnType<typeof createOracle>> | null = null;
  try {
    // Before expiry + 60, off-grid, and malformed expiries fail cleanly.
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry}`)).status, 400);
    clock = expiry + 60;
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 60}`)).status, 400);
    assert.equal((await call(oracle.url, "/api/fixing?expiry=abc")).status, 400);
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 300}`)).status, 400);

    // At expiry + 60 without a post-window print (> expiry + 60) and before grace expires, returns 425.
    const waiting = await call(oracle.url, `/api/fixing?expiry=${expiry}`);
    assert.equal(waiting.status, 425, JSON.stringify(waiting.json));
    assert.equal(waiting.json.error, "waiting for close print");
    assert.equal(oracle.finalizeDue(), 0);

    // SEC-02: even after grace elapses, GET /api/fixing is strictly read-only and NEVER signs or writes!
    clock = expiry + 60 + FIXING_GRACE_S;
    const beforeFinalize = await call(oracle.url, `/api/fixing?expiry=${expiry}`);
    assert.equal(beforeFinalize.status, 425);
    assert.equal((await call(oracle.url, "/api/status")).json.fixingCount, 0);

    // Proactive background finalizer commits the canonical fixing into SQLite WAL.
    assert.equal(oracle.finalizeDue(), 1);
    assert.equal(oracle.finalizeDue(), 0); // idempotent

    // Concurrent GET callers read the exact same committed fixing with zero writes.
    const [first, concurrent] = await Promise.all([
      call(oracle.url, `/api/fixing?expiry=${expiry}`),
      call(oracle.url, `/api/fixing?expiry=${expiry}`),
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(concurrent.json, first.json);
    assert.equal(first.json.expiry, expiry);
    assert.equal(first.json.price, "9950000");
    assert.equal(first.json.time, expiry + 12);
    assert.equal(first.json.oraclePk, oraclePkHex);
    const digest = predictFixDigest({ expiry: BigInt(expiry), cents: 9_950_000n, time: BigInt(expiry + 12) });
    assert.equal(schnorr.verify(hex.decode(String(first.json.oracleSig)), digest, oraclePk), true);

    // Closed window past grace with no sample in [expiry, expiry + 60] returns 404 (pre-expiry sample is NOT used).
    clock = expiry + 360 + FIXING_GRACE_S;
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry + 300}`)).status, 404);
    assert.equal((await call(oracle.url, `/api/fixing?expiry=${expiry - 300}`)).status, 404);

    // Restart preserves the exact same committed fixing from oracle.sqlite.
    await oracle.close();
    restarted = await createOracle({ dataDir: dir, oracleKey, finalizeEveryMs: 0, now: () => clock });
    const afterRestart = await call(restarted.url, `/api/fixing?expiry=${expiry}`);
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(afterRestart.json, first.json);
    assert.equal((await call(restarted.url, "/api/status")).json.fixingCount, 1);
  } finally {
    await oracle.close().catch(() => {});
    await restarted?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("ingesting a post-window DIA print proactively finalizes the settled window immediately", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-proactive-"));
  const oracleKey = secret(12);
  const oraclePkHex = bytesToHex(schnorr.getPublicKey(oracleKey));
  const expiry = 1_795_593_000;
  let clock = RECORDED.time;
  const oracle = await createOracle({
    dataDir: dir,
    oracleKey,
    finalizeEveryMs: 0,
    now: () => clock,
  });
  try {
    await oracle.ingestIntent(RECORDED);
    // Still inside the close window -> not finalized yet.
    assert.equal((await call(oracle.url, "/api/status")).json.fixingCount, 0);

    // Advance past expiry + 60 and ingest a post-window DIA print (RECORDED_LATER is at expiry + 302).
    clock = RECORDED_LATER.time;
    await oracle.ingestIntent(RECORDED_LATER);

    // Window 1_795_593_000 is finalized automatically on ingest without waiting for any GET or grace timer.
    const res = await call(oracle.url, `/api/fixing?expiry=${expiry}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const verified = parseOracleFixing(res.json, oraclePkHex);
    assert.ok(verified);
    assert.equal(verified.expiry, expiry);
    assert.equal(verified.cents, centsOf(RECORDED.price));
    assert.equal(verified.time, RECORDED.time);
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("windowSettled waits for a post-window print or grace, pruneFixings bounds retention, and parseOracleFixing verifies signatures", () => {
  const expiry = 1_795_593_000;
  const lag = 60;
  assert.equal(windowSettled([{ time: expiry + 10 }], expiry, lag, expiry + 60), false);
  assert.equal(windowSettled([{ time: expiry + 10 }, { time: expiry + 60 }], expiry, lag, expiry + 60), false);
  assert.equal(windowSettled([{ time: expiry + 10 }, { time: expiry + 61 }], expiry, lag, expiry + 60), true);
  assert.equal(windowSettled([{ time: expiry + 10 }], expiry, lag, expiry + 60 + FIXING_GRACE_S), true);

  const mkFix = (exp: number, price: string) => ({
    expiry: exp,
    price,
    time: exp + 2,
    raw: "1",
    nonce: "1",
    intentExpiry: exp + 3600,
    sig: DIA_SIG,
    oracleSig: DIA_SIG,
  });
  const pruned = pruneFixings([
    mkFix(expiry - FIXING_HISTORY_S - 1, "1"),
    mkFix(expiry - FIXING_HISTORY_S, "2"),
  ], expiry);
  assert.deepEqual(pruned.map((row) => row.price), ["2"]);

  const oracleKey = secret(11);
  const oraclePkHex = bytesToHex(schnorr.getPublicKey(oracleKey));
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
  assert.equal(parseOracleFixing({ ...inWindow, expiry: 1_795_592_700 }, oraclePkHex), null);
});
