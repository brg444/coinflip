import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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

type SampleRow = {
  price: string;
  time: number;
  raw: string | null;
  nonce: string | null;
  intent_expiry: number | null;
  sig: string | null;
};

type FixingRow = {
  expiry: number;
  price: string;
  time: number;
  raw: string;
  nonce: string;
  intent_expiry: number;
  sig: string;
  oracle_sig: string;
};

function rowToSample(row: SampleRow): StoredSample {
  return {
    price: row.price,
    time: row.time,
    ...(row.raw != null ? { raw: row.raw } : {}),
    ...(row.nonce != null ? { nonce: row.nonce } : {}),
    ...(row.intent_expiry != null ? { intentExpiry: row.intent_expiry } : {}),
    ...(row.sig != null ? { sig: row.sig } : {}),
  };
}

function rowToFixing(row: FixingRow): StoredFixing {
  return {
    expiry: row.expiry,
    price: row.price,
    time: row.time,
    raw: row.raw,
    nonce: row.nonce,
    intentExpiry: row.intent_expiry,
    sig: row.sig,
    oracleSig: row.oracle_sig,
  };
}

/**
 * Crash-safe SQLite WAL oracle store (`synchronous = FULL`, `PRIMARY KEY (expiry)` anti-equivocation).
 * Automatically performs a one-time atomic import from legacy `oracle.json` on first open.
 */
