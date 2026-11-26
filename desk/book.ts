import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PredictKind } from "../protocol/constants.ts";
import { writeJsonFile } from "../protocol/sqlite-storage.ts";

export type QuoteStatus = "open" | "filled" | "expired";

/**
 * One Predict quote: the bettor holds and pays `premium` (stake); the desk
 * writes and locks `collateral` (full payout) in PredictVaultV3.
 */
export type QuoteRow = {
  rfqId: string;
  collateral: string;
  premium: string;
  kind: PredictKind;
  strike: string;
  expiry: number;
  deadline: number;
  validUntil: number;
  exit: number;
  writerPubkey: string;
  writerPkScript: string;
  holderPubkey: string;
  holderPkScript: string;
  oraclePubkey: string;
  backupPubkey: string;
  voidAfter: number;
  fallbackDelay: number;
  finalExitDelay: number;
  intentAddress: string;
  vaultAddress: string;
  status: QuoteStatus;
  fillTxid?: string;
  createdAt: number;
  clientPubkey: string;
};

export type Caps = {
  perStrike: bigint;
  total: bigint;
};

type FileShape = {
  quotes: QuoteRow[];
};

/** Legacy book rows missing a 64-hex `oraclePubkey` cannot be registered or filled. */
export function hasOracle(row: Partial<QuoteRow>): boolean {
  return (row.kind === 2 || row.kind === 3) && /^[0-9a-f]{64}$/.test(row.oraclePubkey ?? "");
}

/** Float a fill spends: the full payout locked into PredictVault. */
export function outlay(row: Pick<QuoteRow, "collateral">): bigint {
  return BigInt(row.collateral);
}

/** Float already promised by open quotes. A new quote has to fit beside this. */
export function openPremium(rows: readonly QuoteRow[], now: number): bigint {
  let sum = 0n;
  for (const row of rows) {
    if (row.status === "open" && row.deadline > now) sum += outlay(row);
  }
  return sum;
}

function liveQuote(row: QuoteRow, now: number): boolean {
  if (row.status === "open") return row.deadline > now;
  if (row.status === "filled") {
    if (!row.fillTxid) return true;
    return row.expiry > now;
  }
  return false;
}

export type QuoteFilter = "live" | "open" | "filled" | "expired" | "all";

/** Expired rows and fills whose vault has already expired. The book does not need them. */
export function finishedQuote(row: QuoteRow, now: number): boolean {
  if (row.status === "expired") return true;
  return row.status === "filled" && Boolean(row.fillTxid) && row.expiry <= now;
}

export function quoteCounts(rows: readonly QuoteRow[], now: number): {
  live: number;
  open: number;
  filled: number;
  expired: number;
  total: number;
} {
  const counts = { live: 0, open: 0, filled: 0, expired: 0, total: rows.length };
  for (const row of rows) {
    if (row.status === "open") counts.open += 1;
    else if (row.status === "filled") counts.filled += 1;
    else counts.expired += 1;
    if (liveQuote(row, now)) counts.live += 1;
  }
  return counts;
}

export function pageQuotes(rows: readonly QuoteRow[], opts: {
  filter: QuoteFilter;
  now: number;
  offset: number;
  limit: number;
}): { quotes: QuoteRow[]; total: number; offset: number; limit: number } {
  const matched: QuoteRow[] = [];
  for (const row of rows) {
    if (opts.filter === "all" || (opts.filter === "live" ? liveQuote(row, opts.now) : row.status === opts.filter)) {
      matched.push(row);
    }
  }
  matched.sort((a, b) => b.createdAt - a.createdAt || (a.rfqId < b.rfqId ? 1 : -1));
  const offset = Math.max(0, opts.offset);
  const limit = Math.max(0, opts.limit);
  return { quotes: matched.slice(offset, offset + limit), total: matched.length, offset, limit };
}

export class Book {
  private rows: QuoteRow[] = [];
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  static async open(dir: string): Promise<Book> {
    await mkdir(dir, { recursive: true });
    const book = new Book(path.join(dir, "book.json"));
    try {
      const parsed = JSON.parse(await readFile(book.file, "utf8")) as FileShape;
      book.rows = Array.isArray(parsed.quotes) ? parsed.quotes : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return book;
  }

  get(rfqId: string): QuoteRow | undefined {
    return this.rows.find((row) => row.rfqId === rfqId);
  }

  list(): QuoteRow[] {
    return this.rows;
  }

  /** Remove quotes that can no longer fill or count toward exposure. */
  prune(now: number): QuoteRow[] {
    const removed: QuoteRow[] = [];
    const kept: QuoteRow[] = [];
    for (const row of this.rows) {
      if (finishedQuote(row, now)) removed.push(row);
      else kept.push(row);
    }
    if (removed.length) this.rows = kept;
    return removed;
  }

  exposure(now: number): { total: bigint; byStrike: Map<string, bigint> } {
    const byStrike = new Map<string, bigint>();
    let total = 0n;
    for (const row of this.rows) {
      const counted = (row.status === "open" && row.deadline > now)
        || (row.status === "filled" && Boolean(row.fillTxid) && row.expiry > now);
      if (!counted) continue;
      const amount = BigInt(row.collateral);
      total += amount;
      byStrike.set(row.strike, (byStrike.get(row.strike) ?? 0n) + amount);
    }
    return { total, byStrike };
  }

  /** One rfqId, one row. Refuses while a same-id quote is still live; replaces dead ones. */
  hold(row: QuoteRow, caps: Caps, now: number): boolean {
    const prior = this.rows.find((item) => item.rfqId === row.rfqId);
    if (prior && liveQuote(prior, now)) return false;
    if (prior) this.rows = this.rows.filter((item) => item.rfqId !== row.rfqId);
    const amount = BigInt(row.collateral);
    const { total, byStrike } = this.exposure(now);
    const strike = (byStrike.get(row.strike) ?? 0n) + amount;
    if (strike > caps.perStrike || total + amount > caps.total) return false;
    this.rows.push(row);
    return true;
  }

  mark(rfqId: string, status: QuoteStatus, fillTxid?: string): QuoteRow | undefined {
    const row = this.get(rfqId);
    if (!row) return undefined;
    row.status = status;
    if (fillTxid) row.fillTxid = fillTxid;
    return row;
  }

  async save(): Promise<void> {
    const run = this.writing.then(() => writeJsonFile(this.file, { quotes: this.rows }));
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }
}
