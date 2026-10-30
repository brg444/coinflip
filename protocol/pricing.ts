import { BEACON_READ_FEE, DUST_SATS, MULTIPLIER_MAX, MULTIPLIER_MIN, PREDICT_EDGE, type PredictKind } from "./constants.ts";

/** Black-Scholes, r = 0. A covered call is a vanilla call. A limited put is the put spread K against K/2. */

function erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return sign * y;
}

function normCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function bsCall(spot: number, strike: number, years: number, vol: number) {
  if (years <= 0 || vol <= 0 || spot <= 0 || strike <= 0) return Math.max(0, spot - strike);
  const s = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (0.5 * vol * vol * years)) / s;
  const d2 = d1 - s;
  return spot * normCdf(d1) - strike * normCdf(d2);
}

export function bsPut(spot: number, strike: number, years: number, vol: number) {
  return bsCall(spot, strike, years, vol) - spot + strike;
}

export function premiumSats(input: {
  kind: 0 | 1;
  spotCents: number;
  strikeCents: number;
  years: number;
  collateralSats: bigint;
  vol: number;
}): { sats: bigint; usd: number } {
  const spot = input.spotCents / 100;
  const strike = input.strikeCents / 100;
  const notional = Number(input.collateralSats) / 1e8;
  const usd = input.kind === 0
    ? bsCall(spot, strike, input.years, input.vol) * notional
    : Math.max(0, bsPut(spot, strike, input.years, input.vol) - bsPut(spot, strike / 2, input.years, input.vol)) * notional;
  const sats = BigInt(Math.max(0, Math.round((usd / spot) * 1e8)));
  return { sats, usd };
}

/**
 * Sats a quote will pay. The formula result is kept when it can be an output.
 * Chain dust stays 330. A result at or below that is quoted at 331, and that
 * is the amount the desk pays.
 */
export function payablePremium(sats: bigint): bigint {
  if (sats <= DUST_SATS) return DUST_SATS + 1n;
  return sats;
}

/** A quote this close is the 10-minute test tenor. A listed Friday is more than an hour out. */
const TEST_QUOTE_S = 15 * 60;

/**
 * Premium the page and the desk both quote. A 10-minute quote at or below the
 * 1,000-sat read fee is lifted to 1,001, which is still less than a 0.002 BTC
 * lock. Friday quotes are unchanged.
 */
export function quotedPremium(sats: bigint, expiry: number, now: number): bigint {
  const pay = payablePremium(sats);
  const life = expiry - now;
  if (life > 0 && life <= TEST_QUOTE_S && pay <= BEACON_READ_FEE) return BEACON_READ_FEE + 1n;
  return pay;
}

/** Chance BTC closes above the line. Lognormal, r = 0: N(d2). */
export function probAbove(spot: number, line: number, years: number, vol: number): number {
  if (!(spot > 0) || !(line > 0)) return 0;
  if (years <= 0 || vol <= 0) return spot > line ? 1 : 0;
  const s = vol * Math.sqrt(years);
  const d2 = (Math.log(spot / line) - 0.5 * vol * vol * years) / s;
  return normCdf(d2);
}

/**
 * What a winning stake is multiplied by: the fair odds less the desk's edge,
 * rounded down to 0.01. Null outside the quoted range, so a near-certain call
 * and a long shot are both refused rather than mispriced.
 */
export function predictMultiplier(input: {
  kind: PredictKind;
  spotCents: number;
  lineCents: number;
  years: number;
  vol: number;
  edge?: number;
}): number | null {
  const up = probAbove(input.spotCents, input.lineCents, input.years, input.vol);
  const p = input.kind === 2 ? up : 1 - up;
  if (!(p > 0)) return null;
  const edge = input.edge ?? PREDICT_EDGE;
  const multiplier = Math.floor(((1 - edge) / p) * 100) / 100;
  if (!Number.isFinite(multiplier) || multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) return null;
  return multiplier;
}

/** Sats the vault pays a winner before the read fee: stake times the multiplier, truncated. */
export function predictPayout(stake: bigint, multiplier: number): bigint {
  return (stake * BigInt(Math.round(multiplier * 100))) / 100n;
}

/** The multiplier a payout represents, for display. */
export function payoutMultiplier(stake: bigint, payout: bigint): number {
  if (stake <= 0n) return 0;
  return Number((payout * 100n) / stake) / 100;
}
