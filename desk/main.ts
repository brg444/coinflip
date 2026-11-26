import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import {
  arkade,
  DefaultVtxo,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import predictArtifact from "../contracts/predict_vault.artifact.json" with { type: "json" };
import {
  DEFAULT_RELAYS,
  PAIR,
  PREDICT_EDGE,
  PREDICT_LOCK_S,
  PREDICT_VAULT_PROGRAM_ID,
  QUOTE_TTL_S,
} from "../protocol/constants.ts";
import { assertServerExit, bindContracts, directPayoutKey, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { deribitMultiplier, fetchSurface, predictVol, surfaceStatus } from "../protocol/deribit.ts";
import { Executor, reboardVaultDelegation, reboardVaultTemplate } from "../protocol/executor.ts";
import { bytesToHex, hexToBytes, xOnly } from "../protocol/hex.ts";
import {
  parsePosition,
  payoutRefusal,
  requestRefusal,
  type OptionPosition,
  type RfqQuote,
  type RfqRequest,
  type RfqStatus,
} from "../protocol/messages.ts";
import { assertNetworkMatch, networkProfile } from "../protocol/network.ts";
import { connectTransport, nostrPubkey, type Incoming } from "../protocol/nostr.ts";
import { predictMultiplier, predictPayout } from "../protocol/pricing.ts";
import { intentProgram } from "../protocol/programs.ts";
import { openSqliteStorage, revision } from "../protocol/sqlite-storage.ts";
import { openingSample, WINDOW_LINE_WITHIN_S, windowOpen } from "../protocol/window-line.ts";
import { fetchOraclePrices, fetchOracleStatus, parseOracleKey, parseOracleLatest, serviceOrigin, type OracleLatest } from "../settle/oracle.ts";
import { Book, hasOracle, outlay, pageQuotes, quoteCounts, type QuoteFilter, type QuoteRow } from "./book.ts";
import { countFill, countQuote, emptyHour, hourLine, msUntilNextHour } from "./digest.ts";
import { fillQuote, type PredictFillVerdict } from "./fill.ts";
import { finalizeDeskSpends, pendingOutpoints } from "./finalize.ts";
import { adverseSpotCents, coinOutlives, minCoinExpiry, predictFillAllowed, predictSpot } from "./guards.ts";
import { maintainDeskCoins } from "./maintain.ts";
import { AsyncMutex, openQuoteCapRefusal, reserveQuote, RfqLimiter } from "./rate-limit.ts";
import { spotCents } from "./spot.ts";

/**
 * Predict market-making desk: Nostr RFQ, quote book, and fills from ContractManager.
 *
 *   DESK_KEY        32-byte hex. Nostr pubkey and PredictVault writer key.
 *   ORACLE_URL      oracle origin. Polled for oraclePubkey and latest DIA spot.
 *   ORACLE_PUBKEY   optional 64-hex x-only pubkey pinning the expected oracle key.
 *   RELAYS          comma-separated websocket URLs
 *   ARK_URL         default from NETWORK profile
 *   EMULATOR_URL    default from NETWORK profile
 *   DATA_DIR        quote book + sqlite wallet. Default ./data
 *   PORT            status HTTP. Default 8788
 *   HOST            default 127.0.0.1
 *   DESK_STRIKE_CAP per-strike collateral cap in sats.
 *   DESK_TOTAL_CAP  total collateral cap in sats.
 *   DESK_VOL        optional vol override. Default is Deribit ATM call IV.
 *   DESK_EDGE       desk edge share. Default 0.05 (1.90× at even odds)
 *   DESK_LOG        set to debug to print each quote. Default is one line per hour.
 *   DESK_LINE_MODE  "window" quotes only the window's opening DIA sample; "any" (default) quotes any line near spot.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return BigInt(raw);
}

const deskKeyHex = required("DESK_KEY");
const oracleUrl = serviceOrigin(required("ORACLE_URL"));
const secret = hexToBytes(deskKeyHex);
if (secret.length !== 32) throw new Error("DESK_KEY must be 32 bytes");

const requestedNetwork = process.env.NETWORK?.trim();
const defaults = networkProfile(requestedNetwork);
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8788");
const host = process.env.HOST?.trim() || "127.0.0.1";
const arkUrl = process.env.ARK_URL?.trim() || defaults.arkUrl;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || defaults.emulatorUrl;
const relays = (process.env.RELAYS ?? DEFAULT_RELAYS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const deskAdmin = process.env.DESK_ADMIN?.trim() || process.env.ORACLE_ADMIN?.trim() || "";
let draining = process.env.DESK_DRAIN === "1" || process.env.DESK_DRAIN?.trim().toLowerCase() === "true";
const caps = {
  perStrike: bigintEnv("DESK_STRIKE_CAP", defaults.deskStrikeCap),
  total: bigintEnv("DESK_TOTAL_CAP", defaults.deskTotalCap),
};
const volOverride = process.env.DESK_VOL?.trim() ? Number(process.env.DESK_VOL) : null;
if (volOverride != null && !(volOverride > 0 && volOverride < 5)) {
  throw new Error("DESK_VOL must be a vol between 0 and 5");
}
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");
const edge = process.env.DESK_EDGE?.trim() ? Number(process.env.DESK_EDGE) : PREDICT_EDGE;
if (!(edge >= 0 && edge < 0.5)) throw new Error("DESK_EDGE must be a share between 0 and 0.5");
const lineMode = (process.env.DESK_LINE_MODE?.trim() || "any").toLowerCase();
if (lineMode !== "any" && lineMode !== "window") throw new Error('DESK_LINE_MODE must be "any" or "window"');
const windowLines = new Map<number, bigint>();

/** The line of the window that closes at `expiry`, from the oracle's samples. Null until the oracle has one. */
async function windowLineCents(expiry: number): Promise<bigint | null> {
  const open = windowOpen(expiry);
  const known = windowLines.get(open);
  if (known != null) return known;
  try {
    const samples = await fetchOraclePrices(oracleUrl, open, open + WINDOW_LINE_WITHIN_S, AbortSignal.timeout(8_000));
    const first = openingSample(samples, open);
    if (!first) return null;
    const cents = BigInt(first.price);
    windowLines.set(open, cents);
    for (const key of windowLines.keys()) if (key < open - 3600) windowLines.delete(key);
    return cents;
  } catch {
    return null;
  }
}

const identity = SingleKey.fromHex(deskKeyHex);
const book = await Book.open(dataDir);
const forgotten = book.prune(Math.floor(Date.now() / 1000));
if (forgotten.length) {
  await book.save();
  console.log("dropped", forgotten.length, "finished quotes");
}
let hour = emptyHour();
const storage = await openSqliteStorage(dataDir);
const envOraclePubkey = optionalOraclePubkeyFromEnv();
const indexer = new RestIndexerProvider(arkUrl);
const ark = new RestArkProvider(arkUrl);
if (typeof EventSource === "undefined") {
  throw new Error("Contract events need Node's EventSource. Start the desk with --experimental-eventsource.");
}
// Every intent.register persists a script, and the watcher subscribes to all of them.
// default / boarding / delegate belong to the SDK wallet. Deleting them drops the float it renews.
const walletContracts = new Set(["default", "boarding", "delegate"]);
let unwatched = 0;
let after: string | undefined;
do {
  const page = await storage.contractRepository.getContractsPage(undefined, { limit: 500, after });
  for (const contract of page.items) {
    if (walletContracts.has(contract.type)) continue;
    await storage.contractRepository.deleteContract(contract.script);
    unwatched += 1;
  }
  after = page.nextCursor;
} while (after);
if (unwatched) console.log("unwatched", unwatched, "old intent scripts");

const ARK_INFO_ATTEMPTS = 4;
const ARK_INFO_BACKOFF_MS = 200;

function causeLine(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const detail = current as Error & { code?: unknown; syscall?: unknown; hostname?: unknown; url?: unknown };
    const extra = ["code", "syscall", "hostname"].flatMap((key) => {
      const value = detail[key as "code"];
      return typeof value === "string" && value ? [`${key}=${value}`] : [];
    });
    if (typeof detail.url === "string" && detail.url && !detail.message.includes(detail.url)) {
      extra.push(`url=${detail.url}`);
    }
    parts.push(extra.length ? `${current.name}: ${current.message} ${extra.join(" ")}` : `${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.join("; cause: ");
}

async function readArkInfo() {
  let last: unknown;
  for (let attempt = 1; attempt <= ARK_INFO_ATTEMPTS; attempt++) {
    try {
      return await ark.getInfo();
    } catch (error) {
      last = error;
      console.error(`ark info attempt ${attempt}/${ARK_INFO_ATTEMPTS}: ${causeLine(error)}`);
      if (attempt < ARK_INFO_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, ARK_INFO_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  throw last;
}

const arkInfo = await readArkInfo();
const netProfile = assertNetworkMatch(requestedNetwork, arkInfo.network);
const network = netProfile.network;
const serverMaxVtxo = arkInfo.vtxoMaxAmount;
const qMax = serverMaxVtxo > 0n && serverMaxVtxo < netProfile.qMax ? serverMaxVtxo : netProfile.qMax;
const stakeMax = bigintEnv("DESK_STAKE_MAX", netProfile.stakeMax);
if (stakeMax < netProfile.stakeMin || stakeMax > qMax) {
  throw new Error(`DESK_STAKE_MAX must be between ${netProfile.stakeMin} and ${qMax}`);
}
const quoteLimits = { qMax, stakeMin: netProfile.stakeMin, stakeMax };
const deprecatedSigners = (arkInfo.deprecatedSigners ?? []).map((item) => ({
  pubkey: item.pubkey,
  cutoffDate: item.cutoffDate.toString(),
}));
const wallet = await Wallet.create({
  identity,
  arkProvider: ark,
  indexerProvider: indexer,
  storage: {
    walletRepository: storage.walletRepository,
    contractRepository: storage.contractRepository,
    intentRepository: storage.intentRepository,
  },
});
const contractManager = await wallet.getContractManager();
contractManager.setVtxoSyncMaxAge(60_000);
const client = await arkade.Arkade.connect({
  arkade: ark,
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  identity,
  contractManager,
  network,
});
if (!client.emulatorKey) throw new Error("emulator key missing");
await assertServerExit(arkUrl, netProfile.exit);

const deskPk = await identity.xOnlyPublicKey();
const deskScript: DefaultVtxo.Script = payoutVtxo(deskPk, client.serverKey, netProfile.exit);
const address = deskScript.address(network.hrp, client.serverKey).encode();
if (bytesToHex(wallet.offchainTapscript.pkScript) !== bytesToHex(deskScript.pkScript)) {
  throw new Error("desk payout script is not the SDK wallet address");
}
if (address !== await wallet.getAddress()) {
  throw new Error("desk address is not the SDK wallet address");
}
const pubkey = nostrPubkey(secret);

function backupPubkeyFromEnv(defaultKey: Uint8Array, deskKey: Uint8Array, isMainnet: boolean): string {
  const raw = process.env.BACKUP_EMULATOR_PUBKEY?.trim().toLowerCase();
  const primaryHex = bytesToHex(xOnly(defaultKey));
  if (isMainnet) {
    if (!raw) throw new Error("BACKUP_EMULATOR_PUBKEY is required on Bitcoin mainnet");
    if (raw === primaryHex) throw new Error("BACKUP_EMULATOR_PUBKEY must differ from primary emulator key on Bitcoin mainnet");
  }
  const hex = raw || primaryHex;
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("BACKUP_EMULATOR_PUBKEY must be 64-hex x-only");
  if (hex === bytesToHex(xOnly(deskKey))) throw new Error("BACKUP_EMULATOR_PUBKEY must not match DESK_KEY");
  if (envOraclePubkey && hex === envOraclePubkey) throw new Error("BACKUP_EMULATOR_PUBKEY must not match ORACLE_PUBKEY");
  return hex;
}
const backupPubkeyHex = backupPubkeyFromEnv(client.emulatorKey, deskPk, netProfile.isMainnet);
const executorUrl = process.env.EXECUTOR_URL?.trim() ?? netProfile.executorUrl;
let executorPromise: Promise<Executor | undefined> | null = null;
function deskExecutor(): Promise<Executor | undefined> {
  if (!executorUrl || executorUrl === "none") return Promise.resolve(undefined);
  if (!executorPromise) {
    executorPromise = Executor.connect(executorUrl, { serverKey: client.serverKey, emulatorKey: client.emulatorKey! })
      .catch(() => undefined);
  }
  return executorPromise;
}

async function delegateFilledVault(row: QuoteRow) {
  const exec = await deskExecutor();
  if (!exec) return;
  const bound = bindContracts(termsFor(row));
  const id = await exec.ensureTemplate("reboard_vault", predictArtifact as arkade.ContractArtifact, reboardVaultTemplate);
  if (id) await exec.delegate(reboardVaultDelegation(id, bound));
}

let balance = 0n;
let spot: { cents: bigint; sources: string[] } | null = null;
let polling = false;

function optionalOraclePubkeyFromEnv(): string | null {
  const raw = process.env.ORACLE_PUBKEY?.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error("ORACLE_PUBKEY must be 64-hex x-only");
  return raw;
}

function termsFor(row: QuoteRow): Terms {
  return {
    kind: row.kind,
    strike: BigInt(row.strike),
    collateral: BigInt(row.collateral),
    premium: BigInt(row.premium),
    expiry: BigInt(row.expiry),
    deadline: BigInt(row.deadline),
    exit: BigInt(row.exit),
    writerPk: hexToBytes(row.writerPubkey),
    payoutKey: directPayoutKey(row.writerPubkey, row.writerPkScript),
    holderPk: hexToBytes(row.holderPubkey),
    holderPayoutKey: directPayoutKey(row.holderPubkey, row.holderPkScript),
    oraclePk: hexToBytes(row.oraclePubkey),
    backupPk: hexToBytes(row.backupPubkey),
    voidAfter: BigInt(row.voidAfter),
    fallbackDelay: BigInt(row.fallbackDelay),
    finalExitDelay: BigInt(row.finalExitDelay),
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
    hrp: netProfile.hrp,
  };
}

function quoteMessage(row: QuoteRow): RfqQuote {
  const bound = bindContracts(termsFor(row));
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: row.rfqId,
    pair: PAIR,
    from_amount: row.premium,
    to_amount: row.collateral,
    solver_pubkey: row.writerPubkey,
    valid_until: row.validUntil,
    profile: {
      writer_pubkey: row.writerPubkey,
      writer_pk_script: bytesToHex(bound.writerPkScript),
      oracle_pubkey: row.oraclePubkey,
      backup_pubkey: row.backupPubkey,
      void_after: row.voidAfter,
      fallback_delay: row.fallbackDelay,
      final_exit_delay: row.finalExitDelay,
      deadline: row.deadline,
      exit: row.exit,
      intent_address: row.intentAddress,
      vault_address: row.vaultAddress,
    },
  };
}

async function refuse(to: string, rfqId: string, reason: string) {
  await transport.publish(to, { v: 1, type: "rfq_refusal", rfq_id: rfqId, reason });
}

const holdMutex = new AsyncMutex();

async function offer(row: QuoteRow, from: string, minExpiry: number) {
  const reserved = await reserveQuote({
    mutex: holdMutex,
    book,
    row,
    from,
    now: () => Math.floor(Date.now() / 1000),
    caps,
    draining: () => draining,
    eligibleFloat: () => eligibleFloatBalance(minExpiry),
    refreshFloat,
  });
  if (!reserved.ok) {
    await refuse(from, row.rfqId, reserved.reason);
    return;
  }
  await book.save();
  try {
    await track(row);
  } catch (err) {
    console.error("register", row.rfqId, err instanceof Error ? err.message : err);
    book.mark(row.rfqId, "expired");
    await book.save();
    await refuse(from, row.rfqId, "register");
    return;
  }
  await transport.publish(from, quoteMessage(row));
  countQuote(hour);
  if (process.env.DESK_LOG?.trim() === "debug") {
    console.log("quote", row.rfqId, row.kind, row.premium, row.collateral, row.intentAddress);
  }
}

const rfqLimiter = new RfqLimiter();

async function onRequest(message: RfqRequest, from: string) {
  const now = Math.floor(Date.now() / 1000);
  const existing = book.get(message.rfq_id);
  if (existing && existing.status === "open" && existing.clientPubkey === from && existing.deadline > now) {
    await transport.publish(from, quoteMessage(existing));
    return;
  }
  if (draining) {
    await refuse(from, message.rfq_id, "draining");
    return;
  }
  if (!rfqLimiter.allow(from)) {
    await refuse(from, message.rfq_id, "rate limit");
    return;
  }
  const capRefusal = openQuoteCapRefusal(book.list(), from, now);
  if (capRefusal) {
    await refuse(from, message.rfq_id, capRefusal);
    return;
  }
  const badReq = requestRefusal(message, now, quoteLimits);
  if (badReq) {
    await refuse(from, message.rfq_id, badReq);
    return;
  }
  if (oracleKeyMismatch || !oraclePubkey || oraclePubkey === backupPubkeyHex) {
    await refuse(from, message.rfq_id, oracleKeyMismatch ? "oracle mismatch" : "oracle");
    return;
  }
  await refreshOracleStatus();
  if (oracleKeyMismatch || !oraclePubkey || oraclePubkey === backupPubkeyHex) {
    await refuse(from, message.rfq_id, oracleKeyMismatch ? "oracle mismatch" : "oracle");
    return;
  }
  let tick;
  try {
    tick = await spotCents();
    spot = tick;
  } catch {
    await refuse(from, message.rfq_id, "spot unavailable");
    return;
  }
  const priced = predictSpot({ oracle: oracleSpot, exchangeCents: tick.cents, now });
  if (!priced.ok) {
    await refuse(from, message.rfq_id, priced.reason);
    return;
  }
  if (lineMode === "window") {
    const expected = await windowLineCents(message.profile.expiry);
    if (expected == null) {
      await refuse(from, message.rfq_id, "window line not set");
      return;
    }
    if (BigInt(message.profile.strike) !== expected) {
      await refuse(from, message.rfq_id, "window line");
      return;
    }
  }
  const kind = message.profile.kind;
  const quoteSpot = adverseSpotCents(kind, priced.cents, tick.cents);
  let multiplier: number | null;
  if (volOverride != null) {
    multiplier = predictMultiplier({
      kind,
      spotCents: Number(quoteSpot),
      lineCents: message.profile.strike,
      years: Math.max(message.profile.expiry - now, 1) / (365 * 24 * 60 * 60),
      vol: volOverride,
      edge,
    });
  } else {
    let points;
    try {
      points = await fetchSurface();
    } catch {
      await refuse(from, message.rfq_id, "deribit unavailable");
      return;
    }
    multiplier = deribitMultiplier({
      kind,
      lineCents: message.profile.strike,
      expiry: message.profile.expiry,
      now,
      spotCents: Number(quoteSpot),
      points,
      edge,
    });
  }
  if (multiplier == null) {
    await refuse(from, message.rfq_id, "line");
    return;
  }
  const stake = BigInt(message.amount);
  const payout = predictPayout(stake, multiplier);
  const bad = payoutRefusal(payout, stake, qMax);
  if (bad) {
    await refuse(from, message.rfq_id, bad);
    return;
  }
  const minExpiry = minCoinExpiry(message.profile.expiry);
  const row: QuoteRow = {
    rfqId: message.rfq_id,
    collateral: payout.toString(),
    premium: stake.toString(),
    kind,
    strike: String(message.profile.strike),
    expiry: message.profile.expiry,
    deadline: now + PREDICT_LOCK_S,
    validUntil: now + QUOTE_TTL_S,
    exit: Number(netProfile.exit),
    writerPubkey: bytesToHex(deskPk),
    writerPkScript: bytesToHex(deskScript.pkScript),
    holderPubkey: message.profile.holder_pubkey,
    holderPkScript: message.profile.holder_pk_script,
    oraclePubkey,
    backupPubkey: backupPubkeyHex,
    voidAfter: Number(netProfile.voidAfter),
    fallbackDelay: Number(netProfile.fallbackDelay),
    finalExitDelay: Number(netProfile.finalExitDelay),
    intentAddress: "",
    vaultAddress: "",
    status: "open",
    createdAt: now,
    clientPubkey: from,
  };
  const bound = bindContracts(termsFor(row));
  if (bytesToHex(bound.holderPkScript) !== message.profile.holder_pk_script) {
    await refuse(from, message.rfq_id, "holder script");
    return;
  }
  if (bytesToHex(bound.writerPkScript) !== row.writerPkScript) {
    await refuse(from, message.rfq_id, "desk script");
    return;
  }
  row.intentAddress = bound.intentAddress;
  row.vaultAddress = bound.vaultAddress;
  await offer(row, from, minExpiry);
}

async function onStatus(rfqId: string, from: string) {
  const row = book.get(rfqId);
  const message: RfqStatus = row && row.clientPubkey === from
    ? {
      v: 1,
      type: "rfq_status",
      rfq_id: rfqId,
      status: row.status,
      ...(row.fillTxid ? { txid: row.fillTxid } : {}),
    }
    : { v: 1, type: "rfq_status", rfq_id: rfqId, status: "expired" };
  await transport.publish(from, message);
}

async function onMessage({ from, message }: Incoming) {
  try {
    if (message.type === "rfq_request") await onRequest(message, from);
    else if (message.type === "rfq_status_request") await onStatus(message.rfq_id, from);
  } catch (err) {
    console.error("rfq", err);
  }
}

let oraclePubkey: string | null = envOraclePubkey;
let oracleKeyMismatch = false;
let oracleSpot: OracleLatest | null = null;
let oracleStatusAt = 0;

async function refreshOracleStatus(force = false) {
  if (!force && oraclePubkey && !oracleKeyMismatch && Date.now() - oracleStatusAt < 10_000) return;
  try {
    const body = await fetchOracleStatus(oracleUrl, AbortSignal.timeout(10_000));
    const keyInfo = parseOracleKey(body);
    if (keyInfo) {
      if (envOraclePubkey && envOraclePubkey !== keyInfo.oraclePkHex) {
        if (!oracleKeyMismatch) {
          console.error(`oracle pubkey mismatch: expected ${envOraclePubkey} got ${keyInfo.oraclePkHex}, refusing predict quotes`);
        }
        oracleKeyMismatch = true;
      } else {
        oracleKeyMismatch = false;
        oraclePubkey = keyInfo.oraclePkHex;
      }
    }
    const latest = parseOracleLatest(body);
    if (latest) oracleSpot = latest;
    oracleStatusAt = Date.now();
  } catch {
    // Keep previous reading; housekeeping retries.
  }
}
await refreshOracleStatus(true);
if (!oraclePubkey) {
  console.error("oracle pubkey unknown, predict quotes refused until oracle answers");
}

const transport = connectTransport({ relays, secretKey: secret, onMessage });

function filledPosition(row: QuoteRow): OptionPosition | null {
  if (row.status !== "filled" || !row.fillTxid) return null;
  return parsePosition({
    v: 1,
    type: "option_position",
    program_id: PREDICT_VAULT_PROGRAM_ID,
    rfq_id: row.rfqId,
    pair: PAIR,
    kind: row.kind,
    collateral: row.collateral,
    strike: row.strike,
    expiry: row.expiry,
    exit: row.exit,
    writer_pubkey: row.writerPubkey,
    writer_pk_script: row.writerPkScript,
    holder_pubkey: row.holderPubkey,
    holder_pk_script: row.holderPkScript,
    stake: row.premium,
    oracle_pubkey: row.oraclePubkey,
    backup_pubkey: row.backupPubkey,
    void_after: row.voidAfter,
    fallback_delay: row.fallbackDelay,
    final_exit_delay: row.finalExitDelay,
    vault_address: row.vaultAddress,
    fill_txid: row.fillTxid,
  });
}

const announced = new Set<string>();
let announcing = false;
let announceError = "";

/** The RFQ stays sealed. A filled vault is a public event any settler can read. */
async function announceFilled() {
  if (announcing) return;
  announcing = true;
  try {
    for (const row of book.list()) {
      const position = filledPosition(row);
      if (!position || announced.has(position.rfq_id)) continue;
      await transport.publishPosition(position);
      announced.add(position.rfq_id);
    }
    announceError = "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== announceError) {
      announceError = message;
      console.error("announce", message);
    }
  } finally {
    announcing = false;
  }
}

type FloatCoin = { txid: string; vout: number; value: number; expiresAt?: Date };

const deskScriptHex = bytesToHex(deskScript.pkScript);
const quoteByScript = new Map<string, string>();
const deskCoins = new Map<string, FloatCoin>();
const shortLogged = new Set<string>();
const queued = new Set<string>();
let filling = false;

function recount() {
  balance = [...deskCoins.values()].reduce((sum, coin) => sum + BigInt(coin.value), 0n);
  if (balance > 0n) shortLogged.clear();
}

function eligibleFloatBalance(minExpiryS: number): bigint {
  let sum = 0n;
  for (const coin of deskCoins.values()) {
    if (coinOutlives(coin, minExpiryS)) sum += BigInt(coin.value);
  }
  return sum;
}

/** Finish a submit the wallet never finalized, then recover swept coins and renew the rest. */
async function maintainWallet() {
  try {
    const maintained = await maintainDeskCoins({
      async markPending() {
        const state = (await storage.walletRepository.getWalletState()) ?? {};
        await storage.walletRepository.saveWalletState({
          ...state,
          settings: { ...state.settings, hasPendingTx: true },
        });
      },
      finalizePendingTxs: () => wallet.finalizePendingTxs(),
      refreshCoins: () => contractManager.refreshVtxos({ after: 0 }),
      async recoverVtxos() {
        return (await wallet.getVtxoManager()).recoverVtxos();
      },
      async renewVtxos() {
        return (await wallet.getVtxoManager()).renewVtxos();
      },
    });
    console.log(
      "wallet",
      `finalized=${maintained.finalized.join(",") || "-"}`,
      `pending=${maintained.pending.join(",") || "-"}`,
      `recovered=${maintained.recovered ?? "-"}`,
      `renewed=${maintained.renewed ?? "-"}`,
    );
  } catch (err) {
    console.error("wallet", err instanceof Error ? err.message : err);
  }
}

/** Finish spends the emulator submitted, then trust the indexer for the float. */
async function refreshFloat() {
  if (!client.indexer) return;
  try {
    const done = await finalizeDeskSpends({
      ark,
      indexer,
      identity,
      deskScript,
      reconcileSpent: (outpoints) => contractManager.refreshOutpoints(outpoints),
    });
    const pending = await pendingOutpoints(indexer, deskScript);
    if (done.length || pending.size) {
      console.log("finalized", done.join(",") || "-", "pending", pending.size);
    }
  } catch (err) {
    console.error("finalize", err instanceof Error ? err.message : err);
  }
  try {
    const page = await indexer.getVtxos({ scripts: [deskScriptHex], spendableOnly: true });
    deskCoins.clear();
    for (const coin of page.vtxos ?? []) {
      deskCoins.set(`${coin.txid}:${coin.vout}`, {
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        expiresAt: coin.expiresAt,
      });
    }
    recount();
  } catch (err) {
    console.error("float", err instanceof Error ? err.message : err);
  }
}

function rememberDesk(event: { type: string; vtxos: FloatCoin[] }) {
  if (event.type === "vtxo_received") {
    for (const coin of event.vtxos) deskCoins.set(`${coin.txid}:${coin.vout}`, coin);
  } else if (event.type === "vtxo_spent") {
    for (const coin of event.vtxos) deskCoins.delete(`${coin.txid}:${coin.vout}`);
  }
  recount();
}

function tracked(rfqId: string): boolean {
  for (const id of quoteByScript.values()) if (id === rfqId) return true;
  return false;
}

async function forgetScript(rfqId: string) {
  for (const [script, id] of quoteByScript) {
    if (id !== rfqId) continue;
    quoteByScript.delete(script);
    try {
      await contractManager.deleteContract(script);
    } catch (err) {
      console.error("unwatch", rfqId, err instanceof Error ? err.message : err);
    }
  }
}

async function track(row: QuoteRow) {
  const bound = bindContracts(termsFor(row));
  const intent = client.contract(intentProgram(), bound.intent);
  const script = bytesToHex(intent.pkScript);
  if (quoteByScript.get(script) === row.rfqId) return;
  await intent.register({ label: row.rfqId });
  quoteByScript.set(script, row.rfqId);
}

function queueFill(rfqId: string) {
  queued.add(rfqId);
  void pump();
}

async function checkPredictFill(row: QuoteRow, now: number): Promise<PredictFillVerdict> {
  await refreshOracleStatus(true);
  if (oracleKeyMismatch) return "decline";
  let tick;
  try {
    tick = await spotCents(Date.now(), { fresh: true });
    spot = tick;
  } catch {
    return "retry";
  }
  const priced = predictSpot({ oracle: oracleSpot, exchangeCents: tick.cents, now });
  if (!priced.ok) return priced.reason === "price basis" ? "decline" : "retry";
  const evalSpot = adverseSpotCents(row.kind, priced.cents, tick.cents);
  let vol = volOverride;
  if (vol == null) {
    try {
      vol = predictVol(await fetchSurface(), Number(evalSpot) / 100, now);
    } catch {
      return "retry";
    }
    if (vol == null) return "retry";
  }
  return predictFillAllowed({
    kind: row.kind,
    spotCents: Number(evalSpot),
    lineCents: Number(row.strike),
    expiry: row.expiry,
    now,
    vol,
    stake: BigInt(row.premium),
    payout: BigInt(row.collateral),
  }) ? "allow" : "decline";
}

async function pump() {
  if (filling) return;
  filling = true;
  try {
    while (queued.size) {
      const rfqId = queued.values().next().value;
      if (!rfqId) break;
      queued.delete(rfqId);
      const row = book.get(rfqId);
      if (!row) continue;
      const unsettled = row.status === "open" || (row.status === "filled" && !row.fillTxid);
      if (!unsettled) continue;
      const now = Math.floor(Date.now() / 1000);
      try {
        const outcome = await fillQuote({
          client,
          termsFor,
          deskScript,
          row,
          now,
          float: [...deskCoins.values()],
          ark,
          checkPredict: checkPredictFill,
        });
        if (outcome.result === "filled") {
          const fresh = row.status !== "filled";
          for (const coin of outcome.spent ?? []) deskCoins.delete(`${coin.txid}:${coin.vout}`);
          recount();
          book.mark(row.rfqId, "filled", outcome.txid);
          await forgetScript(row.rfqId);
          try {
            await book.save();
          } catch (err) {
            console.error("book save", row.rfqId, err instanceof Error ? err.message : err);
            const stuck = book.get(row.rfqId);
            if (stuck) delete stuck.fillTxid;
          }
          if (fresh) countFill(hour, 0n, BigInt(row.collateral));
          console.log("filled", row.rfqId, outcome.txid ?? "");
          void delegateFilledVault(row);
          void announceFilled();
          await refreshFloat();
        } else if (outcome.result === "expired" || outcome.result === "declined") {
          book.mark(row.rfqId, "expired");
          await forgetScript(row.rfqId);
          await book.save();
          if (outcome.result === "declined") console.log("declined", row.rfqId, outcome.reason ?? "");
        } else if (outcome.result === "short") {
          if (!shortLogged.has(row.rfqId)) {
            shortLogged.add(row.rfqId);
            console.error("float short", row.rfqId, "have", balance.toString(), "need", outlay(row).toString());
          }
        }
      } catch (err) {
        console.error("fill", row.rfqId, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    filling = false;
    if (queued.size) void pump();
  }
}

async function housekeeping() {
  if (polling) return;
  polling = true;
  try {
    const hadOracle = Boolean(oraclePubkey);
    if (!hadOracle || Date.now() - oracleStatusAt >= 20_000) {
      await refreshOracleStatus(!hadOracle);
      if (!hadOracle && oraclePubkey) {
        console.log(`oracle ${oraclePubkey}, quotes enabled`);
      }
    }
    if (!filling) await refreshFloat();
    try {
      spot = await spotCents();
    } catch (err) {
      console.error("spot", err instanceof Error ? err.message : err);
    }
    let dropped = 0;
    for (const row of book.list()) {
      const unsettled = row.status === "open" || (row.status === "filled" && !row.fillTxid);
      if (!unsettled) continue;
      if (!hasOracle(row)) {
        row.status = "expired";
        await forgetScript(row.rfqId);
        dropped += 1;
        continue;
      }
      if (!tracked(row.rfqId)) {
        try {
          await track(row);
        } catch (err) {
          console.error("register", row.rfqId, err instanceof Error ? err.message : err);
          continue;
        }
      }
      queueFill(row.rfqId);
    }
    const finished = book.prune(Math.floor(Date.now() / 1000));
    for (const row of finished) {
      await forgetScript(row.rfqId);
      announced.delete(row.rfqId);
      shortLogged.delete(row.rfqId);
    }
    while (announced.size > 5_000) {
      const oldest = announced.values().next().value;
      if (oldest === undefined) break;
      announced.delete(oldest);
    }
    if (dropped || finished.length) {
      await book.save();
      if (dropped) console.log("dropped", dropped, "legacy quotes with no oracle key");
      if (finished.length) console.log("dropped", finished.length, "finished quotes");
    }
    await announceFilled();
  } finally {
    polling = false;
  }
}

function queueOpenFills() {
  for (const row of book.list()) {
    if (row.status === "open" || (row.status === "filled" && !row.fillTxid)) queueFill(row.rfqId);
  }
}

contractManager.onContractEvent((event) => {
  if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") return;
  if (event.contractScript === deskScriptHex) {
    rememberDesk(event);
    queueOpenFills();
    return;
  }
  const rfqId = quoteByScript.get(event.contractScript);
  if (rfqId) queueFill(rfqId);
});
await maintainWallet();
await refreshFloat();
await contractManager.watchScript(deskScriptHex, { label: "desk" });

function quoteView(row: QuoteRow) {
  return {
    rfqId: row.rfqId,
    status: row.status,
    kind: row.kind,
    collateral: row.collateral,
    premium: row.premium,
    strike: row.strike,
    expiry: row.expiry,
    deadline: row.deadline,
    intentAddress: row.intentAddress,
    vaultAddress: row.vaultAddress,
    fillTxid: row.fillTxid ?? null,
  };
}

const QUOTE_PAGE = 50;

function statusBody() {
  const now = Math.floor(Date.now() / 1000);
  const page = pageQuotes(book.list(), { filter: "live", now, offset: 0, limit: QUOTE_PAGE });
  return JSON.stringify({
    commit: revision(),
    network: netProfile.id,
    draining,
    exit: Number(netProfile.exit),
    stakeMax: stakeMax.toString(),
    qMax: qMax.toString(),
    deprecatedSigners,
    pubkey,
    address,
    balance: balance.toString(),
    oraclePubkey,
    spotCents: spot ? spot.cents.toString() : null,
    spotSources: spot?.sources ?? [],
    oracleSpotCents: oracleSpot ? oracleSpot.cents.toString() : null,
    oracleSpotAt: oracleSpot?.time ?? null,
    pricing: volOverride != null
      ? { source: "override", vol: volOverride }
      : { source: "deribit", ...surfaceStatus() },
    quoteCounts: quoteCounts(book.list(), now),
    quotes: page.quotes.map(quoteView),
    quotePage: { status: "live", total: page.total, limit: page.limit, offset: page.offset },
  });
}

function quotesBody(params: URLSearchParams): { status: number; body: string } {
  const raw = params.get("status") ?? "live";
  const filter = raw === "live" || raw === "open" || raw === "filled" || raw === "expired" || raw === "all"
    ? raw as QuoteFilter
    : undefined;
  if (!filter) return { status: 400, body: JSON.stringify({ error: "status must be live, open, filled, expired, or all" }) };
  const offset = queryCount(params.get("offset"), 0, 1_000_000);
  const limit = queryCount(params.get("limit"), QUOTE_PAGE, 100);
  const now = Math.floor(Date.now() / 1000);
  const page = pageQuotes(book.list(), { filter, now, offset, limit });
  return {
    status: 200,
    body: JSON.stringify({
      status: filter,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      quotes: page.quotes.map(quoteView),
    }),
  };
}

function queryCount(value: string | null, fallback: number, max: number): number {
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  return Math.min(max, Number(value));
}

function deskAuthorized(header: string | undefined): boolean {
  if (!deskAdmin) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(deskAdmin).digest();
  return timingSafeEqual(left, right);
}

const server = http.createServer((req, res) => {
  let parsed: URL;
  try {
    parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "bad request" }));
    return;
  }
  const path = parsed.pathname;
  let status = 200;
  let body: string;
  if (req.method === "POST" && path === "/drain") {
    if (!deskAuthorized(req.headers.authorization)) {
      status = deskAdmin ? 401 : 404;
      body = JSON.stringify({ error: deskAdmin ? "unauthorized" : "disabled" });
    } else {
      const mode = parsed.searchParams.get("enabled");
      draining = mode == null ? true : mode !== "0" && mode !== "false";
      console.log(`desk drain ${draining ? "enabled" : "disabled"}`);
      body = JSON.stringify({ draining });
    }
  } else if (path === "/" || path === "/status") body = statusBody();
  else if (path === "/quotes") {
    const page = quotesBody(parsed.searchParams);
    status = page.status;
    body = page.body;
  } else {
    status = 404;
    body = JSON.stringify({ error: "not found" });
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
});

server.listen(port, host, () => {
  console.log(`commit ${revision()}`);
  console.log(`desk ${pubkey}`);
  console.log(`address ${address}`);
  if (oraclePubkey) console.log(`oracle ${oraclePubkey}`);
  console.log(`status http://${host}:${port}/status`);
});

const timer = setInterval(() => {
  void housekeeping();
}, 2_000);
void housekeeping();

let hourEvery: ReturnType<typeof setInterval> | undefined;
function logHour() {
  console.log(hourLine(hour));
  hour = emptyHour();
}
const hourTimer = setTimeout(() => {
  logHour();
  hourEvery = setInterval(logHour, 60 * 60 * 1000);
}, msUntilNextHour());

function shutdown() {
  clearTimeout(hourTimer);
  if (hourEvery) clearInterval(hourEvery);
  if (hour.quotes || hour.filled) console.log(hourLine(hour));
  clearInterval(timer);
  contractManager.dispose();
  transport.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
