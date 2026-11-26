import {
  DUST_SATS,
  PAIR,
  PREDICT_GRID_S,
  PREDICT_LOCK_S,
  PREDICT_MAX_AHEAD_S,
  PREDICT_MIN_LEFT_S,
  PREDICT_VAULT_PROGRAM_ID,
  PRICE_MAX,
  Q_MAX,
  STAKE_MAX,
  STAKE_MIN,
  type PredictKind,
} from "./constants.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]{0,15}$/;
const SCRIPT = /^51[0-9a-f]{66}$/;

/** Predict request: the bettor holds. `amount` is the stake; `strike` is the line; `expiry` is the close. */
export type PredictRequestProfile = {
  kind: PredictKind;
  strike: number;
  expiry: number;
  holder_pubkey: string;
  holder_pk_script: string;
};

export type RequestProfile = PredictRequestProfile;

/** Predict quote: the desk is the writer and locks `to_amount` (the full payout). */
export type PredictQuoteProfile = {
  writer_pubkey: string;
  writer_pk_script: string;
  /** X-only pubkey of the oracle co-signing canonical fixings for PredictVault.settle. */
  oracle_pubkey: string;
  backup_pubkey: string;
  void_after: number;
  fallback_delay: number;
  final_exit_delay: number;
  deadline: number;
  exit: number;
  intent_address: string;
  vault_address: string;
};

export type QuoteProfile = PredictQuoteProfile;

export type RfqRequest = {
  v: 1;
  type: "rfq_request";
  rfq_id: string;
  pair: typeof PAIR;
  amount_side: "from";
  amount: string;
  profile: PredictRequestProfile;
};

export type RfqQuote = {
  v: 1;
  type: "rfq_quote";
  rfq_id: string;
  pair: typeof PAIR;
  from_amount: string;
  to_amount: string;
  solver_pubkey: string;
  valid_until: number;
  profile: PredictQuoteProfile;
};

export type RfqRefusal = {
  v: 1;
  type: "rfq_refusal";
  rfq_id: string;
  reason: string;
};

export type RfqStatusRequest = {
  v: 1;
  type: "rfq_status_request";
  rfq_id: string;
};

export type RfqStatus = {
  v: 1;
  type: "rfq_status";
  rfq_id: string;
  status: "open" | "filled" | "expired";
  txid?: string;
};

/** A filled PredictVault, published in the clear so any settler can settle it. */
export type OptionPosition = {
  v: 1;
  type: "option_position";
  program_id: string;
  rfq_id: string;
  pair: typeof PAIR;
  kind: PredictKind;
  collateral: string;
  strike: string;
  expiry: number;
  exit: number;
  writer_pubkey: string;
  writer_pk_script: string;
  holder_pubkey: string;
  holder_pk_script: string;
  stake: string;
  oracle_pubkey: string;
  backup_pubkey: string;
  void_after: number;
  fallback_delay: number;
  final_exit_delay: number;
  vault_address: string;
  fill_txid: string;
};

export type Wire = RfqRequest | RfqQuote | RfqRefusal | RfqStatusRequest | RfqStatus;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function amount(value: unknown): value is string {
  return typeof value === "string" && AMOUNT.test(value);
}

