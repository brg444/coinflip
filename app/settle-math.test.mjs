import assert from "node:assert/strict";
import test from "node:test";

import { payoutMultiplier, predictMultiplier, predictPayout, probAbove } from "../protocol/pricing.ts";
import { holderPayoff, settlementOutputs, writerPayoff } from "./settle-math.js";

test("higher and lower binary prediction payoffs, with ties going to the desk", () => {
  const q = 95_000n;
  const line = 8_500_000n;
  assert.equal(holderPayoff(2, line + 1n, line, q), q);
  assert.equal(holderPayoff(2, line, line, q), 0n);
  assert.equal(holderPayoff(2, line - 1n, line, q), 0n);
  assert.equal(holderPayoff(3, line - 1n, line, q), q);
  assert.equal(holderPayoff(3, line, line, q), 0n);
  assert.equal(holderPayoff(3, line + 1n, line, q), 0n);
});

test("writer payoff is the complement of holder payoff", () => {
  const q = 95_000n;
  const line = 8_500_000n;
  assert.equal(writerPayoff(2, line + 1n, line, q), 0n);
  assert.equal(writerPayoff(2, line, line, q), q);
  assert.equal(writerPayoff(3, line - 1n, line, q), 0n);
  assert.equal(writerPayoff(3, line, line, q), q);
  assert.equal(writerPayoff(2, line + 1n, line, q) + holderPayoff(2, line + 1n, line, q), q);
});

test("settlementOutputs has zero read fee and folds dust legs into the other party", () => {
  assert.deepEqual(settlementOutputs(95_000n, 95_000n), { mode: "holder", holder: 95_000n, writer: 0n });
  assert.deepEqual(settlementOutputs(0n, 95_000n), { mode: "writer", holder: 0n, writer: 95_000n });
  assert.deepEqual(settlementOutputs(50_000n, 95_000n), { mode: "split", holder: 50_000n, writer: 45_000n });
  assert.deepEqual(settlementOutputs(200n, 95_000n), { mode: "writer", holder: 0n, writer: 95_000n });
  assert.deepEqual(settlementOutputs(94_800n, 95_000n), { mode: "holder", holder: 95_000n, writer: 0n });
});

test("predict pricing computes 1.90x at even odds and clamps outside bounds", () => {
  const years = 300 / (365 * 24 * 3600);
  assert.ok(Math.abs(probAbove(100, 100, years, 0.5) - 0.5) < 0.001);
  assert.equal(predictMultiplier({ kind: 2, spotCents: 9_000_000, lineCents: 9_000_000, years, vol: 0.5 }), 1.9);
  assert.equal(predictPayout(50_000n, 1.9), 95_000n);
  assert.equal(payoutMultiplier(50_000n, 95_000n), 1.9);
});
