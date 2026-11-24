import { PREDICT_GRID_S } from "./constants.ts";

/**
 * A window's line, Polymarket-style: everyone in a five-minute window predicts against the same line,
 * the DIA oracle's first sample at or after the window opens. The page offers it and the desk checks it,
 * both by this rule, so neither side can pick a convenient line. The vault takes it as its strike.
 */

/** How long after the window opens the line may still be set, if the oracle is slow to publish. */
export const WINDOW_LINE_WITHIN_S = 120;

/** The window that closes at `expiry` opened one grid step earlier. */
export function windowOpen(expiry: number, grid: number = PREDICT_GRID_S): number {
  return expiry - grid;
}

/** The first sample at or after `open`, within the allowance. Null until the oracle has one. */
export function openingSample<T extends { time: number }>(
  samples: readonly T[],
  open: number,
  within: number = WINDOW_LINE_WITHIN_S,
): T | null {
  const pool = samples.filter((sample) => sample.time >= open && sample.time <= open + within);
  if (!pool.length) return null;
  return pool.reduce((first, sample) => (sample.time < first.time ? sample : first));
}
