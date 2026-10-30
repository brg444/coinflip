import http from "node:http";

import {
  arkade,
  asset,
  ContractManager,
  DefaultVtxo,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import {
  ARK_URL,
  BEACON_READ_FEE,
  DEFAULT_RELAYS,
  EMULATOR_URL,
  EXIT,
  isPredict,
  LOCK_S,
  PAIR,
  PREDICT_EDGE,
  PREDICT_LOCK_S,
  QUOTE_TTL_S,
} from "../protocol/constants.ts";
import { assertServerExit, bindContracts, directPayoutKey, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { intentProgram } from "../protocol/programs.ts";
import {
  isPredictRequest,
  parsePosition,
  payoutRefusal,
  premiumRefusal,
  requestRefusal,
  type OptionPosition,
  type PredictRequestProfile,
  type RfqQuote,
  type RfqRequest,
  type RfqStatus,
} from "../protocol/messages.ts";
import { connectTransport, nostrPubkey, type Incoming } from "../protocol/nostr.ts";
import { deribitMultiplier, deribitPremium, fetchSurface, surfaceStatus } from "../protocol/deribit.ts";
import { predictMultiplier, predictPayout, premiumSats, quotedPremium } from "../protocol/pricing.ts";
import { openSqliteStorage, revision } from "../protocol/sqlite-storage.ts";
import { Book, hasBeacon, openPremium, outlay, pageQuotes, quoteCounts, type QuoteFilter, type QuoteRow } from "./book.ts";
import { countFill, countQuote, emptyHour, hourLine, msUntilNextHour } from "./digest.ts";
import { finalizeDeskSpends } from "./finalize.ts";
import { fillQuote } from "./fill.ts";
import { spotCents } from "./spot.ts";

/**
 * One process: Nostr RFQ, the quote book, and fills from the contract manager.
 *
 *   DESK_KEY        32-byte hex. Nostr pubkey and the option holder key.
 *   BEACON_TXID     required 64-hex display txid of the oracle's identity asset
 *   BEACON_GIDX     optional vout index of that asset. Default 0
 *   RELAYS          comma-separated websocket URLs
 *   ARK_URL         default Mutinynet arkd
 *   EMULATOR_URL    default Mutinynet emulator
 *   DATA_DIR        quote book. Default ./data
 *   PORT            status HTTP. Default 8788
 *   DESK_STRIKE_CAP per-strike collateral cap in sats. Default 1 BTC
 *   DESK_TOTAL_CAP  total collateral cap in sats. Default 5 BTC
 *   DESK_VOL        optional vol override. Default is the Deribit mark.
 *   DESK_EDGE       predict: the desk's share of a fair price. Default 0.05 (1.90× at even odds)
 *   DESK_LOG        set to debug to print each quote. Default is one line per hour.
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
const secret = hexToBytes(deskKeyHex);
if (secret.length !== 32) throw new Error("DESK_KEY must be 32 bytes");

const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8788");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
const relays = (process.env.RELAYS ?? DEFAULT_RELAYS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const caps = {
  perStrike: bigintEnv("DESK_STRIKE_CAP", 100_000_000n),
  total: bigintEnv("DESK_TOTAL_CAP", 500_000_000n),
};
const volOverride = process.env.DESK_VOL?.trim() ? Number(process.env.DESK_VOL) : null;
if (volOverride != null && !(volOverride > 0 && volOverride < 5)) {
  throw new Error("DESK_VOL must be a vol between 0 and 5");
}
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");
const edge = process.env.DESK_EDGE?.trim() ? Number(process.env.DESK_EDGE) : PREDICT_EDGE;
if (!(edge >= 0 && edge < 0.5)) throw new Error("DESK_EDGE must be a share between 0 and 0.5");

const identity = SingleKey.fromHex(deskKeyHex);
const book = await Book.open(dataDir);
const forgotten = book.prune(Math.floor(Date.now() / 1000));
if (forgotten.length) {
  await book.save();
  console.log("dropped", forgotten.length, "finished quotes");
}
let hour = emptyHour();
const storage = await openSqliteStorage(dataDir);
const beaconDisplay = beaconFromEnv();
const indexer = new RestIndexerProvider(arkUrl);
const ark = new RestArkProvider(arkUrl);
if (typeof EventSource === "undefined") {
  throw new Error("Contract events need Node's EventSource. Start the desk with --experimental-eventsource.");
}
// Every intent.register persists a script, and the watcher subscribes to all of them.
// Mutinynet allows 1000 topics. Old quotes are polled, not streamed.
const remembered = await storage.contractRepository.getContracts();
for (const contract of remembered) {
  await storage.contractRepository.deleteContract(contract.script);
}
if (remembered.length) console.log("unwatched", remembered.length, "old intent scripts");
const contractManager = await ContractManager.create({
  indexerProvider: indexer,
  contractRepository: storage.contractRepository,
  walletRepository: storage.walletRepository,
  vtxoSyncMaxAgeMs: 60_000,
});
// The first lookup often dies on a transient EAI_AGAIN. Dokploy only keeps
// the inner "fetch failed" line, so log the whole cause chain, URL included.
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

const network = networkByName((await readArkInfo()).network);
const client = await arkade.Arkade.connect({
  arkade: ark,
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  identity,
  contractManager,
  network,
});
if (!client.emulatorKey) throw new Error("emulator key missing");
await assertServerExit(arkUrl);

const holderPk = await identity.xOnlyPublicKey();
const deskScript: DefaultVtxo.Script = payoutVtxo(holderPk, client.serverKey, EXIT);
const address = deskScript.address(network.hrp, client.serverKey).encode();
const pubkey = nostrPubkey(secret);

let balance = 0n;
let spot: { cents: bigint; sources: string[] } | null = null;
let polling = false;

function beaconFromEnv() {
  const txid = (process.env.BEACON_TXID ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error("BEACON_TXID must be the 64-hex display txid of the identity asset");
  }
  const gidx = (process.env.BEACON_GIDX ?? "0").trim();
  if (!/^\d+$/.test(gidx) || Number(gidx) > 65_535) throw new Error("BEACON_GIDX must be an integer from 0 to 65535");
  return { txid, gidx: Number(gidx) };
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
    holderPayoutKey: row.holderPkScript ? directPayoutKey(row.holderPubkey, row.holderPkScript) : undefined,
    beacon: beaconIdOf(asset.AssetId.create(row.beaconTxid, row.beaconGidx)),
    readFee: BEACON_READ_FEE,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
  };
}

function quoteMessage(row: QuoteRow): RfqQuote {
  const bound = bindContracts(termsFor(row));
  if (isPredict(row.kind)) {
    // The bettor sent the stake as the amount. The desk answers with the payout it locks.
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
        beacon_txid: row.beaconTxid,
        beacon_gidx: row.beaconGidx,
        deadline: row.deadline,
        exit: row.exit,
        intent_address: row.intentAddress,
        vault_address: row.vaultAddress,
      },
    };
  }
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: row.rfqId,
    pair: PAIR,
    from_amount: row.collateral,
    to_amount: row.premium,
    solver_pubkey: row.holderPubkey,
    valid_until: row.validUntil,
    profile: {
      holder_pubkey: row.holderPubkey,
      holder_pk_script: bytesToHex(bound.holderPkScript),
      beacon_txid: row.beaconTxid,
      beacon_gidx: row.beaconGidx,
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

/** Register the quote's intent, then answer. Shared by options and predict. */
async function offer(row: QuoteRow, from: string) {
  if (!book.hold(row, caps, row.createdAt)) {
    await refuse(from, row.rfqId, "exposure");
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

/**
 * Predict: the bettor holds and pays the stake. The desk writes, quotes the
 * multiplier and funds the payout. The lock is short, so the bettor cannot
 * watch most of the window before paying.
 */
async function onPredict(message: RfqRequest & { profile: PredictRequestProfile }, from: string, now: number) {
  let tick;
  try {
    tick = await spotCents();
    spot = tick;
  } catch {
    await refuse(from, message.rfq_id, "spot unavailable");
    return;
  }
  const kind = message.profile.kind;
  let multiplier: number | null;
  if (volOverride != null) {
    multiplier = predictMultiplier({
      kind,
      spotCents: Number(tick.cents),
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
      spotCents: Number(tick.cents),
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
  const bad = payoutRefusal(payout, stake, BEACON_READ_FEE);
  if (bad) {
    await refuse(from, message.rfq_id, bad);
    return;
  }
  if (balance < openPremium(book.list(), now) + payout) await refreshFloat();
  if (balance < openPremium(book.list(), now) + payout) {
    await refuse(from, message.rfq_id, "float short");
    return;
  }
  const row: QuoteRow = {
    rfqId: message.rfq_id,
    collateral: payout.toString(),
    premium: stake.toString(),
    kind,
    strike: String(message.profile.strike),
    expiry: message.profile.expiry,
    deadline: now + PREDICT_LOCK_S,
    validUntil: now + QUOTE_TTL_S,
    exit: Number(EXIT),
    writerPubkey: bytesToHex(holderPk),
    writerPkScript: bytesToHex(deskScript.pkScript),
    holderPubkey: message.profile.holder_pubkey,
    holderPkScript: message.profile.holder_pk_script,
    beaconTxid: beaconDisplay.txid,
    beaconGidx: beaconDisplay.gidx,
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
  await offer(row, from);
}

async function onRequest(message: RfqRequest, from: string) {
  const now = Math.floor(Date.now() / 1000);
  const existing = book.get(message.rfq_id);
  // Only replay open quotes. Expired (register-fail) and filled rows must not
  // block a retry while the old deadline is still in the future.
  if (existing && existing.status === "open" && existing.clientPubkey === from && existing.deadline > now) {
    await transport.publish(from, quoteMessage(existing));
    return;
  }
  const bad = requestRefusal(message, now);
  if (bad) {
    await refuse(from, message.rfq_id, bad);
    return;
  }
  if (isPredictRequest(message.profile)) {
    await onPredict(message as RfqRequest & { profile: PredictRequestProfile }, from, now);
    return;
  }
  const profile = message.profile;
  let tick;
  try {
    tick = await spotCents();
    spot = tick;
  } catch {
    await refuse(from, message.rfq_id, "spot unavailable");
    return;
  }
  let sats: bigint;
  if (volOverride != null) {
    const years = (profile.expiry - now) / (365 * 24 * 60 * 60);
    sats = premiumSats({
      kind: profile.kind,
      spotCents: Number(tick.cents),
      strikeCents: profile.strike,
      years,
      collateralSats: BigInt(message.amount),
      vol: volOverride,
    }).sats;
  } else {
    let points;
    try {
      points = await fetchSurface();
    } catch {
      await refuse(from, message.rfq_id, "deribit unavailable");
      return;
    }
    const priced = deribitPremium({
      kind: profile.kind,
      strikeUsd: profile.strike / 100,
      expiry: profile.expiry,
      now,
      collateralSats: BigInt(message.amount),
      spotUsd: Number(tick.cents) / 100,
      points,
    });
    if (!priced) {
      await refuse(from, message.rfq_id, "deribit unavailable");
      return;
    }
    sats = priced.sats;
  }
  sats = quotedPremium(sats, profile.expiry, now);
  const dust = premiumRefusal(sats, BigInt(message.amount));
  if (dust) {
    await refuse(from, message.rfq_id, dust);
    return;
  }
  if (balance < openPremium(book.list(), now) + sats) await refreshFloat();
  if (balance < openPremium(book.list(), now) + sats) {
    await refuse(from, message.rfq_id, "float short");
    return;
  }
  const deadline = now + LOCK_S;
  const row: QuoteRow = {
    rfqId: message.rfq_id,
    collateral: message.amount,
    premium: sats.toString(),
    kind: profile.kind,
    strike: String(profile.strike),
    expiry: profile.expiry,
    deadline,
    validUntil: now + QUOTE_TTL_S,
    exit: Number(EXIT),
    writerPubkey: profile.writer_pubkey,
    writerPkScript: profile.writer_pk_script,
    holderPubkey: bytesToHex(holderPk),
    beaconTxid: beaconDisplay.txid,
    beaconGidx: beaconDisplay.gidx,
    intentAddress: "",
    vaultAddress: "",
    status: "open",
    createdAt: now,
    clientPubkey: from,
  };
  const bound = bindContracts(termsFor(row));
  if (bytesToHex(bound.writerPkScript) !== profile.writer_pk_script) {
    await refuse(from, message.rfq_id, "writer script");
    return;
  }
  row.intentAddress = bound.intentAddress;
  row.vaultAddress = bound.vaultAddress;
  await offer(row, from);
}

async function onStatus(rfqId: string, from: string) {
  const row = book.get(rfqId);
  const message: RfqStatus = row
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

const transport = connectTransport({ relays, secretKey: secret, onMessage });

function filledPosition(row: QuoteRow): OptionPosition | null {
  if (row.status !== "filled" || !row.fillTxid) return null;
  return parsePosition({
    v: 1,
    type: "option_position",
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
    ...(isPredict(row.kind) ? { holder_pk_script: row.holderPkScript } : {}),
    beacon_txid: row.beaconTxid,
    beacon_gidx: row.beaconGidx,
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

type FloatCoin = { txid: string; vout: number; value: number };

const deskScriptHex = bytesToHex(deskScript.pkScript);
// ponytail: script→quote only. Scan for the reverse; add quote→script if the open book gets large.
const quoteByScript = new Map<string, string>();
const deskCoins = new Map<string, FloatCoin>();
const shortLogged = new Set<string>();
const queued = new Set<string>();
// ponytail: one fill at a time. Per-quote locks if two quotes must settle together.
let filling = false;

function recount() {
  balance = [...deskCoins.values()].reduce((sum, coin) => sum + BigInt(coin.value), 0n);
  if (balance > 0n) shortLogged.clear();
}

/** Finish spends the emulator submitted, then trust the indexer for the float. */
async function refreshFloat() {
  if (!client.indexer) return;
  try {
    const done = await finalizeDeskSpends({ ark, indexer, identity, deskScript });
    const pending = await indexer.getVtxos({ scripts: [deskScriptHex], pendingOnly: true });
    const pendingCount = pending.vtxos?.length ?? 0;
    if (done.length || pendingCount) {
      console.log("finalized", done.join(",") || "-", "pending", pendingCount);
    }
  } catch (err) {
    console.error("finalize", err instanceof Error ? err.message : err);
  }
  try {
    const page = await indexer.getVtxos({ scripts: [deskScriptHex], spendableOnly: true });
    deskCoins.clear();
    for (const coin of page.vtxos ?? []) {
      deskCoins.set(`${coin.txid}:${coin.vout}`, { txid: coin.txid, vout: coin.vout, value: coin.value });
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
            // Keep status filled but drop the txid so housekeeping retries save / recovery.
            const stuck = book.get(row.rfqId);
            if (stuck) delete stuck.fillTxid;
          }
          // A prediction's stake is paid to the desk, not by it.
          if (fresh) countFill(hour, isPredict(row.kind) ? 0n : BigInt(row.premium), BigInt(row.collateral));
          console.log("filled", row.rfqId, outcome.txid ?? "");
          void announceFilled();
          await refreshFloat();
        } else if (outcome.result === "expired") {
          book.mark(row.rfqId, "expired");
          await forgetScript(row.rfqId);
          await book.save();
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
      if (!hasBeacon(row)) {
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
      // Poll unsettled quotes: EventSource can miss a coin; recovery needs another look after a crash.
      queueFill(row.rfqId);
    }
    const finished = book.prune(Math.floor(Date.now() / 1000));
    for (const row of finished) await forgetScript(row.rfqId);
    if (dropped || finished.length) {
      await book.save();
      if (dropped) console.log("dropped", dropped, "quotes with no beacon");
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
    pubkey,
    address,
    balance: balance.toString(),
    beaconTxid: beaconDisplay.txid,
    beaconGidx: beaconDisplay.gidx,
    spotCents: spot ? spot.cents.toString() : null,
    spotSources: spot?.sources ?? [],
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

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = parsed.pathname;
  let status = 200;
  let body: string;
  if (path === "/" || path === "/status") body = statusBody();
  else if (path === "/quotes") {
    const page = quotesBody(parsed.searchParams);
    status = page.status;
    body = page.body;
  } else {
    status = 404;
    body = JSON.stringify({ error: "not found" });
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
});

server.listen(port, () => {
  console.log(`commit ${revision()}`);
  console.log(`desk ${pubkey}`);
  console.log(`address ${address}`);
  console.log(`beacon ${beaconDisplay.txid}:${beaconDisplay.gidx}`);
  console.log(`status http://127.0.0.1:${port}/status`);
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
