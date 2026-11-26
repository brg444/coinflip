import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { schnorr } from "@noble/curves/secp256k1.js";
import { SingleKey } from "@arkade-os/sdk";

import { PRICE_MAX } from "../protocol/constants.ts";
import { centsOf, intentSigned, type DiaIntent } from "../protocol/dia.ts";
import { FIX_DOMAIN, FIX_EXPIRY_LAG, FIX_GRID_S, predictFixDigest } from "../protocol/fixing.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import {
  FIXING_GRACE_S,
  openOracleStore,
  SAMPLE_HISTORY_S,
  type StoredFixing,
} from "./store.ts";

/**
 * Stateless DIA fixing oracle for standalone PredictVaultV3.
 * Streams pinned DIA BTC/USD EIP-712 prints into SQLite WAL (`synchronous = FULL`),
 * proactively finalizes and co-signs one canonical fixing per 5-minute close
 * (`expiry % 300 == 0`, `time in [expiry, expiry + 60]`) once the window settles,
 * and serves `GET /api/fixing` strictly read-only.
 */

const CSP = "default-src 'none'; frame-ancestors 'none'";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type OracleDeps = {
  dataDir: string;
  port?: number;
  host?: string;
  adminToken?: string;
  oracleKey?: Uint8Array;
  network?: string;
  /** Latest DIA OracleUpdate. Null when the feed has not answered. */
  pull?: () => Promise<DiaIntent | null>;
  /** How often to sample. Unset means the process only records prices it is given. */
  sampleEveryMs?: number;
  /** How often the background finalizer checks for settled close windows. Default 1000ms (0 disables). */
  finalizeEveryMs?: number;
  now?: () => number;
};

function authorized(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(token).digest();
  return timingSafeEqual(left, right);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!failed) {
          failed = true;
          req.pause();
          reject(new HttpError(413, "body too large"));
        }
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new HttpError(400, "json"));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "json");
  return value as Record<string, unknown>;
}

/** A stored DIA intent. `price` is the 18-decimal integer. `sig` is 64-byte r||s. */
function intentRequest(body: Record<string, unknown>): DiaIntent {
  const got = Object.keys(body);
  const keys = ["price", "time", "nonce", "intentExpiry", "sig"];
  if (got.length !== keys.length || got.some((key) => !keys.includes(key))) throw new HttpError(400, "unknown field");
  const price = whole(body.price, "price");
  const time = Number(whole(body.time, "time"));
  const nonce = whole(body.nonce, "nonce");
  const intentExpiry = Number(whole(body.intentExpiry, "intentExpiry"));
  if (!Number.isSafeInteger(time) || !Number.isSafeInteger(intentExpiry)) throw new HttpError(400, "time");
  if (typeof body.sig !== "string" || !/^[0-9a-fA-F]{128}$/.test(body.sig)) throw new HttpError(400, "sig");
  return { price, time, nonce, intentExpiry, sig: hexToBytes(body.sig) };
}

function whole(value: unknown, label: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new HttpError(400, label);
}

