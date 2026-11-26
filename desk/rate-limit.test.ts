import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Book, openPremium, type QuoteRow } from "./book.ts";
import { AsyncMutex, openQuoteCapRefusal, reserveQuote, RfqLimiter } from "./rate-limit.ts";

function makeRow(id: number, patch: Partial<QuoteRow> = {}): QuoteRow {
  return {
    rfqId: id.toString(16).padStart(64, "0"),
    collateral: "95000",
    premium: "50000",
    kind: 2,
    strike: "9700000",
    expiry: 2_000,
    deadline: 1_500,
    validUntil: 1_030,
    exit: 2048,
    writerPubkey: "11".repeat(32),
    writerPkScript: "5120" + "22".repeat(32),
    holderPubkey: "33".repeat(32),
    holderPkScript: "5120" + "44".repeat(32),
    oraclePubkey: "55".repeat(32),
    backupPubkey: "66".repeat(32),
    voidAfter: 86_400,
    fallbackDelay: 22_016,
    finalExitDelay: 108_032,
    intentAddress: "tark1intent",
    vaultAddress: "tark1vault",
    status: "open",
    createdAt: 1_000,
    clientPubkey: "99".repeat(32),
    ...patch,
  };
}

test("RfqLimiter enforces per-client and global sliding windows and bounds tracked keys", () => {
  const limiter = new RfqLimiter({ windowMs: 1_000, maxPerClient: 2, maxGlobal: 3, maxTrackedKeys: 2 });
  assert.equal(limiter.allow("alice", 100), true);
  assert.equal(limiter.allow("alice", 200), true);
  assert.equal(limiter.allow("alice", 300), false); // per-client limit

  assert.equal(limiter.allow("bob", 350), true);
  assert.equal(limiter.allow("carol", 400), false); // global limit (3)

  // After window slides past 1100, alice's first slot frees up.
  assert.equal(limiter.allow("carol", 1_150), true);
  // Window slides past all old timestamps.
  assert.equal(limiter.allow("alice", 2_500), true);
});

test("openQuoteCapRefusal caps live unpaid quotes per client and globally while ignoring expired/filled rows", () => {
  const now = 1_700_000_000;
  const rows = [
    { status: "open" as const, deadline: now + 30, clientPubkey: "alice" },
    { status: "open" as const, deadline: now + 30, clientPubkey: "alice" },
    { status: "open" as const, deadline: now - 1, clientPubkey: "alice" }, // expired
    { status: "filled" as const, deadline: now + 30, clientPubkey: "alice" }, // filled
    { status: "open" as const, deadline: now + 30, clientPubkey: "bob" },
  ];
  assert.equal(openQuoteCapRefusal(rows, "alice", now, { perClient: 3, global: 4 }), "");
  assert.equal(openQuoteCapRefusal(rows, "alice", now, { perClient: 2, global: 4 }), "too many open quotes");
  assert.equal(openQuoteCapRefusal(rows, "carol", now, { perClient: 3, global: 3 }), "desk busy");
  assert.equal(openQuoteCapRefusal(rows, "carol", now, { perClient: 3, global: 4 }), "");
});

test("reserveQuote serializes concurrent bursts across async float refreshes so float and caps cannot over-commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coinflip-mutex-"));
  try {
    const book = await Book.open(dir);
    const mutex = new AsyncMutex();
    const caps = { perStrike: 5_000_000n, total: 5_000_000n };
    let floatBalance = 200_000n; // enough for exactly 2 quotes of 95,000 sats

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reserveQuote({
        mutex,
        book,
        row: makeRow(i + 1, { clientPubkey: `client-${i}`, collateral: "95000" }),
        from: `client-${i}`,
        now: () => 1_200,
        caps,
        draining: () => false,
        eligibleFloat: () => floatBalance,
        refreshFloat: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      })),
    );
    const accepted = results.filter((res) => res.ok);
    const short = results.filter((res) => !res.ok && res.reason === "float short");
    assert.equal(accepted.length, 2);
    assert.equal(short.length, 8);
    assert.equal(openPremium(book.list(), 1_200), 190_000n);
    assert.ok(openPremium(book.list(), 1_200) <= floatBalance);

    // Concurrent burst from one client with plenty of float still obeys per-client cap.
    floatBalance = 10_000_000n;
    const sameClient = await Promise.all(
      Array.from({ length: 6 }, (_, i) => reserveQuote({
        mutex,
        book,
        row: makeRow(100 + i, { clientPubkey: "alice", collateral: "95000" }),
        from: "alice",
        now: () => 1_200,
        caps,
        draining: () => false,
        eligibleFloat: () => floatBalance,
        refreshFloat: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        limits: { perClient: 3, global: 50 },
      })),
    );
    assert.equal(sameClient.filter((res) => res.ok).length, 3);
    assert.equal(sameClient.filter((res) => !res.ok && res.reason === "too many open quotes").length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
