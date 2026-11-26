import assert from "node:assert/strict";
import test from "node:test";

import { deribitMultiplier, deribitPremium, parseBook, parseInstrument, predictVol, type SurfacePoint } from "./deribit.ts";
import { payablePremium } from "./pricing.ts";

const now = 1_700_000_000;
const week = now + 7 * 24 * 60 * 60;
const month = now + 30 * 24 * 60 * 60;

function point(expiry: number, strike: number, call: boolean, mark: number, iv: number): SurfacePoint {
  return { expiry, strike, call, mark, iv };
}

const book: SurfacePoint[] = [
  point(week, 100_000, true, 0.02, 0.5),
  point(week, 110_000, true, 0.01, 0.55),
  point(month, 100_000, true, 0.04, 0.48),
  point(month, 110_000, true, 0.025, 0.52),
  point(week, 50_000, false, 0.001, 0.6),
  point(week, 100_000, false, 0.03, 0.5),
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
  assert.equal(points.find((point) => point.call)?.iv, 0.2536);
  assert.equal(points.find((point) => !point.call)?.mark, 0.01);
});

test("a listed strike is the Deribit mark, and a strike between two is the chord", () => {
  const listed = deribitPremium({
    kind: 0,
    strikeUsd: 100_000,
    expiry: week,
    now,
    collateralSats: 100_000_000n,
    spotUsd: 100_000,
    points: book,
  });
  assert.equal(listed?.sats, 2_000_000n);
  assert.equal(listed?.iv, 0.5);
  const mid = deribitPremium({
    kind: 0,
    strikeUsd: 105_000,
    expiry: week,
    now,
    collateralSats: 100_000_000n,
    spotUsd: 100_000,
    points: book,
  });
  assert.equal(mid?.markBtc, 0.015);
  assert.equal(mid?.sats, 1_500_000n);
});

test("an expiry between two listings blends the marks", () => {
  const expiry = week + Math.floor((month - week) / 2);
  const priced = deribitPremium({
    kind: 0,
    strikeUsd: 100_000,
    expiry,
    now,
    collateralSats: 10_000_000n,
    spotUsd: 100_000,
    points: book,
  });
  assert.ok(priced);
  assert.ok(Math.abs(priced.markBtc - 0.03) < 1e-12);
  assert.equal(priced.sats, 300_000n);
});

test("a limited put is the Deribit put spread", () => {
  const priced = deribitPremium({
    kind: 1,
    strikeUsd: 100_000,
    expiry: week,
    now,
    collateralSats: 100_000_000n,
    spotUsd: 80_000,
    points: book,
  });
  assert.ok(priced);
  assert.ok(Math.abs(priced.markBtc - 0.029) < 1e-12);
  assert.equal(priced.sats, 2_900_000n);
  assert.ok(Math.abs(priced.usd - 0.029 * 80_000) < 1e-6);
});

test("a 10-minute 40% call on 0.002 BTC quotes 331 when the mark is dust", () => {
  const expiry = now + 600;
  const spotUsd = 82_633.43;
  const points = [
    point(now + 86_400, 90_000, true, 0, 0.5),
    point(now + 86_400, 80_000, true, 0.01, 0.4),
  ];
  const far = deribitPremium({
    kind: 0,
    strikeUsd: 115_500,
    expiry,
    now,
    collateralSats: 200_000n,
    spotUsd,
    points,
  });
  assert.equal(far?.sats, 0n);
  assert.equal(payablePremium(far?.sats ?? 0n), 331n);
  const closer = deribitPremium({
    kind: 0,
    strikeUsd: spotUsd,
    expiry,
    now,
    collateralSats: 200_000n,
    spotUsd,
    points,
  });
  const larger = deribitPremium({
    kind: 0,
    strikeUsd: spotUsd,
    expiry,
    now,
    collateralSats: 10_000_000n,
    spotUsd,
    points,
  });
  assert.ok(closer && larger);
  assert.ok(closer.sats > 330n);
  assert.equal(payablePremium(closer.sats), closer.sats);
  assert.equal(payablePremium(larger.sats), larger.sats);
});

test("a strike past the listed wing is cheaper than the wing", () => {
  const wing = deribitPremium({
    kind: 0,
    strikeUsd: 110_000,
    expiry: week,
    now,
    collateralSats: 100_000_000n,
    spotUsd: 100_000,
    points: book,
  });
  const far = deribitPremium({
    kind: 0,
    strikeUsd: 130_000,
    expiry: week,
    now,
    collateralSats: 100_000_000n,
    spotUsd: 100_000,
    points: book,
  });
  assert.ok(wing && far);
  assert.ok(far.markBtc < wing.markBtc);
  assert.ok(far.markBtc > 0);
});

test("predictVol picks the nearest call expiry at least 6 hours out, interpolates ATM IV, and clamps to [0.2, 2]", () => {
  const shortExp = now + 5 * 3600 + 59 * 60;
  const sixHours = now + 6 * 3600;
  const surface: SurfacePoint[] = [
    point(shortExp, 100_000, true, 0.01, 1.5), // ignored (< 6h)
    point(sixHours, 100_000, false, 0.02, 0.9), // ignored (put)
    point(sixHours, 95_000, true, 0.05, 0.4),
    point(sixHours, 105_000, true, 0.01, 0.6),
    point(week, 100_000, true, 0.02, 0.8),
  ];
  assert.equal(predictVol(surface, 100_000, now), 0.5);
  assert.equal(predictVol([], 100_000, now), null);
  assert.equal(predictVol(surface, 0, now), null);
  assert.equal(predictVol([point(shortExp, 100_000, true, 0.01, 0.5)], 100_000, now), null);

  // Clamping bounds [0.2, 2.0]
  assert.equal(predictVol([point(sixHours, 100_000, true, 0.01, 0.05)], 100_000, now), 0.2);
  assert.equal(predictVol([point(sixHours, 100_000, true, 0.1, 3.5)], 100_000, now), 2);
});

test("deribitMultiplier prices ATM at 1.90x, increases for OTM calls/puts, honors vol override, and rejects extreme lines", () => {
  const expiry = now + 300;
  const spotCents = 10_000_000; // $100,000
  const atm = deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: book, edge: 0.05 });
  assert.equal(atm, 1.9);

  const otmUp = deribitMultiplier({ kind: 2, lineCents: spotCents + 10_000, expiry, now, spotCents, points: book, edge: 0.05 });
  const itmUp = deribitMultiplier({ kind: 2, lineCents: spotCents - 10_000, expiry, now, spotCents, points: book, edge: 0.05 });
  const otmDown = deribitMultiplier({ kind: 3, lineCents: spotCents - 10_000, expiry, now, spotCents, points: book, edge: 0.05 });
  assert.ok(otmUp != null && itmUp != null && otmDown != null);
  assert.ok(otmUp > atm);
  assert.ok(itmUp < atm);
  assert.ok(otmDown > atm);

  // Extreme OTM exceeds MULTIPLIER_MAX and returns null; empty surface returns null unless vol override is provided.
  assert.equal(deribitMultiplier({ kind: 2, lineCents: spotCents + 500_000, expiry, now, spotCents, points: book }), null);
  assert.equal(deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: [] }), null);
  assert.equal(deribitMultiplier({ kind: 2, lineCents: spotCents, expiry, now, spotCents, points: [], vol: 0.5, edge: 0.05 }), 1.9);
});
