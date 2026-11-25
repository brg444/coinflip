import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAndRenewBeacon,
  DEFAULT_MAINNET_RENEW_BEFORE_S,
  DEPRECATED_SIGNER_ALERT_S,
  MAINNET_FREE_RENEWAL_MAX_REMAINING_S,
} from "./beacon-renewal.mjs";

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("checkAndRenewBeacon returns noop outside renewal window and outside mainnet free-renewal window", async () => {
  const now = 1_800_000_000;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/api/status")) {
      return mockResponse(200, { beaconExpiry: now + DEFAULT_MAINNET_RENEW_BEFORE_S + 3_600, deprecatedSigners: [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const noop = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    nowSec: () => now,
    fetchFn,
    log: () => {},
    logError: () => {},
  });
  assert.equal(noop.action, "noop");
  assert.equal(calls.length, 1);

  const tooEarlyMainnet = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    renewBeforeS: MAINNET_FREE_RENEWAL_MAX_REMAINING_S + 86_400,
    nowSec: () => now,
    fetchFn: async () => mockResponse(200, { beaconExpiry: now + MAINNET_FREE_RENEWAL_MAX_REMAINING_S + 100 }),
    log: () => {},
    logError: () => {},
  });
  assert.equal(tooEarlyMainnet.action, "noop");
});

test("checkAndRenewBeacon pauses desk, waits for quotes and live vaults, renews, and resumes quoting", async () => {
  let now = 1_800_000_000;
  const oldExpiry = now + 4 * 86_400;
  const newExpiry = now + 30 * 86_400;
  let deskChecks = 0;
  let renewAttempts = 0;
  let renewed = false;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", auth: init?.headers?.authorization ?? "" });
    if (url.endsWith("/api/status")) {
      return mockResponse(200, { beaconExpiry: renewed ? newExpiry : oldExpiry, deprecatedSigners: [] });
    }
    if (url.endsWith("/status")) {
      deskChecks += 1;
      if (deskChecks === 1) return mockResponse(200, { draining: false, quoteCounts: { live: 1 } });
      if (deskChecks === 2) return mockResponse(200, { draining: true, quoteCounts: { live: 1 } });
      return mockResponse(200, { draining: true, quoteCounts: { live: 0 } });
    }
    if (url.includes("/drain?enabled=")) {
      return mockResponse(200, { ok: true });
    }
    if (url.endsWith("/api/renew")) {
      renewAttempts += 1;
      if (renewAttempts === 1) return mockResponse(409, { error: "live vault open" });
      if (renewAttempts === 2) return mockResponse(409, { error: "publish in progress" });
      renewed = true;
      return mockResponse(200, { commitmentTxid: "aa".repeat(32), reseedTxid: "bb".repeat(32) });
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    oracleAdminToken: "oracle-secret",
    deskAdminToken: "desk-secret",
    network: "bitcoin",
    pollMs: 1_000,
    nowSec: () => now,
    sleep: async (ms) => { now += Math.ceil(ms / 1000); },
    fetchFn,
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.action, "renewed");
  assert.equal(result.oldExpiry, oldExpiry);
  assert.equal(result.newExpiry, newExpiry);
  assert.equal(result.commitmentTxid, "aa".repeat(32));
  assert.equal(result.reseedTxid, "bb".repeat(32));
  const pause = calls.find((c) => c.url.endsWith("/drain?enabled=1"));
  const resume = calls.find((c) => c.url.endsWith("/drain?enabled=0"));
  const renewCall = calls.find((c) => c.url.endsWith("/api/renew"));
  assert.equal(pause?.auth, "Bearer desk-secret");
  assert.equal(resume?.auth, "Bearer desk-secret");
  assert.equal(renewCall?.auth, "Bearer oracle-secret");
});

test("checkAndRenewBeacon preserves pre-existing manual drain", async () => {
  const now = 1_800_000_000;
  const calls = [];
  let renewed = false;
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/api/status")) {
      return mockResponse(200, { beaconExpiry: renewed ? now + 30 * 86_400 : now + 86_400 });
    }
    if (url.endsWith("/status")) {
      return mockResponse(200, { draining: true, quoteCounts: { live: 0 } });
    }
    if (url.endsWith("/api/renew")) {
      renewed = true;
      return mockResponse(200, { commitmentTxid: "cc".repeat(32), reseedTxid: "dd".repeat(32) });
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    nowSec: () => now,
    fetchFn,
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.action, "renewed");
  assert.equal(calls.some((c) => c.url.includes("/drain")), false);
});

