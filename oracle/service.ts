import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, SingleKey, Transaction, type ArkProvider, type CSVMultisigTapscript, type EmulatorProvider, type Network } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { attestDigest, BEACON_GRID_S, beaconIdOf, bindBeacon, decodeState, genesisOutputs, internalTxid, nextState, priceValue, reboardDigest, reseedDigest, statePacketOf } from "../protocol/beacon.ts";
import { BEACON_READ_FEE, DUST_SATS, EXIT, PRICE_MAX, vaultProgramId } from "../protocol/constants.ts";
import { bindContracts } from "../protocol/contracts.ts";
import { buildAttest, buildReseed, reboardBeacon, submit } from "../protocol/cospend.ts";
import { centsOf, intentSigned, type DiaIntent } from "../protocol/dia.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { positionFromAnnouncement, termsFor } from "../settle/positions.ts";
import { chooseSample as pickSample, loadStore, pruneSamples, saveStore, type StoredSample } from "./store.ts";

/**
 * Testnet publisher. It keeps a day of DIA OracleUpdate intents and spends
 * the beacon once per 5-minute close. The coin checks both the pinned DIA
 * signature and this service's adminPk signature so only the oracle's chosen
 * DIA print can be attested.
 */

const DOMAIN = new TextEncoder().encode("BTCUSD-FIX");
const EXPIRY_LAG = 60n;
const READ_FEE = BEACON_READ_FEE;
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'";
const here = path.dirname(fileURLToPath(import.meta.url));

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type HeldCoin = {
  txid: string;
  vout: number;
  value: number | bigint;
  isSpent?: boolean;
  isSwept?: boolean;
  expiresAt?: Date;
  assets?: readonly { assetId: string; amount: bigint | number }[];
};

export type OracleWallet = {
  assetManager: {
    issue(params: { amount: bigint }): Promise<{ arkTxId: string; assetId: string }>;
  };
  getAddress(): Promise<string>;
  getVtxos(): Promise<HeldCoin[]>;
  buildAndSubmitOffchainTx(
    inputs: HeldCoin[],
    outputs: { script: Uint8Array; amount: bigint }[],
  ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }>;
  finalizePendingTxs?(vtxos?: HeldCoin[]): Promise<{ finalized: string[]; pending: string[] }>;
  walletRepository?: {
    getWalletState(): Promise<{ settings?: { hasPendingTx?: boolean } } | null>;
    saveWalletState(state: { settings?: { hasPendingTx?: boolean } }): Promise<void>;
  };
  arkServerPublicKey: Uint8Array;
  serverUnrollScript: CSVMultisigTapscript.Type;
};

export type OracleIndexer = {
  getVtxos(opts: { scripts: string[]; spendableOnly?: boolean }): Promise<{ vtxos: HeldCoin[] }>;
  getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
};

export type OracleDeps = {
  dataDir: string;
  port?: number;
  host?: string;
  adminToken?: string;
  oracleKey?: Uint8Array;
  emulatorKey: Uint8Array;
  wallet?: OracleWallet;
  indexer?: OracleIndexer;
  emulator?: Pick<EmulatorProvider, "submitTx"> & Partial<Pick<EmulatorProvider, "submitIntent">>;
  arkProvider?: ArkProvider;
  sdkNetwork?: Network;
  exit?: bigint;
  hrp?: string;
  network?: string;
  deprecatedSigners?: readonly { pubkey: string; cutoffDate: string }[];
  /** Latest DIA OracleUpdate. Null when the feed has not answered. */
  pull?: () => Promise<DiaIntent | null>;
  /** How often to sample. Unset means the process only records prices it is given. */
  sampleEveryMs?: number;
  /** Expiries announced on nostr. The minute pass publishes these, not every clock minute. */
  announcedExpiries?: () => Iterable<number>;
  /** Full positions announced on nostr; filtered by beacon, freshness, grid, and live vault. */
  announcedPositions?: () => Iterable<OptionPosition>;
  /** Optional x-only pubkey; when set, auto-publish only positions where it is writer or holder. */
  allowedPubkey?: string;
  /** Called after an announced expiry is published or confirmed already on the beacon. */
  onPublishedExpiry?: (expiry: number) => void;
  now?: () => number;
};