export class OracleStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private closed = false;

  private readonly stmtInsertSample: StatementSync;
  private readonly stmtGetSamples: StatementSync;
  private readonly stmtLatestSample: StatementSync;
  private readonly stmtSampleCount: StatementSync;
  private readonly stmtHasSampleAfter: StatementSync;
  private readonly stmtChooseStrictSample: StatementSync;
  private readonly stmtDueCandidates: StatementSync;
  private readonly stmtGetFixing: StatementSync;
  private readonly stmtInsertFixing: StatementSync;
  private readonly stmtRecentFixings: StatementSync;
  private readonly stmtFixingCount: StatementSync;
  private readonly stmtPruneSamples: StatementSync;
  private readonly stmtPruneFixings: StatementSync;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS samples (
        time INTEGER NOT NULL,
        raw_key TEXT NOT NULL,
        price TEXT NOT NULL,
        raw TEXT,
        nonce TEXT,
        intent_expiry INTEGER,
        sig TEXT,
        PRIMARY KEY (time, raw_key)
      );
      CREATE INDEX IF NOT EXISTS idx_samples_time ON samples(time);

      CREATE TABLE IF NOT EXISTS fixings (
        expiry INTEGER PRIMARY KEY,
        price TEXT NOT NULL,
        time INTEGER NOT NULL,
        raw TEXT NOT NULL,
        nonce TEXT NOT NULL,
        intent_expiry INTEGER NOT NULL,
        sig TEXT NOT NULL,
        oracle_sig TEXT NOT NULL
      );
    `);

    this.stmtInsertSample = this.db.prepare(
      `INSERT OR IGNORE INTO samples (time, raw_key, price, raw, nonce, intent_expiry, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetSamples = this.db.prepare(
      `SELECT price, time, raw, nonce, intent_expiry, sig
       FROM samples
       WHERE time >= ? AND time <= ?
       ORDER BY time DESC, raw_key DESC
       LIMIT ?`,
    );
    this.stmtLatestSample = this.db.prepare(
      `SELECT price, time, raw, nonce, intent_expiry, sig
       FROM samples
       ORDER BY time DESC, raw_key DESC
       LIMIT 1`,
    );
    this.stmtSampleCount = this.db.prepare(`SELECT COUNT(*) AS count FROM samples`);
    this.stmtHasSampleAfter = this.db.prepare(`SELECT 1 AS found FROM samples WHERE time > ? LIMIT 1`);
    this.stmtChooseStrictSample = this.db.prepare(
      `SELECT price, time, raw, nonce, intent_expiry, sig
       FROM samples
       WHERE time >= ? AND time <= ?
         AND raw IS NOT NULL AND nonce IS NOT NULL AND intent_expiry IS NOT NULL AND sig IS NOT NULL
       ORDER BY time DESC, raw_key DESC
       LIMIT 1`,
    );
    this.stmtDueCandidates = this.db.prepare(
      `SELECT DISTINCT (time - (time % CAST(? AS INTEGER))) AS expiry
       FROM samples
       WHERE time > 1800
         AND (time % CAST(? AS INTEGER)) <= CAST(? AS INTEGER)
         AND raw IS NOT NULL AND nonce IS NOT NULL AND intent_expiry IS NOT NULL AND sig IS NOT NULL
         AND (time - (time % CAST(? AS INTEGER))) + CAST(? AS INTEGER) <= CAST(? AS INTEGER)
         AND NOT EXISTS (
           SELECT 1 FROM fixings f
           WHERE f.expiry = (samples.time - (samples.time % CAST(? AS INTEGER)))
         )
       ORDER BY expiry ASC`,
    );
    this.stmtGetFixing = this.db.prepare(
      `SELECT expiry, price, time, raw, nonce, intent_expiry, sig, oracle_sig
       FROM fixings
       WHERE expiry = ?`,
    );
    this.stmtInsertFixing = this.db.prepare(
      `INSERT OR IGNORE INTO fixings (expiry, price, time, raw, nonce, intent_expiry, sig, oracle_sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtRecentFixings = this.db.prepare(
      `SELECT expiry, price, time, raw, nonce, intent_expiry, sig, oracle_sig
       FROM fixings
       ORDER BY expiry DESC
       LIMIT ?`,
    );
    this.stmtFixingCount = this.db.prepare(`SELECT COUNT(*) AS count FROM fixings`);
    this.stmtPruneSamples = this.db.prepare(`DELETE FROM samples WHERE time < ?`);
    this.stmtPruneFixings = this.db.prepare(`DELETE FROM fixings WHERE expiry < ?`);
  }

  journalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? "").toLowerCase();
  }

  synchronousMode(): number {
    const row = this.db.prepare("PRAGMA synchronous").get() as { synchronous?: number } | undefined;
    return Number(row?.synchronous ?? -1);
  }

  insertSample(sample: StoredSample): boolean {
    const res = this.stmtInsertSample.run(
      sample.time,
      sample.raw ?? sample.price,
      sample.price,
      sample.raw ?? null,
      sample.nonce ?? null,
      sample.intentExpiry ?? null,
      sample.sig ?? null,
    );
    return Number(res.changes) > 0;
  }

  getSamples(from: number, to: number, limit: number): StoredSample[] {
    const rows = this.stmtGetSamples.all(from, to, limit) as unknown as SampleRow[];
    return rows.map(rowToSample);
  }

  latestSample(): StoredSample | null {
    const row = this.stmtLatestSample.get() as unknown as SampleRow | undefined;
    return row ? rowToSample(row) : null;
  }

  sampleCount(): number {
    const row = this.stmtSampleCount.get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  hasSampleAfter(timestamp: number): boolean {
    return this.stmtHasSampleAfter.get(timestamp) != null;
  }

  chooseStrictSample(expiry: number, expiryLag: number): StoredSample | null {
    const row = this.stmtChooseStrictSample.get(expiry, expiry + expiryLag) as unknown as SampleRow | undefined;
    return row ? rowToSample(row) : null;
  }

  dueCandidateExpiries(now: number, expiryLag: number, gridS: number): number[] {
    const rows = this.stmtDueCandidates.all(
      gridS, gridS, expiryLag, gridS, expiryLag, now, gridS,
    ) as unknown as { expiry: number }[];
    return rows.map((row) => Number(row.expiry));
  }

  getFixing(expiry: number): StoredFixing | null {
    const row = this.stmtGetFixing.get(expiry) as unknown as FixingRow | undefined;
    return row ? rowToFixing(row) : null;
  }

  /**
   * Atomically commit a fixing under `PRIMARY KEY (expiry)` anti-equivocation.
   * If a fixing for `row.expiry` already exists, it is preserved untouched and returned.
   */
  insertFixing(row: StoredFixing): StoredFixing {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmtInsertFixing.run(
        row.expiry,
        row.price,
        row.time,
        row.raw,
        row.nonce,
        row.intentExpiry,
        row.sig,
        row.oracleSig,
      );
      const committed = this.getFixing(row.expiry);
      this.db.exec("COMMIT");
      if (!committed) throw new Error(`failed to persist fixing for ${row.expiry}`);
      return committed;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recentFixings(limit = 20): StoredFixing[] {
    const rows = this.stmtRecentFixings.all(limit) as unknown as FixingRow[];
    return rows.map(rowToFixing).reverse();
  }

  fixingCount(): number {
    const row = this.stmtFixingCount.get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  prune(now: number): void {
    this.stmtPruneSamples.run(now - SAMPLE_HISTORY_S);
    this.stmtPruneFixings.run(now - FIXING_HISTORY_S);
  }

  importLegacy(file: OracleFile): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of file.samples) this.insertSample(sample);
      for (const fixing of file.fixings) {
        this.stmtInsertFixing.run(
          fixing.expiry,
          fixing.price,
          fixing.time,
          fixing.raw,
          fixing.nonce,
          fixing.intentExpiry,
          fixing.sig,
          fixing.oracleSig,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function parseLegacyJson(raw: string): OracleFile {
  const parsed = JSON.parse(raw) as Partial<OracleFile>;
  return {
    samples: Array.isArray(parsed.samples)
      ? parsed.samples.map(normalizeSample).filter((sample): sample is StoredSample => sample != null)
      : [],
    fixings: Array.isArray(parsed.fixings)
      ? parsed.fixings.map(normalizeFixing).filter((row): row is StoredFixing => row != null)
      : [],
  };
}

/** Open the SQLite WAL oracle store under `dir`, migrating any legacy `oracle.json` once on first run. */
export async function openOracleStore(dir: string): Promise<OracleStore> {
  await mkdir(dir, { recursive: true });
  const store = new OracleStore(path.join(dir, "oracle.sqlite"));
  const legacyPath = path.join(dir, "oracle.json");
  if (store.sampleCount() === 0 && store.fixingCount() === 0 && existsSync(legacyPath)) {
    try {
      const legacy = parseLegacyJson(await readFile(legacyPath, "utf8"));
      if (legacy.samples.length || legacy.fixings.length) {
        store.importLegacy(legacy);
      }
      await rename(legacyPath, `${legacyPath}.migrated`).catch(() => undefined);
    } catch (err) {
      store.close();
      throw err;
    }
  }
  return store;
}
