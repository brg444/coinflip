import assert from "node:assert/strict";
import test from "node:test";
import { bsCall, premiumSats } from "../protocol/pricing.ts";
import { holderPayoff, settlementOutputs, writerPayoff } from "./settle-math.js";

test("covered call and limited put payoffs", () => {
  const q = 100_000n;
  assert.equal(holderPayoff(0, 20_000n, 10_000n, q), 50_000n);
  assert.equal(holderPayoff(0, 10_000n, 10_000n, q), 0n);
  assert.equal(holderPayoff(1, 8_000n, 10_000n, q), 25_000n);
  assert.equal(holderPayoff(1, 4_000n, 10_000n, q), q);
  assert.equal(holderPayoff(1, 10_000n, 10_000n, q), 0n);
});

test("writer payoff is the collateral the seller keeps", () => {
  const q = 100_000n;
  assert.equal(writerPayoff(0, 20_000n, 10_000n, q), 50_000n);
  assert.equal(writerPayoff(0, 10_000n, 10_000n, q), q);
  assert.equal(writerPayoff(1, 8_000n, 10_000n, q), 75_000n);
  assert.equal(writerPayoff(1, 4_000n, 10_000n, q), 0n);
  assert.equal(writerPayoff(0, 20_000n, 10_000n, q) + holderPayoff(0, 20_000n, 10_000n, q), q);
});

test("dust folds the small leg into the other output", () => {
  assert.deepEqual(settlementOutputs(50_000n, 100_000n), { mode: "split", holder: 50_000n, writer: 50_000n });
  assert.deepEqual(settlementOutputs(200n, 100_000n), { mode: "writer", holder: 0n, writer: 100_000n });
  assert.deepEqual(settlementOutputs(100_000n, 100_000n), { mode: "holder", holder: 100_000n, writer: 0n });
  assert.deepEqual(settlementOutputs(200n, 400n), { mode: "writer", holder: 0n, writer: 400n });
});

test("black-scholes call is near the known one-year value", () => {
  const px = bsCall(100, 100, 1, 0.2);
  assert.ok(Math.abs(px - 7.9656) < 0.02, px);
});

test("a 7-day covered call at 62% vol is dust only at the far strike", () => {
  const spot = 8_461_728n;
  const grid = 100_000n;
  const steps = [105n, 110n, 115n, 125n, 140n];
  const strikes = steps.map((step) => ((spot * step) / 100n + grid / 2n) / grid * grid);
  const premiums = strikes.map((strike) => premiumSats({
    kind: 0,
    spotCents: Number(spot),
    strikeCents: Number(strike),
    years: 7 / 365,
    collateralSats: 100_000_000n,
    vol: 0.62,
  }).sats);
  assert.ok(premiums.slice(0, 4).every((sats) => sats > 330n));
  assert.ok(premiums[4] <= 330n);
});
