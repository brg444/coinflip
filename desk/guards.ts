import type { PredictKind } from "../protocol/constants.ts";
import { VAULT_EXPIRY_LAG } from "../protocol/messages.ts";
import { probAbove } from "../protocol/pricing.ts";

const YEAR = 365 * 24 * 60 * 60;

export const COIN_EXPIRY_MARGIN_S = 300;
export const BEACON_RATCHET_MARGIN_S = 0;
export const ORACLE_SPOT_MAX_AGE_S = 180;
export const BASIS_MAX_BPS = 100;

export function minCoinExpiry(expiry: number, margin = COIN_EXPIRY_MARGIN_S): number {
  return expiry + Number(VAULT_EXPIRY_LAG) + margin;
}

export function minFillCoinExpiry(
  expiry: number,
  beaconExpiry: number | null,
  margin = COIN_EXPIRY_MARGIN_S,
  ratchetMargin = BEACON_RATCHET_MARGIN_S,
): number {
  const floor = minCoinExpiry(expiry, margin);
  if (beaconExpiry == null || beaconExpiry <= 0) return floor;
  return Math.max(floor, beaconExpiry - ratchetMargin);
}

export function coinOutlives(coin: { expiresAt?: Date }, minExpiryS: number): boolean {
  if (coin.expiresAt == null) return true;
  const ms = coin.expiresAt.getTime();
  return Number.isFinite(ms) && Math.floor(ms / 1000) >= minExpiryS;
}

export function beaconExpiryRefusal(expiry: number, beaconExpiry: number | null, margin = COIN_EXPIRY_MARGIN_S): string {
  if (beaconExpiry == null || beaconExpiry <= 0) return "beacon expiry";
  return minCoinExpiry(expiry, margin) > beaconExpiry ? "beacon expiry" : "";
}

export function predictSpot(opts: {
  oracle: { cents: bigint; time: number } | null;
  exchangeCents: bigint;
  now: number;
  maxAgeS?: number;
  maxBasisBps?: number;
}): { ok: true; cents: bigint } | { ok: false; reason: string } {
  const maxAge = opts.maxAgeS ?? ORACLE_SPOT_MAX_AGE_S;
  const maxBasisBps = opts.maxBasisBps ?? BASIS_MAX_BPS;
  if (!opts.oracle || opts.oracle.cents <= 0n) return { ok: false, reason: "oracle stale" };
  if (opts.now - opts.oracle.time > maxAge || opts.oracle.time > opts.now + 60) {
    return { ok: false, reason: "oracle stale" };
  }
  if (opts.exchangeCents <= 0n) return { ok: false, reason: "spot unavailable" };
  const diff = opts.oracle.cents >= opts.exchangeCents
    ? opts.oracle.cents - opts.exchangeCents
    : opts.exchangeCents - opts.oracle.cents;
  if (diff * 10_000n > opts.exchangeCents * BigInt(maxBasisBps)) {
    return { ok: false, reason: "price basis" };
  }
  return { ok: true, cents: opts.oracle.cents };
}

// Refuse fills whose expected desk payout exceeds the bettor's stake after a favorable move during the 60s lock.
export function predictFillAllowed(opts: {
  kind: PredictKind;
  spotCents: number;
  lineCents: number;
  expiry: number;
  now: number;
  vol: number;
  stake: bigint;
  payout: bigint;
}): boolean {
  if (opts.stake <= 0n || opts.payout <= 0n || opts.expiry <= opts.now) return false;
  const years = Math.max(opts.expiry - opts.now, 1) / YEAR;
  const up = probAbove(opts.spotCents, opts.lineCents, years, opts.vol);
  const pWin = opts.kind === 2 ? up : 1 - up;
  return Number.isFinite(pWin) && pWin * Number(opts.payout) <= Number(opts.stake);
}