function int(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function script(value: unknown): value is string {
  return typeof value === "string" && SCRIPT.test(value);
}

function address(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 120 && /^[a-z0-9]+$/.test(value);
}

export function parseWire(value: unknown): Wire | null {
  const body = record(value);
  if (!body || body.v !== 1 || typeof body.type !== "string") return null;
  if (body.type === "rfq_request") return parseRequest(body);
  if (body.type === "rfq_quote") return parseQuote(body);
  if (body.type === "rfq_refusal") return parseRefusal(body);
  if (body.type === "rfq_status_request") return parseStatusRequest(body);
  if (body.type === "rfq_status") return parseStatus(body);
  return null;
}

function parseRequest(body: Record<string, unknown>): RfqRequest | null {
  const profile = record(body.profile);
  if (!profile) return null;
  if (!hex64(body.rfq_id) || body.pair !== PAIR || body.amount_side !== "from" || !amount(body.amount)) return null;
  if (profile.kind !== 2 && profile.kind !== 3) return null;
  if (!int(profile.strike, Number(PRICE_MAX)) || profile.strike <= 0) return null;
  if (!int(profile.expiry, 4_000_000_000) || profile.expiry <= 1800) return null;
  if (!hex64(profile.holder_pubkey) || !script(profile.holder_pk_script)) return null;
  return {
    v: 1,
    type: "rfq_request",
    rfq_id: body.rfq_id,
    pair: PAIR,
    amount_side: "from",
    amount: body.amount,
    profile: {
      kind: profile.kind,
      strike: profile.strike,
      expiry: profile.expiry,
      holder_pubkey: profile.holder_pubkey,
      holder_pk_script: profile.holder_pk_script,
    },
  };
}

function bip68Delay(value: unknown, min: number): value is number {
  return int(value, 0xffff * 512) && value >= min && value > 0 && value % 512 === 0;
}

function parseQuote(body: Record<string, unknown>): RfqQuote | null {
  const profile = record(body.profile);
  if (!profile) return null;
  if (!hex64(body.rfq_id) || body.pair !== PAIR || !amount(body.from_amount) || !amount(body.to_amount)) return null;
  if (!hex64(body.solver_pubkey) || !int(body.valid_until, 4_000_000_000)) return null;
  if (!int(profile.deadline, 4_000_000_000) || !bip68Delay(profile.exit, 512)) return null;
  if (!address(profile.intent_address) || !address(profile.vault_address)) return null;
  if (!hex64(profile.writer_pubkey) || !script(profile.writer_pk_script)) return null;
  if (!hex64(profile.oracle_pubkey)) return null;
  if (!hex64(profile.backup_pubkey) || profile.backup_pubkey === profile.writer_pubkey) return null;
  if (!int(profile.void_after, 30 * 86_400) || profile.void_after <= 0) return null;
  if (!bip68Delay(profile.fallback_delay, profile.exit)) return null;
  if (!bip68Delay(profile.final_exit_delay, profile.fallback_delay + 512)) return null;
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: body.rfq_id,
    pair: PAIR,
    from_amount: body.from_amount,
    to_amount: body.to_amount,
    solver_pubkey: body.solver_pubkey,
    valid_until: body.valid_until,
    profile: {
      writer_pubkey: profile.writer_pubkey,
      writer_pk_script: profile.writer_pk_script,
      oracle_pubkey: profile.oracle_pubkey,
      backup_pubkey: profile.backup_pubkey,
      void_after: profile.void_after,
      fallback_delay: profile.fallback_delay,
      final_exit_delay: profile.final_exit_delay,
      deadline: profile.deadline,
      exit: profile.exit,
      intent_address: profile.intent_address,
      vault_address: profile.vault_address,
    },
  };
}

function parseRefusal(body: Record<string, unknown>): RfqRefusal | null {
  if (!hex64(body.rfq_id) || typeof body.reason !== "string" || body.reason.length === 0 || body.reason.length > 160) {
    return null;
  }
  return { v: 1, type: "rfq_refusal", rfq_id: body.rfq_id, reason: body.reason };
}

function parseStatusRequest(body: Record<string, unknown>): RfqStatusRequest | null {
  if (!hex64(body.rfq_id)) return null;
  return { v: 1, type: "rfq_status_request", rfq_id: body.rfq_id };
}

const PROGRAM_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function readProgramId(value: unknown): string | null {
  if (value === undefined) return PREDICT_VAULT_PROGRAM_ID;
  if (typeof value === "string" && PROGRAM_ID.test(value)) return value;
  return null;
}

