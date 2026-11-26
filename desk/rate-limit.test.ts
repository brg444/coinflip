import assert from "node:assert/strict";
import test from "node:test";

import { openQuoteCapRefusal, RfqLimiter } from "./rate-limit.ts";

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
