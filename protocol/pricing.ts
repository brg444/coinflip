import { MULTIPLIER_MAX, MULTIPLIER_MIN, PREDICT_EDGE, type PredictKind } from "./constants.ts";

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

/** Sats the vault locks for a winner: stake times the multiplier, truncated. */
export function predictPayout(stake: bigint, multiplier: number): bigint {
  return (stake * BigInt(Math.round(multiplier * 100))) / 100n;
}

/** The multiplier a payout represents, for display. */
export function payoutMultiplier(stake: bigint, payout: bigint): number {
  if (stake <= 0n) return 0;
  return Number((payout * 100n) / stake) / 100;
}