export function parsePosition(value: unknown): OptionPosition | null {
  const body = record(value);
  if (!body || body.v !== 1 || body.type !== "option_position" || body.pair !== PAIR) return null;
  if (!hex64(body.rfq_id) || (body.kind !== 2 && body.kind !== 3)) return null;
  const program_id = readProgramId(body.program_id);
  if (!program_id) return null;
  if (!script(body.holder_pk_script)) return null;
  if (!amount(body.collateral) || !amount(body.strike)) return null;
  if (!int(body.expiry, 4_000_000_000) || !int(body.exit, 4_000_000_000)) return null;
  if (!hex64(body.writer_pubkey) || !script(body.writer_pk_script)) return null;
  if (!hex64(body.holder_pubkey)) return null;
  if (!address(body.vault_address) || !hex64(body.fill_txid)) return null;
  if (!amount(body.stake) || BigInt(body.stake) <= DUST_SATS) return null;
  if (!hex64(body.oracle_pubkey)) return null;
  if (!hex64(body.backup_pubkey) || body.backup_pubkey.toLowerCase() === body.writer_pubkey.toLowerCase()) return null;
  if (!int(body.void_after, 30 * 86_400) || body.void_after <= 0) return null;
  if (!bip68Delay(body.fallback_delay, body.exit)) return null;
  if (!bip68Delay(body.final_exit_delay, body.fallback_delay + 512)) return null;
  return {
    v: 1,
    type: "option_position",
    program_id,
    rfq_id: body.rfq_id.toLowerCase(),
    pair: PAIR,
    kind: body.kind,
    collateral: body.collateral,
    strike: body.strike,
    expiry: body.expiry,
    exit: body.exit,
    writer_pubkey: body.writer_pubkey.toLowerCase(),
    writer_pk_script: body.writer_pk_script.toLowerCase(),
    holder_pubkey: body.holder_pubkey.toLowerCase(),
    holder_pk_script: body.holder_pk_script.toLowerCase(),
    stake: body.stake,
    oracle_pubkey: body.oracle_pubkey.toLowerCase(),
    backup_pubkey: body.backup_pubkey.toLowerCase(),
    void_after: body.void_after,
    fallback_delay: body.fallback_delay,
    final_exit_delay: body.final_exit_delay,
    vault_address: body.vault_address,
    fill_txid: body.fill_txid.toLowerCase(),
  };
}

function parseStatus(body: Record<string, unknown>): RfqStatus | null {
  if (!hex64(body.rfq_id)) return null;
  if (body.status !== "open" && body.status !== "filled" && body.status !== "expired") return null;
  if (body.txid !== undefined && !hex64(body.txid)) return null;
  return {
    v: 1,
    type: "rfq_status",
    rfq_id: body.rfq_id,
    status: body.status,
    ...(body.txid ? { txid: body.txid } : {}),
  };
}

/** `PredictVault` accepts samples with timestamp in `[expiry, expiry + 60]`. */
export const VAULT_EXPIRY_LAG = 60n;

export type QuoteLimits = {
  qMax?: bigint;
  stakeMin?: bigint;
  stakeMax?: bigint;
};

/** Why a parsed request is not quotable. Empty string means the desk may price it. */
export function requestRefusal(message: RfqRequest, now: number, limits?: QuoteLimits): string {
  return predictRefusal(message.profile.expiry, BigInt(message.amount), now, limits);
}

/**
 * A predict close is on the 5-minute grid, far enough out that the stake can
 * arrive and the window still has a minute to run, and at most an hour away.
 */
export function predictRefusal(expiry: number, stake: bigint, now: number, limits?: QuoteLimits): string {
  const stakeMin = limits?.stakeMin ?? STAKE_MIN;
  const stakeMax = limits?.stakeMax ?? STAKE_MAX;
  if (stake < stakeMin || stake > stakeMax) return "stake";
  if (expiry % PREDICT_GRID_S !== 0) return "expiry";
  if (expiry < now + PREDICT_LOCK_S + PREDICT_MIN_LEFT_S) return "expiry";
  if (expiry > now + PREDICT_MAX_AHEAD_S) return "expiry";
  return "";
}

/** A payout the vault can hold that still strictly beats the stake. */
export function payoutRefusal(payout: bigint, stake: bigint, qMax: bigint = Q_MAX): string {
  if (payout > qMax) return "payout";
  if (payout <= stake) return "payout";
  return "";
}
