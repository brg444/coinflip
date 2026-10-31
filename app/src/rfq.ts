import { generateSecretKey } from "nostr-tools/pure";

import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../../protocol/beacon-id.ts";
import { BEACON_READ_FEE, DUST_SATS, EXIT, PAIR, type PredictKind } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../../protocol/hex.ts";
import { isPredictQuote, payoutRefusal, type RfqQuote, type RfqRefusal, type RfqRequest } from "../../protocol/messages.ts";
import { payoutMultiplier } from "../../protocol/pricing.ts";
import { collectReplies } from "../../protocol/nostr.ts";
import { writerBinding } from "./fund.ts";

export type LiveQuote = {
  name: string;
  pubkey: string;
  sats: bigint;
  usd: number;
  validUntil: number;
  deadline: number;
  exit: number;
  holderPkHex: string;
  beaconTxid: string;
  beaconGidx: number;
  intentAddress: string;
  vaultAddress: string;
};

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isQuote(value: unknown): value is RfqQuote {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "rfq_quote");
}

function isRefusal(value: unknown): value is RfqRefusal {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "rfq_refusal");
}

/**
 * Ask the pinned desks. The deposit address is derived here from the quote's
 * binding fields. A quote whose address does not match is dropped.
 */
export async function requestQuotes(input: {
  relays: string[];
  desks: { name: string; pubkey: string }[];
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  expiry: bigint;
  spotCents: bigint;
  writerAddress: string;
}): Promise<{ quotes: LiveQuote[]; note: string }> {
  const names = new Map(input.desks.map((desk) => [desk.pubkey, desk.name]));
  const profile = await writerBinding(input.writerAddress);
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: randomId(),
    pair: PAIR,
    amount_side: "from",
    amount: input.collateral.toString(),
    profile: {
      kind: input.kind,
      strike: Number(input.strike),
      expiry: Number(input.expiry),
      writer_pubkey: profile.pubkey,
      writer_pk_script: profile.pkScript,
    },
  };
  const secret = generateSecretKey();
  const acceptId = request.rfq_id;
  const ask = () => collectReplies({
    relays: input.relays,
    secretKey: secret,
    recipients: input.desks.map((desk) => desk.pubkey),
    payload: request,
    timeoutMs: 8_000,
    accept: (incoming) => incoming.message.rfq_id === acceptId,
    done: (incoming) => isQuote(incoming.message),
  });
  let replies = await ask();
  if (replies.length === 0) replies = await ask();
  const now = Math.floor(Date.now() / 1000);
  const quotes: LiveQuote[] = [];
  const reasons: string[] = [];
  for (const incoming of replies) {
    if (!names.has(incoming.from)) continue;
    if (isRefusal(incoming.message)) {
      reasons.push(incoming.message.reason);
      continue;
    }
    if (!isQuote(incoming.message)) continue;
    const quote = incoming.message;
    if (isPredictQuote(quote.profile)) continue;
    if (quote.from_amount !== request.amount) continue;
    if (quote.solver_pubkey !== incoming.from || quote.profile.holder_pubkey !== incoming.from) continue;
    if (quote.valid_until <= now || quote.profile.deadline < now + 120) continue;
    if (quote.profile.exit !== Number(EXIT)) continue;
    const premium = BigInt(quote.to_amount);
    if (premium <= DUST_SATS) continue;
    let bound;
    try {
      bound = bindContracts({
        kind: input.kind,
        strike: input.strike,
        collateral: input.collateral,
        premium,
        expiry: input.expiry,
        deadline: BigInt(quote.profile.deadline),
        exit: EXIT,
        writerPk: hexToBytes(profile.pubkey),
        payoutKey: profile.payoutKey,
        holderPk: hexToBytes(quote.profile.holder_pubkey),
        beacon: beaconIdOf(asset.AssetId.create(quote.profile.beacon_txid, quote.profile.beacon_gidx)),
        readFee: BEACON_READ_FEE,
        serverKey: profile.serverKey,
        emulatorKey: profile.emulatorKey,
      });
    } catch {
      continue;
    }
    if (bound.intentAddress !== quote.profile.intent_address) continue;
    if (bound.vaultAddress !== quote.profile.vault_address) continue;
    if (bytesToHex(bound.holderPkScript) !== quote.profile.holder_pk_script) continue;
    const spot = Number(input.spotCents) / 100;
    quotes.push({
      name: names.get(incoming.from) ?? incoming.from.slice(0, 8),
      pubkey: incoming.from,
      sats: premium,
      usd: Number(premium) / 1e8 * spot,
      validUntil: quote.valid_until,
      deadline: quote.profile.deadline,
      exit: quote.profile.exit,
      holderPkHex: quote.profile.holder_pubkey,
      beaconTxid: quote.profile.beacon_txid,
      beaconGidx: quote.profile.beacon_gidx,
      intentAddress: quote.profile.intent_address,
      vaultAddress: quote.profile.vault_address,
    });
  }
  if (quotes.length === 0) {
    return { quotes, note: reasons[0] ? `The desk refused: ${reasons[0]}.` : "The desk did not answer." };
  }
  return { quotes, note: "" };
}