export async function createOracle(deps: OracleDeps) {
  if (deps.oracleKey && deps.oracleKey.length !== 32) throw new Error("ORACLE_KEY must be 32 bytes");
  const oraclePk = deps.oracleKey ? await SingleKey.fromHex(bytesToHex(deps.oracleKey)).xOnlyPublicKey() : null;
  const oraclePkHex = oraclePk ? bytesToHex(oraclePk) : null;
  const store = await openOracleStore(deps.dataDir);
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const lagS = Number(FIX_EXPIRY_LAG);
  const gridS = Number(FIX_GRID_S);

  function requireAdmin(req: http.IncomingMessage) {
    if (!deps.adminToken) throw new HttpError(404, "disabled");
    if (!authorized(req.headers.authorization, deps.adminToken)) throw new HttpError(401, "unauthorized");
  }

  function status() {
    return {
      network: deps.network ?? "mutinynet",
      pubkeys: oraclePkHex ? [oraclePkHex] : [],
      args: {
        domain: bytesToHex(FIX_DOMAIN),
        expiryLag: lagS,
        adminPk: oraclePkHex,
      },
      fixings: store.recentFixings(20).map(({ expiry, price, time }) => ({ expiry, price, time })),
      fixingCount: store.fixingCount(),
      samples: store.sampleCount(),
      latest: store.latestSample(),
    };
  }

  function isWindowSettled(expiryN: number, current: number): boolean {
    const closeEnd = expiryN + lagS;
    if (current < closeEnd) return false;
    if (current >= closeEnd + FIXING_GRACE_S) return true;
    return store.hasSampleAfter(closeEnd);
  }

  /**
   * Proactively finalize and persist canonical fixings for every settled 5-minute window
   * that has a signed DIA sample in `[expiry, expiry + 60]`. Commits atomically into
   * SQLite WAL (`synchronous = FULL`, `PRIMARY KEY (expiry)`) before any HTTP caller sees it.
   */
  function finalizeDue(): number {
    if (!deps.oracleKey || !oraclePkHex) return 0;
    const current = now();
    store.prune(current);
    const dueExpiries = store.dueCandidateExpiries(current, lagS, gridS);
    let finalized = 0;
    for (const expiryN of dueExpiries) {
      if (!isWindowSettled(expiryN, current)) continue;
      const chosen = store.chooseStrictSample(expiryN, lagS);
      if (!chosen || !chosen.raw || !chosen.sig || !chosen.nonce || typeof chosen.intentExpiry !== "number") {
        continue;
      }
      const cents = centsOf(BigInt(chosen.raw));
      const oracleSig = bytesToHex(
        schnorr.sign(predictFixDigest({ expiry: BigInt(expiryN), cents, time: BigInt(chosen.time) }), deps.oracleKey),
      );
      store.insertFixing({
        expiry: expiryN,
        price: cents.toString(),
        time: chosen.time,
        raw: chosen.raw,
        nonce: chosen.nonce,
        intentExpiry: chosen.intentExpiry,
        sig: chosen.sig,
        oracleSig,
      });
      finalized += 1;
    }
    return finalized;
  }

  async function recordIntent(intent: DiaIntent) {
    if (!oraclePk) throw new HttpError(400, "ORACLE_KEY is required");
    let cents: bigint;
    try {
      cents = centsOf(intent.price);
    } catch {
      throw new HttpError(400, "price");
    }
    if (cents > PRICE_MAX) throw new HttpError(400, "price");
    if (!Number.isSafeInteger(intent.time) || intent.time <= 0) throw new HttpError(400, "time");
    const current = now();
    if (intent.time > current) throw new HttpError(400, "future timestamp");
    if (!intentSigned(intent)) throw new HttpError(400, "dia signature");
    const raw = intent.price.toString();
    const inserted = store.insertSample({
      price: cents.toString(),
      time: intent.time,
      raw,
      nonce: intent.nonce.toString(),
      intentExpiry: intent.intentExpiry,
      sig: bytesToHex(intent.sig),
    });
    store.prune(current);
    finalizeDue();
    if (!inserted) {
      return { ok: true, time: intent.time, price: cents.toString(), duplicate: true };
    }
    return { ok: true, time: intent.time, price: cents.toString() };
  }

  /** Strictly read-only: filters to the recent retention window without mutating SQLite. */
  function pricePage(query: URLSearchParams) {
    const current = now();
    const cutoff = current - SAMPLE_HISTORY_S;
    const rawFrom = Number(query.get("from") ?? "0");
    const rawTo = Number(query.get("to") ?? String(current));
    const from = Number.isFinite(rawFrom) ? Math.max(rawFrom, cutoff) : cutoff;
    const to = Number.isFinite(rawTo) ? rawTo : current;
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? "50") || 50));
    const signed = query.get("signed") === "1";
    const rows = store.getSamples(from, to, limit).map((sample) => (
      signed && sample.raw && sample.nonce && typeof sample.intentExpiry === "number" && sample.sig
        ? {
            price: sample.price,
            time: sample.time,
            raw: sample.raw,
            nonce: sample.nonce,
            intentExpiry: sample.intentExpiry,
            sig: sample.sig,
          }
        : { price: sample.price, time: sample.time }
    ));
    return { samples: rows };
  }

  function formatFixing(row: StoredFixing) {
    return {
      expiry: row.expiry,
      price: row.price,
      time: row.time,
      raw: row.raw,
      nonce: row.nonce,
      intentExpiry: row.intentExpiry,
      sig: row.sig,
      oracleSig: row.oracleSig,
      oraclePk: oraclePkHex!,
    };
  }

  /**
   * Strictly read-only lookup for a canonical signed fixing (`expiry % 300 == 0`, `now >= expiry + 60`).
   * Public HTTP callers can never trigger signing or database writes; fixings are committed solely by
   * the proactive background finalizer (`finalizeDue`) into SQLite WAL.
   */
  function getFixing(expiryParam: string | null) {
    if (!deps.oracleKey || !oraclePkHex) throw new HttpError(400, "ORACLE_KEY is required");
    if (!expiryParam || !/^[0-9]+$/.test(expiryParam)) throw new HttpError(400, "expiry");
    const expiry = BigInt(expiryParam);
    if (expiry <= 1800n) throw new HttpError(400, "expiry");
    if (expiry % FIX_GRID_S !== 0n) throw new HttpError(400, "expiry grid");
    const expiryN = Number(expiry);
    if (!Number.isSafeInteger(expiryN)) throw new HttpError(400, "expiry");
    const current = now();
    if (BigInt(current) < expiry + FIX_EXPIRY_LAG) throw new HttpError(400, "before expiry time");

    const existing = store.getFixing(expiryN);
    if (existing) return formatFixing(existing);

    if (!isWindowSettled(expiryN, current)) {
      throw new HttpError(425, "waiting for close print");
    }
    if (store.chooseStrictSample(expiryN, lagS)) {
      throw new HttpError(425, "waiting for close print");
    }
    throw new HttpError(404, "no sample");
  }

  // Finalize any already-settled windows on startup before accepting requests.
  finalizeDue();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? "/", "http://oracle");
    } catch {
      sendJson(res, 400, { error: "url" });
      return;
    }
    const url = parsed.pathname;
    try {
      if (req.method === "GET" && (url === "/" || url === "/api/status")) return sendJson(res, 200, status());
      if (req.method === "GET" && url === "/api/prices") return sendJson(res, 200, pricePage(parsed.searchParams));
      if (req.method === "GET" && url === "/api/fixing") return sendJson(res, 200, getFixing(parsed.searchParams.get("expiry")));
      if (req.method === "POST" && url === "/api/intent") {
        requireAdmin(req);
        const body = asRecord(await readBody(req, 4096));
        return sendJson(res, 200, await recordIntent(intentRequest(body)));
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const statusCode = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "error";
      if (!res.headersSent) sendJson(res, statusCode, { error: message });
      if (statusCode === 413) req.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(deps.port ?? 0, deps.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  async function takeSample() {
    if (!deps.pull) return;
    const intent = await deps.pull();
    if (!intent) return;
    await recordIntent(intent);
  }

  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  const poll = () => {
    track(takeSample().catch((err) => {
      console.error("oracle sample", err instanceof Error ? err.message : "sample failed");
    }));
  };
  const sampleTimer = deps.sampleEveryMs && deps.sampleEveryMs > 0 ? setInterval(poll, deps.sampleEveryMs) : undefined;
  if (sampleTimer) poll();

  const finalizeMs = deps.finalizeEveryMs ?? 1_000;
  const finalizeTimer = finalizeMs > 0
    ? setInterval(() => {
        try {
          finalizeDue();
        } catch (err) {
          console.error("oracle finalize", err instanceof Error ? err.message : "finalize failed");
        }
      }, finalizeMs)
    : undefined;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    finalizeDue,
    ingestIntent: (intent: DiaIntent) => {
      const job = recordIntent(intent);
      track(job);
      return job;
    },
    close: async () => {
      if (sampleTimer) clearInterval(sampleTimer);
      if (finalizeTimer) clearInterval(finalizeTimer);
      await Promise.all([...pending]);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      store.close();
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
