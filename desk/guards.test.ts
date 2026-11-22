import assert from "node:assert/strict";
import test from "node:test";

import {
  BASIS_MAX_BPS,
  beaconExpiryRefusal,
  COIN_EXPIRY_MARGIN_S,
  coinOutlives,
  minCoinExpiry,
  ORACLE_SPOT_MAX_AGE_S,
  predictFillAllowed,
  predictSpot,
} from "./guards.ts";
import { predictMultiplier, predictPayout } from "../protocol/pricing.ts";

test("coin expiry guards require coins and beacon to outlive settlement plus margin", () => {
  const expiry = 1_700_000_000;
  const need = minCoinExpiry(expiry);
  assert.equal(need, expiry + 60 + COIN_EXPIRY_MARGIN_S);

  assert.equal(coinOutlives({}, need), true);
  assert.equal(coinOutlives({ expiresAt: new Date(need * 1000) }, need), true);
  assert.equal(coinOutlives({ expiresAt: new Date((need - 1) * 1000) }, need), false);

  assert.equal(beaconExpiryRefusal(expiry, null), "");
  assert.equal(beaconExpiryRefusal(expiry, need), "");
  assert.equal(beaconExpiryRefusal(expiry, need - 1), "beacon expiry");
});

test("predictSpot uses fresh oracle DIA price within the exchange basis band", () => {
  const now = 1_700_000_500;
  const ok = predictSpot({
    oracle: { cents: 9_005_000n, time: now - 30 },
    exchangeCents: 9_000_000n,
    now,
  });
  assert.deepEqual(ok, { ok: true, cents: 9_005_000n });

  assert.deepEqual(
    predictSpot({ oracle: null, exchangeCents: 9_000_000n, now }),
    { ok: false, reason: "oracle stale" },
  );
  assert.deepEqual(
    predictSpot({ oracle: { cents: 9_000_000n, time: now - ORACLE_SPOT_MAX_AGE_S - 1 }, exchangeCents: 9_000_000n, now }),
    { ok: false, reason: "oracle stale" },
  );
  assert.deepEqual(
    predictSpot({ oracle: { cents: 9_000_000n, time: now + 61 }, exchangeCents: 9_000_000n, now }),
    { ok: false, reason: "oracle stale" },
  );
  const wide = 9_000_000n + (9_000_000n * BigInt(BASIS_MAX_BPS + 5)) / 10_000n;
  assert.deepEqual(
    predictSpot({ oracle: { cents: wide, time: now - 10 }, exchangeCents: 9_000_000n, now }),
    { ok: false, reason: "price basis" },
  );
});

test("predictFillAllowed rejects negative-EV adverse moves during the lock and permits favorable or flat moves", () => {
  const now = 1_700_000_000;
  const expiry = now + 300;
  const line = 9_000_000;
  const vol = 0.6;
  const stake = 50_000n;
  const mult = predictMultiplier({
    kind: 2,
    spotCents: line,
    lineCents: line,
    years: 300 / (365 * 24 * 60 * 60),
    vol,
    edge: 0.05,
  });
  assert.ok(mult != null);
  const payout = predictPayout(stake, mult);

  assert.equal(predictFillAllowed({ kind: 2, spotCents: line, lineCents: line, expiry, now: now + 20, vol, stake, payout }), true);
  assert.equal(predictFillAllowed({ kind: 2, spotCents: line - 5_000, lineCents: line, expiry, now: now + 30, vol, stake, payout }), true);
  assert.equal(predictFillAllowed({ kind: 2, spotCents: line - 500_000, lineCents: line, expiry, now: now + 30, vol, stake, payout }), true);
  assert.equal(predictFillAllowed({ kind: 2, spotCents: line + 5_000, lineCents: line, expiry, now: now + 30, vol, stake, payout }), false);
  assert.equal(predictFillAllowed({ kind: 3, spotCents: line - 5_000, lineCents: line, expiry, now: now + 30, vol, stake, payout }), false);
  assert.equal(predictFillAllowed({ kind: 2, spotCents: line, lineCents: line, expiry, now: expiry, vol, stake, payout }), false);
});
