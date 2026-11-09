import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonFile } from "../protocol/sqlite-storage.ts";

export type StoredSample = {
  price: string;
  time: number;
};

/** Samples older than this are dropped. A day of one-minute prints. */
export const SAMPLE_HISTORY_S = 24 * 60 * 60;

export function pruneSamples(samples: readonly StoredSample[], now: number): StoredSample[] {
  const cutoff = now - SAMPLE_HISTORY_S;
  return samples.filter((sample) => sample.time >= cutoff);
}

export type StoredFixing = {
  expiry: number;
  price: string;
  /** Sample time signed for this expiry. The same pair is what a later rewrite may use. */
  time?: number;
  txid: string;
};

/**
 * The sample for an expiry. Prefer one taken inside `[expiry, expiry + expiryLag]`.
 * If that minute was missed, the newest sample in the expiryLag before expiry.
 * Anything older is not a fixing.
 */
export function chooseSample<T extends { time: number }>(samples: readonly T[], expiry: number, expiryLag: number): T | null {
  const hi = expiry + expiryLag;
  const close = samples.filter((sample) => sample.time >= expiry && sample.time <= hi);
  const pool = close.length > 0
    ? close
    : samples.filter((sample) => sample.time >= expiry - expiryLag && sample.time < expiry);
  if (!pool.length) return null;
  return pool.reduce((best, sample) => (sample.time >= best.time ? sample : best));
}

export type OracleFile = {
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  samples: StoredSample[];
  fixings: StoredFixing[];
};

const empty = (): OracleFile => ({ assetId: null, issueTxid: null, deployTxid: null, samples: [], fixings: [] });

function normalizeSample(value: unknown): StoredSample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as { price?: unknown; time?: unknown };
  if (typeof sample.price !== "string" || typeof sample.time !== "number") return null;
  return { price: sample.price, time: sample.time };
}

/** Only this service writes the file, so it is read back as is. */
export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "oracle.json"), "utf8")) as Partial<OracleFile>;
    return {
      ...empty(),
      ...parsed,
      samples: Array.isArray(parsed.samples) ? parsed.samples.map(normalizeSample).filter((sample): sample is StoredSample => sample != null) : [],
      fixings: Array.isArray(parsed.fixings) ? parsed.fixings : [],
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
