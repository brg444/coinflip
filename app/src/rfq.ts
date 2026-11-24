import { generateSecretKey } from "nostr-tools/pure";

import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../../protocol/beacon-id.ts";
import { BEACON_READ_FEE, EXIT, PAIR, type PredictKind } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../../protocol/hex.ts";
import { isPredictQuote, payoutRefusal, type RfqQuote, type RfqRefusal, type RfqRequest } from "../../protocol/messages.ts";
import { payoutMultiplier } from "../../protocol/pricing.ts";
import { collectReplies } from "../../protocol/nostr.ts";
import { parseOracleBeacon } from "../../settle/oracle.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { writerBinding } from "./fund.ts";

export function quoteMatchesBeacon(beaconTxid: string, beaconGidx: number, status: unknown = LIVE_BEACON_STATUS): boolean {
  return parseOracleBeacon(status, beaconTxid, beaconGidx).ok;
}

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

export type PredictQuote = {
  name: string;
  pubkey: string;
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

export async function requestPredictQuotes(input: {
  relays: string[];
  desks: { name: string; pubkey: string }[];
  kind: PredictKind;
  line: bigint;
  stake: bigint;
  expiry: bigint;
  holderAddress: string;
  holderPubkey?: string;
}): Promise<{ quotes: PredictQuote[]; note: string }> {
  const names = new Map(input.desks.map((desk) => [desk.pubkey, desk.name]));
  const profile = await writerBinding(input.holderAddress, input.holderPubkey);
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
    if (!quoteMatchesBeacon(quote.profile.beacon_txid, quote.profile.beacon_gidx)) continue;
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
        holderPk: profile.signerKey ?? profile.payoutKey,
        holderPayoutKey: profile.signerKey ? undefined : profile.payoutKey,
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
