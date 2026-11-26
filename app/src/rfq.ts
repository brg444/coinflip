import { generateSecretKey } from "nostr-tools/pure";

import { PAIR, type PredictKind } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../../protocol/hex.ts";
import { payoutRefusal, type RfqQuote, type RfqRefusal, type RfqRequest } from "../../protocol/messages.ts";
import { collectReplies } from "../../protocol/nostr.ts";
import { payoutMultiplier } from "../../protocol/pricing.ts";
import { PINNED_ORACLE_PUBKEY } from "../rfq-config.js";
import { ACTIVE_PROFILE, ACTIVE_Q_MAX, writerBinding } from "./fund.ts";

export function oracleKeyMatches(quoteOraclePk: string, pinnedOraclePk: string | null = PINNED_ORACLE_PUBKEY): boolean {
  const candidate = quoteOraclePk.trim().toLowerCase();
  const expected = pinnedOraclePk?.trim().toLowerCase() || "";
  if (!/^[0-9a-f]{64}$/.test(candidate) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return candidate === expected;
}

export function backupKeyMatches(
  quoteBackupPk: string,
  deskPk: string,
  emulatorKey: Uint8Array,
  pinned: string | null = null,
  network = "mutinynet",
): boolean {
  const candidate = quoteBackupPk.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  if (candidate === deskPk.trim().toLowerCase()) return false;
  const pinnedClean = pinned?.trim().toLowerCase() || "";
  if ((network === "bitcoin" || network === "mainnet") && !pinnedClean) return false;
  const expected = pinnedClean || bytesToHex(xOnly(emulatorKey));
  return candidate === expected;
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
  oraclePkHex: string;
  backupPkHex: string;
  voidAfter: number;
  fallbackDelay: number;
  finalExitDelay: number;
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
  oraclePubkey?: string | null;
  backupPubkey?: string | null;
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
    if (quote.from_amount !== request.amount) continue;
    if (quote.solver_pubkey !== incoming.from || quote.profile.writer_pubkey !== incoming.from) continue;
    if (quote.valid_until <= now || quote.profile.deadline < now + 15) continue;
    if (quote.profile.deadline > Number(input.expiry) - 30) continue;
    if (quote.profile.exit !== Number(ACTIVE_PROFILE.exit)) continue;
    if (quote.profile.void_after !== Number(ACTIVE_PROFILE.voidAfter)) continue;
    if (quote.profile.fallback_delay !== Number(ACTIVE_PROFILE.fallbackDelay)) continue;
    if (quote.profile.final_exit_delay !== Number(ACTIVE_PROFILE.finalExitDelay)) continue;
    if (!oracleKeyMatches(quote.profile.oracle_pubkey, input.oraclePubkey)) continue;
    if (!backupKeyMatches(quote.profile.backup_pubkey, quote.profile.writer_pubkey, profile.emulatorKey, input.backupPubkey ?? null, profile.network)) continue;
    const payout = BigInt(quote.to_amount);
    if (payoutRefusal(payout, input.stake, ACTIVE_Q_MAX)) continue;
    let bound;
    try {
      bound = bindContracts({
        kind: input.kind,
        strike: input.line,
        collateral: payout,
        premium: input.stake,
        expiry: input.expiry,
        deadline: BigInt(quote.profile.deadline),
        exit: ACTIVE_PROFILE.exit,
        writerPk: hexToBytes(quote.profile.writer_pubkey),
        holderPk: profile.signerKey ?? profile.payoutKey,
        holderPayoutKey: profile.signerKey ? undefined : profile.payoutKey,
        oraclePk: hexToBytes(quote.profile.oracle_pubkey),
        backupPk: hexToBytes(quote.profile.backup_pubkey),
        voidAfter: BigInt(quote.profile.void_after),
        fallbackDelay: BigInt(quote.profile.fallback_delay),
        finalExitDelay: BigInt(quote.profile.final_exit_delay),
        serverKey: profile.serverKey,
        emulatorKey: profile.emulatorKey,
        hrp: ACTIVE_PROFILE.hrp,
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
      oraclePkHex: quote.profile.oracle_pubkey,
      backupPkHex: quote.profile.backup_pubkey,
      voidAfter: quote.profile.void_after,
      fallbackDelay: quote.profile.fallback_delay,
      finalExitDelay: quote.profile.final_exit_delay,
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
