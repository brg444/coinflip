import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Book, finishedQuote, hasOracle, openPremium, outlay, pageQuotes, type QuoteRow } from "./book.ts";

function row(patch: Partial<QuoteRow> = {}): QuoteRow {
  return {
    rfqId: "aa".repeat(32),
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

test("openPremium sums the full payout outlay of open unexpired quotes", () => {
  assert.equal(outlay(row({ collateral: "95000", premium: "50000" })), 95_000n);
  assert.equal(openPremium([
    row({ collateral: "95000" }),
    row({ rfqId: "bb".repeat(32), collateral: "80000", status: "filled" }),
    row({ rfqId: "cc".repeat(32), collateral: "70000", deadline: 100 }),
  ], 1_200), 95_000n);
});

test("pageQuotes returns the newest page and skips finished history", () => {
  const rows = [
    row({ rfqId: "aa".repeat(32), createdAt: 1, status: "expired" }),
    row({ rfqId: "bb".repeat(32), createdAt: 3, premium: "9" }),
    row({ rfqId: "cc".repeat(32), createdAt: 2, premium: "8" }),
  ];
  const page = pageQuotes(rows, { filter: "live", now: 1_200, offset: 0, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.quotes[0]?.rfqId, "bb".repeat(32));
  const next = pageQuotes(rows, { filter: "live", now: 1_200, offset: 1, limit: 1 });
  assert.equal(next.quotes[0]?.rfqId, "cc".repeat(32));
  assert.equal(finishedQuote(rows[0]!, 1_200), true);
});

test("prune drops expired quotes and keeps an open one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coinflip-book-"));
  try {
    const book = await Book.open(dir);
    const caps = { perStrike: 50_000_000n, total: 50_000_000n };
    assert.equal(book.hold(row(), caps, 1_200), true);
    assert.equal(book.hold(row({ rfqId: "bb".repeat(32) }), caps, 1_200), true);
    book.mark("aa".repeat(32), "expired");
    const removed = book.prune(1_200);
    assert.equal(removed.length, 1);
    assert.equal(book.list().length, 1);
    assert.equal(book.get("bb".repeat(32))?.status, "open");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("exposure counts open quotes and unexpired fills, and the cap refuses the next one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coinflip-book-"));
  try {
    const book = await Book.open(dir);
    const caps = { perStrike: 150_000n, total: 200_000n };
    assert.equal(book.hold(row({ collateral: "100000" }), caps, 1_200), true);
    assert.equal(book.hold(row({ rfqId: "bb".repeat(32), collateral: "100000" }), caps, 1_200), false);
    book.mark("aa".repeat(32), "filled", "cc".repeat(32));
    assert.equal(book.exposure(1_200).total, 100_000n);
    assert.equal(book.hold(row({ rfqId: "dd".repeat(32), strike: "9800000", collateral: "100000" }), caps, 1_200), true);
    book.mark("aa".repeat(32), "filled");
    const reopened = await Book.open(dir);
    assert.equal(reopened.list().length, 0);
    await book.save();
    const saved = await Book.open(dir);
    assert.equal(saved.list().length, 2);
    assert.equal(saved.get("aa".repeat(32))?.fillTxid, "cc".repeat(32));
    assert.equal(saved.exposure(1_600).total, 100_000n);
    assert.equal(saved.exposure(3_000).total, 0n);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a quote needs a 64-hex oracle pubkey", () => {
  assert.equal(hasOracle(row()), true);
  assert.equal(hasOracle(row({ oraclePubkey: "" })), false);
  assert.equal(hasOracle(row({ oraclePubkey: undefined as unknown as string })), false);
});

test("parallel saves all land in book.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coinflip-book-"));
  try {
    const book = await Book.open(dir);
    const caps = { perStrike: 10_000_000_000n, total: 10_000_000_000n };
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) {
      assert.equal(book.hold(row({ rfqId: i.toString(16).padStart(64, "0"), collateral: "1" }), caps, 1_200), true);
      saves.push(book.save());
    }
    await Promise.all(saves);
    const saved = await Book.open(dir);
    assert.equal(saved.list().length, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one rfqId stays one row: live duplicates refuse, dead ones are replaced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coinflip-book-"));
  try {
    const book = await Book.open(dir);
    const caps = { perStrike: 100_000_000n, total: 100_000_000n };
    assert.equal(book.hold(row(), caps, 1_200), true);
    assert.equal(book.hold(row({ premium: "60000" }), caps, 1_200), false);
    assert.equal(book.list().length, 1);
    book.mark("aa".repeat(32), "expired");
    assert.equal(book.hold(row({ premium: "60000", deadline: 2_000 }), caps, 1_200), true);
    assert.equal(book.list().length, 1);
    assert.equal(book.get("aa".repeat(32))?.premium, "60000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
