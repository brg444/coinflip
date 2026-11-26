import { schnorr } from "@noble/curves/secp256k1.js";

import { centsOf, intentSigned } from "../protocol/dia.ts";
import { FIX_EXPIRY_LAG, predictFixDigest } from "../protocol/fixing.ts";
import { bytesToHex } from "../protocol/hex.ts";

/**
 * Client helpers for the stateless fixing oracle (`/api/status`, `/api/prices`, `/api/fixing`).
 */

export type OracleLatest = { cents: bigint; time: number };

export type OracleKeyInfo = {
  oraclePk: Uint8Array;
  oraclePkHex: string;
  expiryLag: bigint;
};

export type OracleFixing = {
  expiry: number;
  cents: bigint;
  price: bigint;
  time: number;
  nonce: bigint;
  intentExpiry: number;
  sig: Uint8Array;
  oracleSig: Uint8Array;
  oraclePk: Uint8Array;
  oraclePkHex: string;
};

const HEX = /^[0-9a-fA-F]+$/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hexBytes(value: unknown, size: number): Uint8Array | null {
  if (typeof value !== "string" || value.length !== size * 2 || !HEX.test(value)) return null;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function whole(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

/** Origin only. A pasted `/status` or `/api/status` URL still works. */
export function serviceOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL must be an http(s) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must be an http(s) origin");
  return url.origin;
}

export type OracleSample = { price: string; time: number };

/** Samples from `GET /api/prices`. Rows that are not a price and a time are skipped. */
export async function fetchOraclePrices(origin: string, from: number, to: number, signal?: AbortSignal): Promise<OracleSample[]> {
  const res = await fetch(`${origin}/api/prices?from=${from}&to=${to}&limit=200`, { signal });
  if (!res.ok) throw new Error(`oracle prices ${res.status}`);
  const body = await res.json() as { samples?: unknown };
  if (!body || typeof body !== "object" || !Array.isArray(body.samples)) throw new Error("oracle prices");
  const samples: OracleSample[] = [];
  for (const row of body.samples) {
    if (!row || typeof row !== "object") continue;
    const sample = row as { price?: unknown; time?: unknown };
    if (typeof sample.price !== "string" || !/^[0-9]+$/.test(sample.price)) continue;
    if (typeof sample.time !== "number" || !Number.isSafeInteger(sample.time)) continue;
    samples.push({ price: sample.price, time: sample.time });
  }
  return samples;
}

export async function fetchOracleStatus(origin: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${origin}/api/status`, { signal });
  if (!res.ok) throw new Error(`oracle status ${res.status}`);
  return await res.json();
}

export function parseOracleLatest(body: unknown): OracleLatest | null {
  const root = record(body);
  const latest = record(root?.latest);
  if (!latest) return null;
  const cents = whole(latest.price);
  const time = typeof latest.time === "number" && Number.isSafeInteger(latest.time) && latest.time > 0 ? latest.time : null;
  if (cents == null || cents <= 0n || time == null) return null;
  return { cents, time };
}

/** Extract the oracle's x-only signing pubkey and expiry lag from `/api/status`. */
export function parseOracleKey(body: unknown): OracleKeyInfo | null {
  const root = record(body);
  if (!root) return null;
  const args = record(root.args);
  const adminRaw = typeof args?.adminPk === "string"
    ? args.adminPk
    : Array.isArray(root.pubkeys) && typeof root.pubkeys[0] === "string"
      ? root.pubkeys[0]
      : "";
  const oraclePk = hexBytes(adminRaw, 32);
  if (!oraclePk) return null;
  const expiryLag = whole(args?.expiryLag) ?? FIX_EXPIRY_LAG;
  return { oraclePk, oraclePkHex: bytesToHex(oraclePk), expiryLag };
}

/** Parse and cryptographically verify a signed fixing payload from `GET /api/fixing?expiry=...`. */
export function parseOracleFixing(body: unknown, expectedOraclePkHex?: string): OracleFixing | null {
  const root = record(body);
  if (!root) return null;
  const expiry = typeof root.expiry === "number" && Number.isSafeInteger(root.expiry) && root.expiry > 1800 ? root.expiry : null;
  const time = typeof root.time === "number" && Number.isSafeInteger(root.time) && root.time > 0 ? root.time : null;
  const intentExpiry = typeof root.intentExpiry === "number" && Number.isSafeInteger(root.intentExpiry) ? root.intentExpiry : null;
  const price = whole(root.raw);
  const nonce = whole(root.nonce);
  const sig = hexBytes(root.sig, 64);
  const oracleSig = hexBytes(root.oracleSig, 64);
  const oraclePk = hexBytes(root.oraclePk, 32);
  if (expiry == null || time == null || intentExpiry == null || price == null || price <= 0n || nonce == null || !sig || !oracleSig || !oraclePk) {
    return null;
  }
  const oraclePkHex = bytesToHex(oraclePk);
  if (expectedOraclePkHex && oraclePkHex !== expectedOraclePkHex.trim().toLowerCase()) return null;
  if (time < expiry || time > expiry + Number(FIX_EXPIRY_LAG)) return null;
  let cents: bigint;
  try {
    cents = centsOf(price);
  } catch {
    return null;
  }
  if (!intentSigned({ price, time, nonce, intentExpiry, sig })) return null;
  const digest = predictFixDigest({ expiry: BigInt(expiry), cents, time: BigInt(time) });
  if (!schnorr.verify(oracleSig, digest, oraclePk)) return null;
  return { expiry, cents, price, time, nonce, intentExpiry, sig, oracleSig, oraclePk, oraclePkHex };
}

/** Fetch and verify the canonical signed fixing for `expiry` from `GET /api/fixing` (or `/oracle/fixing`). */
export async function fetchOracleFixing(
  urlOrOrigin: string,
  expiry: number,
  expectedOraclePkHex?: string,
  signal?: AbortSignal,
): Promise<{ status: number; fixing: OracleFixing | null; error?: string }> {
  const endpoint = urlOrOrigin.includes("/fixing")
    ? `${urlOrOrigin}${urlOrOrigin.includes("?") ? "&" : "?"}expiry=${expiry}`
    : `${urlOrOrigin.replace(/\/+$/, "")}/api/fixing?expiry=${expiry}`;
  const res = await fetch(endpoint, { signal });
  const raw = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) return { status: res.status, fixing: null, error: raw?.error ?? `oracle fixing ${res.status}` };
  const fixing = parseOracleFixing(raw, expectedOraclePkHex);
  if (!fixing) return { status: 502, fixing: null, error: "invalid fixing signature" };
  return { status: 200, fixing };
}