export type PredictQuote = {
  name: string;
  pubkey: string;
  /** Sats the vault pays a winner, before the read fee. */
  payout: bigint;
  multiplier: number;
  validUntil: number;
  deadline: number;
  exit: number;
  deskPkHex: string;
  beaconTxid: string;
  beaconGidx: number;
  intentAddress: string;
  vaultAddress: string;
};

/**
 * Ask the pinned desks to take the other side of a prediction. The page names
 * the stake, the line and the close; the desk answers with the payout. A quote
 * whose addresses differ from the local derivation is dropped, and so is one
 * that leaves too little time to pay or ends after the window closes.
 */
export async function requestPredictQuotes(input: {
  relays: string[];
  desks: { name: string; pubkey: string }[];
  kind: PredictKind;
  line: bigint;
  stake: bigint;
  expiry: bigint;
  holderAddress: string;
}): Promise<{ quotes: PredictQuote[]; note: string }> {
  const names = new Map(input.desks.map((desk) => [desk.pubkey, desk.name]));
  const profile = await writerBinding(input.holderAddress);
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: randomId(),
    pair: PAIR,
    amount_side: "from",
    amount: input.stake.toString(),
    profile: {
      kind: input.kind,
      strike: Number(input.line),
      expiry: Number(input.expiry),
      holder_pubkey: profile.pubkey,
      holder_pk_script: profile.pkScript,
    },
  };
  const secret = generateSecretKey();
  const ask = () => collectReplies({
    relays: input.relays,
    secretKey: secret,
    recipients: input.desks.map((desk) => desk.pubkey),
    payload: request,
    timeoutMs: 8_000,
    accept: (incoming) => incoming.message.rfq_id === request.rfq_id,
    done: (incoming) => isQuote(incoming.message),
  });
  let replies = await ask();
  if (replies.length === 0) replies = await ask();
  const now = Math.floor(Date.now() / 1000);
  const quotes: PredictQuote[] = [];
  const reasons: string[] = [];
  for (const incoming of replies) {
    if (!names.has(incoming.from)) continue;
    if (isRefusal(incoming.message)) {
      reasons.push(incoming.message.reason);
      continue;
    }
    if (!isQuote(incoming.message)) continue;
    const quote = incoming.message;
    if (!isPredictQuote(quote.profile)) continue;
    if (quote.from_amount !== request.amount) continue;
    if (quote.solver_pubkey !== incoming.from || quote.profile.writer_pubkey !== incoming.from) continue;
    if (quote.valid_until <= now || quote.profile.deadline < now + 15) continue;
    if (quote.profile.deadline > Number(input.expiry) - 30) continue;
    if (quote.profile.exit !== Number(EXIT)) continue;
    const payout = BigInt(quote.to_amount);
    if (payoutRefusal(payout, input.stake, BEACON_READ_FEE)) continue;
    let bound;
    try {
      bound = bindContracts({
        kind: input.kind,
        strike: input.line,
        collateral: payout,
        premium: input.stake,
        expiry: input.expiry,
        deadline: BigInt(quote.profile.deadline),
        exit: EXIT,
        writerPk: hexToBytes(quote.profile.writer_pubkey),
        holderPk: profile.payoutKey,
        holderPayoutKey: profile.payoutKey,
        beacon: beaconIdOf(asset.AssetId.create(quote.profile.beacon_txid, quote.profile.beacon_gidx)),
        readFee: BEACON_READ_FEE,
        serverKey: profile.serverKey,
        emulatorKey: profile.emulatorKey,
      });
    } catch {
      continue;
    }
    if (bound.intentAddress !== quote.profile.intent_address) continue;
    if (bound.vaultAddress !== quote.profile.vault_address) continue;
    if (bytesToHex(bound.writerPkScript) !== quote.profile.writer_pk_script) continue;
    quotes.push({
      name: names.get(incoming.from) ?? incoming.from.slice(0, 8),
      pubkey: incoming.from,
      payout,
      multiplier: payoutMultiplier(input.stake, payout),
      validUntil: quote.valid_until,
      deadline: quote.profile.deadline,
      exit: quote.profile.exit,
      deskPkHex: quote.profile.writer_pubkey,
      beaconTxid: quote.profile.beacon_txid,
      beaconGidx: quote.profile.beacon_gidx,
      intentAddress: quote.profile.intent_address,
      vaultAddress: quote.profile.vault_address,
    });
  }
  if (quotes.length === 0) {
    return { quotes, note: reasons[0] ? `The desk refused: ${reasons[0]}.` : "The desk did not answer." };
  }
  quotes.sort((a, b) => (a.payout > b.payout ? -1 : a.payout < b.payout ? 1 : 0));
  return { quotes, note: "" };
}
