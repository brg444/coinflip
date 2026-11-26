import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonFile } from "../protocol/sqlite-storage.ts";

export type StoredSample = {
  /** USD cents derived from the DIA price. */
  price: string;
  time: number;
  /** 18-decimal DIA price. */
  raw?: string;
  nonce?: string;
  intentExpiry?: number;
  /** 64-byte r||s, hex. */
  sig?: string;
};

/** Samples older than this are dropped. A day of one-minute prints. */
export const SAMPLE_HISTORY_S = 24 * 60 * 60;
/** Fixings older than this are pruned (48h > 24h PredictVault voidAfter). */
export const FIXING_HISTORY_S = 48 * 60 * 60;
/** Fallback wait past `expiry + expiryLag` if DIA hasn't emitted a post-window print yet. */
export const FIXING_GRACE_S = 30;

export function pruneSamples(samples: readonly StoredSample[], now: number): StoredSample[] {
  const cutoff = now - SAMPLE_HISTORY_S;
  return samples.filter((sample) => sample.time >= cutoff);
}

export function pruneFixings(fixings: readonly StoredFixing[], now: number): StoredFixing[] {
  const cutoff = now - FIXING_HISTORY_S;
  return fixings.filter((fixing) => fixing.expiry >= cutoff);
}

export type StoredFixing = {
  expiry: number;
  price: string;
  /** Sample time signed for this expiry. */
  time: number;
  raw: string;
  nonce: string;
  intentExpiry: number;
  sig: string;
  /** 64-byte BIP340 Schnorr signature from `oraclePk` over `predictFixDigest`. */
  oracleSig: string;
};

/**
 * The canonical sample for an expiry: the newest print strictly inside `[expiry, expiry + expiryLag]`.
 * PredictVaultV3 rejects any sample outside this window.
 */
export function chooseSample<T extends { time: number }>(samples: readonly T[], expiry: number, expiryLag: number): T | null {
  const hi = expiry + expiryLag;
  const close = samples.filter((sample) => sample.time >= expiry && sample.time <= hi);
  if (!close.length) return null;
  return close.reduce((best, sample) => (sample.time >= best.time ? sample : best));
}

/**
 * True once the close window `[expiry, expiry + expiryLag]` can safely freeze without racing a late print:
 * either the monotonic DIA feed has already delivered a print strictly past `expiry + expiryLag`,
 * or `graceS` seconds have elapsed past `expiry + expiryLag`.
 */
export function windowSettled(
  samples: readonly { time: number }[],
  expiry: number,
  expiryLag: number,
  now: number,
  graceS = FIXING_GRACE_S,
): boolean {
  const closeEnd = expiry + expiryLag;
  if (now < closeEnd) return false;
  if (now >= closeEnd + graceS) return true;
  return samples.some((sample) => sample.time > closeEnd);
}

export type OracleFile = {
  samples: StoredSample[];
  fixings: StoredFixing[];
};

const empty = (): OracleFile => ({ samples: [], fixings: [] });

function normalizeSample(value: unknown): StoredSample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as StoredSample;
  if (typeof sample.price !== "string" || typeof sample.time !== "number") return null;
  return {
    price: sample.price,
    time: sample.time,
    ...(typeof sample.raw === "string" ? { raw: sample.raw } : {}),
    ...(typeof sample.nonce === "string" ? { nonce: sample.nonce } : {}),
    ...(typeof sample.intentExpiry === "number" ? { intentExpiry: sample.intentExpiry } : {}),
    ...(typeof sample.sig === "string" ? { sig: sample.sig } : {}),
  };
}

function normalizeFixing(value: unknown): StoredFixing | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<StoredFixing>;
  if (
    typeof row.expiry !== "number"
    || typeof row.price !== "string"
    || typeof row.time !== "number"
    || typeof row.raw !== "string"
    || typeof row.nonce !== "string"
    || typeof row.intentExpiry !== "number"
    || typeof row.sig !== "string"
    || typeof row.oracleSig !== "string"
  ) {
    return null;
  }
  return {
    expiry: row.expiry,
    price: row.price,
    time: row.time,
    raw: row.raw,
    nonce: row.nonce,
    intentExpiry: row.intentExpiry,
    sig: row.sig,
    oracleSig: row.oracleSig,
  };
}

/** Only this service writes the file, so it is read back as is (ignoring any legacy beacon fields). */
export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "oracle.json"), "utf8")) as Partial<OracleFile>;
    return {
      samples: Array.isArray(parsed.samples)
        ? parsed.samples.map(normalizeSample).filter((sample): sample is StoredSample => sample != null)
        : [],
      fixings: Array.isArray(parsed.fixings)
        ? parsed.fixings.map(normalizeFixing).filter((row): row is StoredFixing => row != null)
        : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return empty();
  }
}

/** Write then fsync the tmp file before rename so a crash cannot leave a torn oracle.json. */
export async function saveStore(dir: string, file: OracleFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJsonFile(path.join(dir, "oracle.json"), file);
}