export const MAX_ANNOUNCE_AGE_S = 3_600;
const PREDICT_GRID_S = 300;
const MAX_PUBLISH_PER_PASS = 4;

/** Announced 5-minute closes whose close minute has passed and that are not published yet. */
export function dueExpiries(expiries: Iterable<number>, now: number, done: ReadonlySet<number>, lag = 60): number[] {
  return [...new Set(expiries)]
    .filter((expiry) => !done.has(expiry) && expiry % PREDICT_GRID_S === 0 && now >= expiry + lag)
    .sort((a, b) => a - b);
}

export function duePositionExpiries(
  positions: Iterable<OptionPosition>,
  opts: { assetId: string; now: number; done: ReadonlySet<number>; lag?: number; maxAge?: number; limit?: number; allowedPubkey?: string },
): { expiry: number; positions: OptionPosition[] }[] {
  const id = asset.AssetId.fromString(opts.assetId);
  const ourTxid = bytesToHex(id.txid).toLowerCase();
  const ourGidx = Number(id.groupIndex);
  const lag = opts.lag ?? 60;
  const maxAge = opts.maxAge ?? MAX_ANNOUNCE_AGE_S;
  const limit = opts.limit ?? MAX_PUBLISH_PER_PASS;
  const allowed = opts.allowedPubkey?.toLowerCase();
  const byExpiry = new Map<number, OptionPosition[]>();
  for (const pos of positions) {
    if (pos.beacon_txid.toLowerCase() !== ourTxid || pos.beacon_gidx !== ourGidx) continue;
    if (allowed && pos.writer_pubkey.toLowerCase() !== allowed && pos.holder_pubkey.toLowerCase() !== allowed) continue;
    if (pos.program_id !== vaultProgramId(pos.kind)) continue;
    if (BigInt(pos.collateral) < READ_FEE + DUST_SATS) continue;
    if (opts.done.has(pos.expiry)) continue;
    if (opts.now < pos.expiry + lag) continue;
    if (opts.now - pos.expiry > maxAge) continue;
    if (pos.expiry % PREDICT_GRID_S !== 0) continue;
    const list = byExpiry.get(pos.expiry);
    if (list) list.push(pos);
    else byExpiry.set(pos.expiry, [pos]);
  }
  // Publish oldest due close first so monotonic beacon expiry order never blocks an earlier close.
  return [...byExpiry.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([expiry, list]) => ({ expiry, positions: list }));
}

/** A missing or out-of-window print. The minute pass skips it quietly and tries that expiry again later. */
export function skippedPublish(message: string): boolean {
  return message === "no sample" || message === "sample before expiry" || message === "sample after close";
}

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

