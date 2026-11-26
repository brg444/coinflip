import assert from "node:assert/strict";
import test from "node:test";

import { deribitMultiplier, parseBook, parseInstrument, predictVol, surfaceStatus, type SurfacePoint } from "./deribit.ts";

const now = 1_700_000_000;
const day = now + 24 * 60 * 60;
const week = now + 7 * 24 * 60 * 60;

function point(expiry: number, strike: number, call: boolean, mark: number, iv: number): SurfacePoint {
  return { expiry, strike, call, mark, iv };
}

const book: SurfacePoint[] = [
  point(day, 95_000, true, 0.05, 0.62),
  point(day, 100_000, true, 0.02, 0.50),
  point(day, 100_000, false, 0.02, 0.54),
  point(day, 105_000, true, 0.01, 0.58),
  point(week, 100_000, true, 0.04, 0.44),
  point(week, 100_000, false, 0.04, 0.46),
];

test("a Deribit name is the 08:00 UTC expiry", () => {
  const parsed = parseInstrument("BTC-2OCT26-100000-C", now);
  assert.equal(parsed?.expiry, Math.floor(Date.UTC(2026, 9, 2, 8, 0, 0) / 1000));
  assert.equal(parsed?.strike, 100_000);
  assert.equal(parsed?.call, true);
  assert.equal(parseInstrument("ETH-2OCT26-100000-C", now), null);
});

test("the book keeps the BTC mark and the IV as a decimal", () => {
  const points = parseBook({
    result: [
      { instrument_name: "BTC-2OCT26-100000-C", mark_price: 0.036, mark_iv: 25.36 },
      { instrument_name: "BTC-2OCT26-100000-P", mark_price: 0.01, mark_iv: 0 },
      { instrument_name: "nope", mark_price: 1, mark_iv: 50 },
    ],
  }, now);
  assert.equal(points.length, 2);
  assert.equal(points.find((p) => p.call)?.iv, 0.2536);
  assert.equal(points.find((p) => !p.call)?.mark, 0.01);
});

test("predictVol selects the nearest-expiry ATM call IV at least 6h out and clamps to [0.2, 2]", () => {
  const iv = predictVol(book, 100_000, now);
  assert.ok(iv != null);
  assert.ok(Math.abs(iv - 0.50) < 1e-12);
  // Interpolates linearly between strikes.
  const mid = predictVol(book, 102_500, now);
  assert.ok(mid != null && Math.abs(mid - 0.54) < 1e-12);
  assert.equal(predictVol([], 100_000, now), null);
  assert.equal(predictVol([point(now + 3600, 100_000, true, 0.01, 0.5)], 100_000, now), null);
  assert.equal(predictVol([point(day, 100_000, true, 0.01, 0.05)], 100_000, now), 0.2);
  assert.equal(predictVol([point(day, 100_000, true, 0.01, 5.0)], 100_000, now), 2);
});

test("deribitMultiplier prices ATM at 1.90x and scales cleanly with distance from spot", () => {
  const expiry = now + 300;
  const spotCents = 10_000_000;
  const atm = deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: book });
  assert.equal(atm, 1.9);

  const otmUp = deribitMultiplier({ kind: 2, lineCents: spotCents + 5_000, expiry, now, spotCents, points: book });
  const otmDown = deribitMultiplier({ kind: 3, lineCents: spotCents - 5_000, expiry, now, spotCents, points: book });
  assert.ok(otmUp != null && otmUp > 1.9);
  assert.ok(otmDown != null && otmDown > 1.9);

  const deepOtm = deribitMultiplier({ kind: 2, lineCents: spotCents + 500_000, expiry, now, spotCents, points: book });
  assert.equal(deepOtm, null);
  assert.equal(deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: [] }), null);
  assert.equal(deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: [], vol: 0.5, edge: 0.05 }), 1.9);
});

test("surfaceStatus reports the empty initial cache state", () => {
  assert.deepEqual(surfaceStatus(), { points: 0, at: null, error: null });
});
