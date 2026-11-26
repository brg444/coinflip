import { openPremium, type Book, type Caps, type QuoteRow } from "./book.ts";

export const MAX_OPEN_PER_CLIENT = 3;
export const MAX_OPEN_QUOTES = 200;

export type LimiterOpts = {
  windowMs?: number;
  maxPerClient?: number;
  maxGlobal?: number;
  maxTrackedKeys?: number;
};

/**
 * Serializes async critical sections so concurrent RFQ bursts cannot interleave
 * across `await` boundaries (e.g. `refreshFloat`) to over-commit desk float,
 * open-quote caps, or strike/total exposure limits.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * In-memory sliding-window RFQ rate limiter (per-pubkey and global) with bounded memory.
 */
export class RfqLimiter {
  private readonly windowMs: number;
  private readonly maxPerClient: number;
  private readonly maxGlobal: number;
  private readonly maxTrackedKeys: number;
  private readonly byClient = new Map<string, number[]>();
  private global: number[] = [];

  constructor(opts: LimiterOpts = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxPerClient = opts.maxPerClient ?? 10;
    this.maxGlobal = opts.maxGlobal ?? 120;
    this.maxTrackedKeys = opts.maxTrackedKeys ?? 5_000;
  }

  allow(clientPubkey: string, nowMs = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    this.global = this.global.filter((at) => at > cutoff);
    if (this.global.length >= this.maxGlobal) return false;

    const prev = this.byClient.get(clientPubkey);
    const active = prev ? prev.filter((at) => at > cutoff) : [];
    if (prev) this.byClient.delete(clientPubkey);
    if (active.length >= this.maxPerClient) {
      this.byClient.set(clientPubkey, active);
      return false;
    }

    active.push(nowMs);
    if (this.byClient.size >= this.maxTrackedKeys) {
      const oldest = this.byClient.keys().next().value;
      if (oldest !== undefined) this.byClient.delete(oldest);
    }
    this.byClient.set(clientPubkey, active);
    this.global.push(nowMs);
    return true;
  }
}

/**
 * Cap live unpaid quotes per client pubkey and globally so one caller cannot flood
 * arkd EventSource subscriptions or starve float reservations.
 */
export function openQuoteCapRefusal(
  rows: readonly Pick<QuoteRow, "status" | "deadline" | "clientPubkey">[],
  clientPubkey: string,
  now: number,
  limits: { perClient?: number; global?: number } = {},
): string {
  const perClientMax = limits.perClient ?? MAX_OPEN_PER_CLIENT;
  const globalMax = limits.global ?? MAX_OPEN_QUOTES;
  let clientOpen = 0;
  let totalOpen = 0;
  for (const row of rows) {
    if (row.status !== "open" || row.deadline <= now) continue;
    totalOpen += 1;
    if (row.clientPubkey === clientPubkey) clientOpen += 1;
  }
  if (clientOpen >= perClientMax) return "too many open quotes";
  if (totalOpen >= globalMax) return "desk busy";
  return "";
}

/**
 * Atomic check-and-hold critical section for Predict quotes.
 * Serialized behind `mutex` so concurrent Nostr requests cannot race across
 * `refreshFloat()` to bypass `openQuoteCapRefusal`, `eligibleFloat`, or `caps`.
 */
export async function reserveQuote(opts: {
  mutex: AsyncMutex;
  book: Pick<Book, "list" | "hold">;
  row: QuoteRow;
  from: string;
  now: () => number;
  caps: Caps;
  draining: () => boolean;
  eligibleFloat: () => bigint;
  refreshFloat: () => Promise<void>;
  limits?: { perClient?: number; global?: number };
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  return opts.mutex.run(async () => {
    const now = opts.now();
    if (opts.draining()) return { ok: false, reason: "draining" };
    if (opts.row.deadline <= now) return { ok: false, reason: "expired" };
    const capRefusal = openQuoteCapRefusal(opts.book.list(), opts.from, now, opts.limits);
    if (capRefusal) return { ok: false, reason: capRefusal };
    const payout = BigInt(opts.row.collateral);
    if (opts.eligibleFloat() < openPremium(opts.book.list(), now) + payout) {
      await opts.refreshFloat();
    }
    if (opts.eligibleFloat() < openPremium(opts.book.list(), now) + payout) {
      return { ok: false, reason: "float short" };
    }
    if (!opts.book.hold(opts.row, opts.caps, now)) {
      return { ok: false, reason: "exposure" };
    }
    return { ok: true };
  });
}