function exact(body: Record<string, unknown>, keys: readonly string[]) {
  const got = Object.keys(body);
  if (got.length !== keys.length || got.some((key) => !keys.includes(key))) throw new HttpError(400, "unknown field");
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
  if (deps.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  const adminPk = deps.oracleKey ? await SingleKey.fromHex(bytesToHex(deps.oracleKey)).xOnlyPublicKey() : null;
  const store = await loadStore(deps.dataDir);
  let publishing = false;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);

  function requireAdmin(req: http.IncomingMessage) {
    if (!deps.adminToken) throw new HttpError(404, "disabled");
    if (!authorized(req.headers.authorization, deps.adminToken)) throw new HttpError(401, "unauthorized");
  }

  const exitDelay = deps.exit ?? EXIT;
  const hrp = deps.hrp;

  async function bound() {
    if (!store.assetId || !deps.wallet || !adminPk) return null;
    const id = asset.AssetId.fromString(store.assetId);
    return bindBeacon({
      id: beaconIdOf(id),
      domain: DOMAIN,
      expiryLag: EXPIRY_LAG,
      readFee: READ_FEE,
      adminPk,
      exit: exitDelay,
      hrp,
      serverKey: deps.wallet.arkServerPublicKey,
      emulatorKey: deps.emulatorKey,
    });
  }

  async function walletBalance(): Promise<bigint | null> {
    if (!deps.wallet) return null;
    const coins = await deps.wallet.getVtxos();
    return coins.filter((coin) => !coin.isSpent).reduce((sum, coin) => sum + BigInt(coin.value), 0n);
  }

  async function beaconCoinExpiry(script: Awaited<ReturnType<typeof bound>>): Promise<number | null> {
    if (!store.deployTxid || !store.assetId || !script || !deps.indexer) return null;
    try {
      const found = await deps.indexer.getVtxos({ scripts: [bytesToHex(script.pkScript)], spendableOnly: true });
      const coin = found.vtxos.find((vtxo) => !vtxo.isSpent && !vtxo.isSwept && vtxo.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
      if (!coin) return 0;
      if (!(coin.expiresAt instanceof Date)) return null;
      const ms = coin.expiresAt.getTime();
      return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    } catch {
      return null;
    }
  }

  async function status() {
    const id = store.assetId ? asset.AssetId.fromString(store.assetId) : null;
    const beacon = id ? beaconIdOf(id) : null;
    const script = await bound();
    const balance = await walletBalance();
    const beaconExpiry = await beaconCoinExpiry(script);
    const latest = store.samples.reduce<StoredSample | null>((best, sample) => (!best || sample.time >= best.time ? sample : best), null);
    return {
      network: deps.network ?? "mutinynet",
      assetId: store.assetId,
      issueTxid: store.issueTxid,
      deployTxid: store.deployTxid,
      wallet: deps.wallet ? await deps.wallet.getAddress() : null,
      balance: balance == null ? null : balance.toString(),
      address: script?.address ?? null,
      beaconExpiry,
      deprecatedSigners: deps.deprecatedSigners ?? [],
      pubkeys: adminPk ? [bytesToHex(adminPk)] : [],
      args: {
        ctrlTxid: beacon ? bytesToHex(beacon.txid) : null,
        domain: bytesToHex(DOMAIN),
        expiryLag: Number(EXPIRY_LAG),
        readFee: Number(READ_FEE),
        adminPk: adminPk ? bytesToHex(adminPk) : null,
        exit: Number(exitDelay),
      },
      fixings: store.fixings,
      samples: store.samples.length,
      latest,
    };
  }

  async function save() {
    await saveStore(deps.dataDir, store);
  }

  function asHttp(err: unknown, fallback: string): HttpError {
    if (err instanceof HttpError) return err;
    const message = err instanceof Error ? err.message : fallback;
    if (/insufficient funds/i.test(message)) return new HttpError(400, "fund wallet");
    return new HttpError(500, message.slice(0, 200) || fallback);
  }

  async function markPending() {
    const repo = deps.wallet?.walletRepository;
    if (!repo) return;
    const state = (await repo.getWalletState()) ?? {};
    await repo.saveWalletState({
      ...state,
      settings: { ...state.settings, hasPendingTx: true },
    });
  }

  /** Finish submitTx that never got finalizeTx, and adopt an issued unit if the store is empty. */
  async function recover() {
    if (!deps.wallet?.finalizePendingTxs) throw new HttpError(400, "wallet required");
    await markPending();
    let finalized: string[] = [];
    let pending: string[] = [];
    try {
      ({ finalized, pending } = await deps.wallet.finalizePendingTxs());
    } catch (err) {
      throw asHttp(err, "recover failed");
    }
    let adopted: { assetId: string; txid: string } | null = null;
    if (!store.assetId) {
      const coins = await deps.wallet.getVtxos();
      for (const coin of coins.filter((item) => !item.isSpent)) {
        const unit = coin.assets?.find((item) => BigInt(item.amount) === 1n && typeof item.assetId === "string" && item.assetId.length >= 64);
        if (!unit) continue;
        try {
          const id = asset.AssetId.fromString(unit.assetId);
          store.assetId = unit.assetId;
          store.issueTxid = bytesToHex(id.txid);
          await save();
          adopted = { assetId: store.assetId, txid: store.issueTxid };
          break;
        } catch {
          // skip unparseable asset ids
        }
      }
    }
    return { finalized, pending, adopted, balance: (await walletBalance())?.toString() ?? null };
  }

  async function issue() {
    if (store.assetId) throw new HttpError(409, "already issued");
    if (!deps.wallet || !deps.oracleKey) throw new HttpError(400, "ORACLE_KEY is required");
    if (deps.wallet.finalizePendingTxs) {
      try {
        const recovered = await recover();
        if (store.assetId) return { assetId: store.assetId, txid: store.issueTxid!, recovered };
      } catch {
        // continue to a fresh issue when nothing is pending
      }
    }
    const balance = await walletBalance();
    if (balance == null || balance < 330n) throw new HttpError(400, "fund wallet");
    let issued: { assetId: string; arkTxId: string };
    try {
      await markPending();
      issued = await deps.wallet.assetManager.issue({ amount: 1n });
    } catch (err) {
      if (deps.wallet.finalizePendingTxs) {
        try {
          const recovered = await recover();
          if (store.assetId) return { assetId: store.assetId, txid: store.issueTxid!, recovered };
        } catch {
          // keep the original issue error
        }
      }
      throw asHttp(err, "issue failed");
    }
    store.assetId = issued.assetId;
    store.issueTxid = issued.arkTxId;
    await save();
    return { assetId: issued.assetId, txid: issued.arkTxId };
  }

  async function deploy() {
    if (!store.assetId || !store.issueTxid) throw new HttpError(400, "issue first");
    if (store.deployTxid) throw new HttpError(409, "already deployed");
    if (!deps.wallet || !deps.oracleKey) throw new HttpError(400, "ORACLE_KEY is required");
    const script = await bound();
    if (!script) throw new HttpError(400, "ORACLE_KEY is required");
    const coins = await deps.wallet.getVtxos();
    const holding = coins.filter((coin) => !coin.isSpent && coin.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
    if (holding.length !== 1) throw new HttpError(400, "issued coin");
    const coin = holding[0]!;
    const changeScript = ArkAddress.decode(await deps.wallet.getAddress()).pkScript;
    const outputs = genesisOutputs(coin, asset.AssetId.fromString(store.assetId), script.pkScript, changeScript);
    const submitted = await deps.wallet.buildAndSubmitOffchainTx([coin], outputs);
    store.deployTxid = submitted.arkTxid;
    await save();
    return { txid: submitted.arkTxid, address: script.address };
  }

  function keepRecent() {
    store.samples = pruneSamples(store.samples, now());
  }

  async function recordIntent(intent: DiaIntent) {
    if (!adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.assetId) throw new HttpError(409, "not issued");
    let cents: bigint;
    try {
      cents = centsOf(intent.price);
    } catch {
      throw new HttpError(400, "price");
    }
    if (cents > PRICE_MAX) throw new HttpError(400, "price");
    if (!Number.isSafeInteger(intent.time) || intent.time <= 0) throw new HttpError(400, "time");
    if (intent.time > now()) throw new HttpError(400, "future timestamp");
    if (!intentSigned(intent)) throw new HttpError(400, "dia signature");
    keepRecent();
    const raw = intent.price.toString();
    if (store.samples.some((sample) => sample.time === intent.time && sample.raw === raw)) {
      return { ok: true, time: intent.time, price: cents.toString(), duplicate: true };
    }
    store.samples.push({
      price: cents.toString(),
      time: intent.time,
      raw,
      nonce: intent.nonce.toString(),
      intentExpiry: intent.intentExpiry,
      sig: bytesToHex(intent.sig),
    });
    await save();
    return { ok: true, time: intent.time, price: cents.toString() };
  }

  function chooseSample(expiry: number): StoredSample | null {
    keepRecent();
    return pickSample(store.samples, expiry, Number(EXPIRY_LAG));
  }

  /** The first fixing for this expiry. A later write has to reuse that DIA intent. */
  function signedFixing(expiry: number): StoredSample | null {
    const row = store.fixings.find((fixing) => fixing.expiry === expiry && typeof fixing.time === "number" && fixing.raw && fixing.sig && fixing.nonce && typeof fixing.intentExpiry === "number");
    if (!row || typeof row.time !== "number" || !row.raw || !row.sig || !row.nonce || typeof row.intentExpiry !== "number") return null;
    return { price: row.price, time: row.time, raw: row.raw, nonce: row.nonce, intentExpiry: row.intentExpiry, sig: row.sig };
  }

  function pricePage(query: URLSearchParams) {
    keepRecent();
    const from = Number(query.get("from") ?? "0");
    const to = Number(query.get("to") ?? String(now()));
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? "50") || 50));
    const signed = query.get("signed") === "1";
    const rows = store.samples
      .filter((sample) => sample.time >= from && sample.time <= to)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map((sample) => (signed && sample.raw && sample.nonce && typeof sample.intentExpiry === "number" && sample.sig
        ? {
            price: sample.price,
            time: sample.time,
            raw: sample.raw,
            nonce: sample.nonce,
            intentExpiry: sample.intentExpiry,
            sig: sample.sig,
          }
        : { price: sample.price, time: sample.time }));
    return { samples: rows };
  }

  async function publish(body: Record<string, unknown>) {
    exact(body, ["expiry"]);
    if (!deps.oracleKey || !adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.deployTxid || !store.assetId) throw new HttpError(409, "not deployed");
    if (publishing) throw new HttpError(409, "publish in progress");
    publishing = true;
    try {
      const expiry = whole(body.expiry, "expiry");
      if (expiry <= 1800n) throw new HttpError(400, "expiry");
      if (expiry % BEACON_GRID_S !== 0n) throw new HttpError(400, "expiry grid");
      if (!Number.isSafeInteger(Number(expiry))) throw new HttpError(400, "expiry");
      const expiryN = Number(expiry);
      if (BigInt(now()) < expiry + EXPIRY_LAG) throw new HttpError(400, "before expiry time");
      const sample = chooseSample(expiryN);
      const prior = signedFixing(expiryN);
      const chosen = prior ?? sample;
      if (!chosen) throw new HttpError(400, "no sample");
      if (chosen.time < expiryN) throw new HttpError(400, "sample before expiry");
      if (chosen.time > expiryN + Number(EXPIRY_LAG)) throw new HttpError(400, "sample after close");
      if (!chosen.raw || !chosen.sig || !chosen.nonce || typeof chosen.intentExpiry !== "number") throw new HttpError(400, "no sample");
      const raw = BigInt(chosen.raw);
      const cents = centsOf(raw);
      const time = BigInt(chosen.time);
      if (!deps.wallet || !deps.indexer || !deps.emulator) throw new HttpError(400, "indexer required");
      const script = await bound();
      if (!script) throw new HttpError(400, "ORACLE_KEY is required");
      const found = await deps.indexer.getVtxos({ scripts: [bytesToHex(script.pkScript)], spendableOnly: true });
      const coin = found.vtxos.find((vtxo) => vtxo.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
      if (!coin) throw new HttpError(400, "beacon coin");
      const fetched = await deps.indexer.getVirtualTxs([coin.txid]);
      const prev = fetched.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id === coin.txid);
      if (!prev) throw new HttpError(400, "creating tx missing");
      const state = statePacketOf(prev);
      const decoded = decodeState(state);
      if (decoded.slots.some((slot) => slot.expiry === expiry)) throw new HttpError(409, "already a fixing");
      const lastExpiry = decoded.slots[0]?.expiry ?? 0n;
      if (expiry <= lastExpiry) throw new HttpError(409, "expiry order");
      const next = nextState(state, expiry, priceValue(cents, time));
      const assetId = asset.AssetId.fromString(store.assetId);
      const adminSig = schnorr.sign(
        attestDigest({
          domain: DOMAIN,
          id: beaconIdOf(assetId),
          round: decoded.round,
          expiry,
          cents,
          time,
        }),
        deps.oracleKey,
      );
      const built = buildAttest({
        beacon: {
          script: script.script,
          coin: { txid: coin.txid, vout: coin.vout, value: coin.value, prevTx: prev.toBytes(true, true) },
          state,
          id: assetId,
        },
        expiry,
        price: raw,
        time,
        nonce: BigInt(chosen.nonce),
        intentExpiry: BigInt(chosen.intentExpiry),
        sig: hexToBytes(chosen.sig),
        adminSig,
        next,
        checkpoint: deps.wallet.serverUnrollScript,
      });
      const submitted = await submit(built, deps.emulator as EmulatorProvider);
      const stamp = Number(time);
      store.fixings.push({
        expiry: expiryN,
        price: cents.toString(),
        time: stamp,
        raw: raw.toString(),
        nonce: chosen.nonce,
        intentExpiry: chosen.intentExpiry,
        sig: chosen.sig,
        txid: submitted.txid,
      });
      await save();
      return { txid: submitted.txid, expiry: expiryN, price: cents.toString(), time: stamp };
    } finally {
      publishing = false;
    }
  }

  /** Renew the beacon coin in a fresh Arkade batch and immediately reseed its monotonic state. */
  async function renew() {
    if (!deps.oracleKey || !adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.deployTxid || !store.assetId) throw new HttpError(409, "not deployed");
    if (!deps.wallet || !deps.indexer || !deps.emulator || !deps.arkProvider || !deps.sdkNetwork) {
      throw new HttpError(400, "renewal requires arkProvider and sdkNetwork");
    }
    if (publishing) throw new HttpError(409, "publish in progress");
    publishing = true;
    try {
      const script = await bound();
      if (!script) throw new HttpError(400, "ORACLE_KEY is required");
      const assetId = asset.AssetId.fromString(store.assetId);
      const beaconId = beaconIdOf(assetId);
      const found = await deps.indexer.getVtxos({ scripts: [bytesToHex(script.pkScript)], spendableOnly: true });
      const coin = found.vtxos.find((vtxo) => !vtxo.isSpent && vtxo.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
      if (!coin) throw new HttpError(400, "beacon coin");
      const fetched = await deps.indexer.getVirtualTxs([coin.txid]);
      const prev = fetched.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id === coin.txid);
      if (!prev) throw new HttpError(400, "creating tx missing");

      let nextRound: bigint;
      let lastExpiry: bigint;
      let needsReboard = true;
      try {
        const decoded = decodeState(statePacketOf(prev));
        nextRound = decoded.round + 1n;
        lastExpiry = decoded.slots[0]?.expiry ?? 0n;
      } catch {
        // Coin is already freshly reboarded (no STATE packet); recover by reseeding from store history.
        needsReboard = false;
        const maxFixing = store.fixings.reduce((max, row) => (row.expiry > max ? row.expiry : max), 0);
        lastExpiry = BigInt(maxFixing);
        nextRound = BigInt(store.fixings.length + 1);
      }

      let targetCoin = coin;
      let targetPrev = prev;
      let commitmentTxid = "";
      if (needsReboard) {
        if (deps.announcedPositions) {
          const ourTxid = bytesToHex(assetId.txid).toLowerCase();
          const ourGidx = Number(assetId.groupIndex);
          const allowed = deps.allowedPubkey?.toLowerCase();
          const matching = [...deps.announcedPositions()].filter((pos) => (
            pos.beacon_txid.toLowerCase() === ourTxid
            && pos.beacon_gidx === ourGidx
            && (!allowed || pos.writer_pubkey.toLowerCase() === allowed || pos.holder_pubkey.toLowerCase() === allowed)
          ));
          if (matching.length > 0 && await hasLiveVault(matching)) {
            throw new HttpError(409, "live vault open");
          }
        }
        const opSig = schnorr.sign(
          reboardDigest({ domain: DOMAIN, id: beaconId, outpoint: { txid: internalTxid(coin.txid), vout: coin.vout } }),
          deps.oracleKey,
        );
        const reboarded = await reboardBeacon({
          arkProvider: deps.arkProvider,
          emulator: deps.emulator as EmulatorProvider,
          network: deps.sdkNetwork,
          script: script.script,
          address: script.address,
          coin: {
            txid: coin.txid,
            vout: coin.vout,
            value: Number(coin.value),
            script: bytesToHex(script.pkScript),
            prevTx: prev.toBytes(true, true),
            assets: [{ assetId: store.assetId, amount: 1n }],
          },
          id: assetId,
          opSig,
        });
        commitmentTxid = reboarded.commitmentTxid;
        let renewedCoin: HeldCoin | undefined;
        for (let attempt = 0; attempt < 30; attempt++) {
          const poll = await deps.indexer.getVtxos({ scripts: [bytesToHex(script.pkScript)], spendableOnly: true });
          renewedCoin = poll.vtxos.find((vtxo) => !vtxo.isSpent && vtxo.txid !== coin.txid && vtxo.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
          if (renewedCoin) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        if (!renewedCoin) throw new HttpError(500, "renewed beacon coin not indexed");
        const renewedTxs = await deps.indexer.getVirtualTxs([renewedCoin.txid]);
        const renewedPrev = renewedTxs.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id === renewedCoin.txid);
        if (!renewedPrev) throw new HttpError(500, "renewed creating tx missing");
        targetCoin = renewedCoin;
        targetPrev = renewedPrev;
      }

      const reseedBuilt = buildReseed({
        beacon: {
          script: script.script,
          coin: { txid: targetCoin.txid, vout: targetCoin.vout, value: targetCoin.value, prevTx: targetPrev.toBytes(true, true) },
          id: assetId,
        },
        round: nextRound,
        lastExpiry,
        sign: (outpoint) => schnorr.sign(
          reseedDigest({ domain: DOMAIN, id: beaconId, outpoint, round: nextRound, lastExpiry }),
          deps.oracleKey!,
        ),
        checkpoint: deps.wallet.serverUnrollScript,
      });
      const reseeded = await submit(reseedBuilt, deps.emulator as EmulatorProvider);
      return {
        commitmentTxid: commitmentTxid || null,
        reseedTxid: reseeded.txid,
        round: nextRound.toString(),
        lastExpiry: lastExpiry.toString(),
      };
    } finally {
      publishing = false;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsed = new URL(req.url ?? "/", "http://oracle");
    const url = parsed.pathname;
    try {
      if (req.method === "GET" && url === "/") return sendFile(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && url === "/page.js") return sendFile(res, "page.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && url === "/page.css") return sendFile(res, "page.css", "text/css; charset=utf-8");
      if (req.method === "GET" && url === "/api/status") return sendJson(res, 200, await status());
      if (req.method === "GET" && url === "/api/prices") return sendJson(res, 200, pricePage(parsed.searchParams));
      if (req.method === "POST" && (url === "/api/issue" || url === "/api/deploy" || url === "/api/recover" || url === "/api/intent")) {
        requireAdmin(req);
        const body = asRecord(await readBody(req, 4096));
        if (url === "/api/intent") return sendJson(res, 200, await recordIntent(intentRequest(body)));
        exact(body, []);
        if (url === "/api/issue") return sendJson(res, 200, await issue());
        if (url === "/api/recover") return sendJson(res, 200, await recover());
        return sendJson(res, 200, await deploy());
      }
      if (req.method === "POST" && url === "/api/publish") {
        requireAdmin(req);
        return sendJson(res, 200, await publish(asRecord(await readBody(req, 4096))));
      }
      if (req.method === "POST" && url === "/api/renew") {
        requireAdmin(req);
        exact(asRecord(await readBody(req, 4096)), []);
        return sendJson(res, 200, await renew());
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
  const publishedExpiries = new Set<number>();

  async function hasLiveVault(positions: readonly OptionPosition[]): Promise<boolean> {
    if (!deps.indexer || !deps.wallet) return false;
    const minByScript = new Map<string, bigint>();
    for (const pos of positions) {
      const watched = positionFromAnnouncement(pos);
      if (!watched || watched.programId !== vaultProgramId(watched.kind)) continue;
      if (watched.collateral < READ_FEE + DUST_SATS) continue;
      let bound;
      try {
        bound = bindContracts(termsFor(watched, deps.wallet.arkServerPublicKey, deps.emulatorKey, READ_FEE, hrp));
      } catch {
        continue;
      }
      if (bound.vaultAddress !== pos.vault_address) continue;
      const scriptHex = bytesToHex(bound.vaultPkScript);
      const prev = minByScript.get(scriptHex);
      if (prev == null || watched.collateral < prev) minByScript.set(scriptHex, watched.collateral);
    }
    for (const [scriptHex, required] of minByScript) {
      const found = await deps.indexer.getVtxos({ scripts: [scriptHex], spendableOnly: true });
      if ((found.vtxos ?? []).some((coin) => !coin.isSpent && !coin.isSwept && BigInt(coin.value) >= required)) return true;
    }
    return false;
  }

  /** Publish each announced expiry once. No sample skips it. Already a fixing is done. */
  async function publishAnnounced() {
    if ((!deps.announcedPositions && !deps.announcedExpiries) || !store.assetId || !store.deployTxid) return;
    const clock = now();
    const items: { expiry: number; positions?: OptionPosition[] }[] = deps.announcedPositions
      ? duePositionExpiries(deps.announcedPositions(), {
          assetId: store.assetId,
          now: clock,
          done: publishedExpiries,
          lag: Number(EXPIRY_LAG),
          allowedPubkey: deps.allowedPubkey,
        })
      : dueExpiries(deps.announcedExpiries!(), clock, publishedExpiries, Number(EXPIRY_LAG)).map((expiry) => ({ expiry }));
    const SAMPLE_GRACE_S = 120;
    for (const item of items) {
      if (item.positions && !(await hasLiveVault(item.positions))) continue;
      if (!chooseSample(item.expiry)) {
        // Wait for the DIA sample during the grace window rather than leapfrogging to a later close.
        if (clock <= item.expiry + Number(EXPIRY_LAG) + SAMPLE_GRACE_S) break;
        continue;
      }
      try {
        await publish({ expiry: item.expiry });
        publishedExpiries.add(item.expiry);
        deps.onPublishedExpiry?.(item.expiry);
      } catch (err) {
        const message = err instanceof HttpError ? err.message : "";
        if (err instanceof HttpError && err.status === 409 && message === "already a fixing") {
          publishedExpiries.add(item.expiry);
          deps.onPublishedExpiry?.(item.expiry);
          continue;
        }
        if (err instanceof HttpError && err.status === 409 && message === "expiry order") {
          publishedExpiries.add(item.expiry);
          continue;
        }
        if (skippedPublish(message)) {
          if (clock <= item.expiry + Number(EXPIRY_LAG) + SAMPLE_GRACE_S) break;
          continue;
        }
        console.error(`oracle publish ${item.expiry} ${message || "publish failed"}`);
        // Never leapfrog a transiently failed earlier close; monotonic expiry order would lock it out.
        break;
      }
    }
  }

  async function takeSample() {
    if (!deps.pull || !store.assetId) return;
    const intent = await deps.pull();
    if (!intent) return;
    await recordIntent(intent);
  }

  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  const minute = () => {
    track(takeSample().catch((err) => {
      console.error("oracle sample", err instanceof Error ? err.message : "sample failed");
    }));
    track(publishAnnounced().catch((err) => {
      console.error("oracle publish", err instanceof Error ? err.message : "publish failed");
    }));
  };
  const timer = deps.sampleEveryMs && deps.sampleEveryMs > 0 ? setInterval(minute, deps.sampleEveryMs) : undefined;
  if (timer) minute();
  async function ingestIntent(intent: DiaIntent) {
    if (!store.assetId) return;
    await recordIntent(intent);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    publishAnnounced,
    ingestIntent: (intent: DiaIntent) => {
      const job = ingestIntent(intent);
      track(job);
      return job;
    },
    close: async () => {
      if (timer) clearInterval(timer);
      await Promise.all([...pending]);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

async function sendFile(res: http.ServerResponse, name: string, type: string) {
  try {
    send(res, 200, await readFile(path.join(here, name)), type);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") sendJson(res, 404, { error: "not found" });
    else throw err;
  }
}