test("checkAndRenewBeacon emits alerts, posts webhook, and still resumes desk quoting on failure or timeout", async () => {
  let now = 1_800_000_000;
  const errors = [];
  const webhooks = [];
  const drainCalls = [];
  const fetchFn = async (url, init) => {
    if (url === "https://alerts.example/hook") {
      webhooks.push(JSON.parse(init.body));
      return mockResponse(200, { ok: true });
    }
    if (url.endsWith("/api/status")) {
      return mockResponse(200, { beaconExpiry: now + 3600, deprecatedSigners: [] });
    }
    if (url.endsWith("/status")) {
      return mockResponse(200, { draining: false, quoteCounts: { live: 0 } });
    }
    if (url.includes("/drain?enabled=")) {
      drainCalls.push(url);
      return mockResponse(200, { ok: true });
    }
    if (url.endsWith("/api/renew")) {
      return mockResponse(500, { error: "batch closed" });
    }
    throw new Error(`unexpected ${url}`);
  };
  const failed = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    alertWebhookUrl: "https://alerts.example/hook",
    nowSec: () => now,
    fetchFn,
    log: () => {},
    logError: (...args) => errors.push(args.join(" ")),
  });
  assert.equal(failed.action, "failed");
  assert.match(failed.reason, /batch closed/);
  assert.deepEqual(drainCalls, ["http://desk.local/drain?enabled=1", "http://desk.local/drain?enabled=0"]);
  assert.equal(webhooks.length, 1);
  assert.match(webhooks[0].message, /automatic beacon renewal failed/);
  assert.equal(errors.some((line) => line.includes("[ALERT]")), true);

  drainCalls.length = 0;
  webhooks.length = 0;
  const timedOut = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    waitTimeoutMs: 2_000,
    pollMs: 1_000,
    alertWebhookUrl: "https://alerts.example/hook",
    nowSec: () => now,
    sleep: async (ms) => { now += Math.ceil(ms / 1000); },
    fetchFn: async (url, init) => {
      if (url === "https://alerts.example/hook") {
        webhooks.push(JSON.parse(init.body));
        return mockResponse(200, { ok: true });
      }
      if (url.endsWith("/api/status")) return mockResponse(200, { beaconExpiry: now + 3600 });
      if (url.endsWith("/status")) return mockResponse(200, { draining: false, quoteCounts: { live: 0 } });
      if (url.includes("/drain?enabled=")) {
        drainCalls.push(url);
        return mockResponse(200, { ok: true });
      }
      if (url.endsWith("/api/renew")) return mockResponse(409, { error: "live vault open" });
      throw new Error(`unexpected ${url}`);
    },
    log: () => {},
    logError: () => {},
  });
  assert.equal(timedOut.action, "failed");
  assert.match(timedOut.reason, /timed out.*live vault open/);
  assert.deepEqual(drainCalls, ["http://desk.local/drain?enabled=1", "http://desk.local/drain?enabled=0"]);
  assert.equal(webhooks.length, 1);
});

test("checkAndRenewBeacon alerts on upcoming deprecatedSigners cutoff and missing beacon coin", async () => {
  const now = 1_800_000_000;
  const webhooks = [];
  const res = await checkAndRenewBeacon({
    oracleUrl: "http://oracle.local",
    deskUrl: "http://desk.local",
    adminToken: "tok",
    network: "bitcoin",
    alertWebhookUrl: "https://alerts.example/hook",
    nowSec: () => now,
    fetchFn: async (url, init) => {
      if (url === "https://alerts.example/hook") {
        webhooks.push(JSON.parse(init.body));
        return mockResponse(200, { ok: true });
      }
      return mockResponse(200, {
        beaconExpiry: 0,
        deprecatedSigners: [{ pubkey: "11".repeat(32), cutoffDate: String(now + DEPRECATED_SIGNER_ALERT_S - 3600) }],
      });
    },
    log: () => {},
    logError: () => {},
  });
  assert.equal(res.action, "alert");
  assert.equal(webhooks.length, 2);
  assert.match(webhooks[0].message, /deprecated signer cutoff/);
  assert.match(webhooks[1].message, /beacon coin missing/);
});
