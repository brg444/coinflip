import type { PredictKind } from "./constants.ts";
import { predictMultiplier } from "./pricing.ts";

/**
 * Deribit BTC option implied-volatility surface for short-window prediction pricing.
 */

const BOOK_URL = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option";
const INDEX_URL = "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd";
const YEAR = 365 * 24 * 60 * 60;
const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export type SurfacePoint = {
  expiry: number;
  strike: number;
  call: boolean;
  mark: number;
  iv: number;
};

const NAME = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/;

export function parseInstrument(name: string, now = Math.floor(Date.now() / 1000)): SurfacePoint | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const month = MONTHS[match[2] ?? ""];
  if (month == null) return null;
  const day = Number(match[1]);
  const year = 2000 + Number(match[3]);
  const expiry = Math.floor(Date.UTC(year, month, day, 8, 0, 0) / 1000);
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  const strike = Number(match[4]);
  if (!(strike > 0)) return null;
  return { expiry, strike, call: match[5] === "C", mark: 0, iv: 0 };
}

export function parseBook(body: unknown, now = Math.floor(Date.now() / 1000)): SurfacePoint[] {
  const rows = Array.isArray(body) ? body : (body as { result?: unknown })?.result;
  if (!Array.isArray(rows)) return [];
  const byKey = new Map<string, SurfacePoint>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { instrument_name?: unknown; mark_price?: unknown; mark_iv?: unknown };
    if (typeof record.instrument_name !== "string") continue;
    const point = parseInstrument(record.instrument_name, now);
    if (!point) continue;
    const mark = Number(record.mark_price);
    const iv = Number(record.mark_iv);
    if (!Number.isFinite(mark) || mark < 0) continue;
    point.mark = mark;
    point.iv = Number.isFinite(iv) && iv > 0 ? iv / 100 : 0;
    byKey.set(`${point.expiry}:${point.strike}:${point.call ? "C" : "P"}`, point);
  }
  return [...byKey.values()];
}

function ivAtExpiry(points: SurfacePoint[], expiry: number, strike: number): number | null {
  const slice = points.filter((point) => point.expiry === expiry).sort((a, b) => a.strike - b.strike);
  if (slice.length === 0) return null;
  const exact = slice.find((point) => Math.abs(point.strike - strike) < 0.5);
  if (exact) return exact.iv;
  const higher = slice.findIndex((point) => point.strike > strike);
  if (higher === 0) return slice[0]!.iv;
  if (higher === -1) return slice[slice.length - 1]!.iv;
  const lo = slice[higher - 1]!;
  const hi = slice[higher]!;
  const weight = (strike - lo.strike) / (hi.strike - lo.strike);
  return lo.iv * (1 - weight) + hi.iv * weight;
}

/**
 * Annualized vol for a window of minutes: the at-the-money call IV of the
 * nearest listed expiry at least six hours out. A daily that is about to
 * expire has an IV that says little about the next five minutes.
 */
export function predictVol(points: SurfacePoint[], spotUsd: number, now: number): number | null {
  const calls = points.filter((point) => point.call && point.expiry >= now + 6 * 3600);
  if (!calls.length || !(spotUsd > 0)) return null;
  const nearest = Math.min(...calls.map((point) => point.expiry));
  const iv = ivAtExpiry(calls, nearest, spotUsd);
  if (iv == null || !(iv > 0)) return null;
  return Math.min(2, Math.max(0.2, iv));
}

/** The multiplier the page estimates and the desk quotes, from the Deribit surface. */
export function deribitMultiplier(input: {
  kind: PredictKind;
  lineCents: number;
  expiry: number;
  now: number;
  spotCents: number;
  points: SurfacePoint[];
  vol?: number | null;
  edge?: number;
}): number | null {
  const vol = input.vol ?? predictVol(input.points, input.spotCents / 100, input.now);
  if (vol == null) return null;
  return predictMultiplier({
    kind: input.kind,
    spotCents: input.spotCents,
    lineCents: input.lineCents,
    years: Math.max(input.expiry - input.now, 1) / YEAR,
    vol,
    edge: input.edge,
  });
}

let cache: { at: number; points: SurfacePoint[] } | null = null;
let inflight: Promise<SurfacePoint[]> | null = null;
let lastError: string | null = null;

async function readBook(): Promise<SurfacePoint[]> {
  const res = await fetch(BOOK_URL, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`deribit ${res.status}`);
  const points = parseBook(await res.json());
  if (points.length === 0) throw new Error("deribit book empty");
  return points;
}

function loadOnce(): Promise<SurfacePoint[]> {
  if (!inflight) {
    inflight = readBook().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** The public BTC option book. A book newer than 30s is reused. A failed refresh keeps a book under 5 minutes old. */
export async function fetchSurface(now = Date.now()): Promise<SurfacePoint[]> {
  if (cache && now - cache.at < 30_000) return cache.points;
  try {
    const points = await loadOnce();
    cache = { at: Date.now(), points };
    lastError = null;
    return points;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "deribit unavailable";
    if (cache && now - cache.at < 300_000) return cache.points;
    throw err;
  }
}

export function surfaceStatus(): { points: number; at: number | null; error: string | null } {
  return { points: cache?.points.length ?? 0, at: cache?.at ?? null, error: lastError };
}

/** Deribit BTCUSD index, in cents. Null when the feed does not answer. */
export async function btcUsdCents(signal?: AbortSignal): Promise<bigint | null> {
  const res = await fetch(INDEX_URL, { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: { index_price?: unknown } };
  const usd = Number(body.result?.index_price);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return BigInt(Math.round(usd * 100));
}
