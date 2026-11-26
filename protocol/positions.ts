import { PREDICT_VAULT_PROGRAM_ID, type PredictKind } from "./constants.ts";
import { directPayoutKey, type Terms } from "./contracts.ts";
import { hexToBytes } from "./hex.ts";
import { parsePosition, type OptionPosition } from "./messages.ts";

/**
 * A filled PredictVault announced publicly. Any permissionless settler or
 * recovery script rebuilds the exact contract from these fields without calling a desk.
 */
export type WatchPosition = {
  id: string;
  rfqId: string;
  kind: PredictKind;
  collateral: bigint;
  strike: bigint;
  expiry: number;
  exit: bigint;
  writerPk: Uint8Array;
  holderPk: Uint8Array;
  programId: string;
  payoutKey?: Uint8Array;
  /** The bettor's address key, which the payout pays. */
  holderPayoutKey?: Uint8Array;
  stake: bigint;
  oraclePk: Uint8Array;
  oraclePkHex: string;
  backupPk: Uint8Array;
  voidAfter: bigint;
  fallbackDelay: bigint;
  finalExitDelay: bigint;
  vaultAddress: string;
  fillTxid?: string;
};

/**
 * Vaults handed to a settler directly. Accepts one position, an array, or
 * `{ positions: [...] }`. Rows that are not a filled-vault record are skipped.
 */
export function manualPositions(body: unknown): OptionPosition[] {
  let rows: unknown[] = [];
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === "object") {
    const record = body as { positions?: unknown; type?: unknown };
    if (Array.isArray(record.positions)) rows = record.positions;
    else if (record.type === "option_position") rows = [body];
  }
  const positions: OptionPosition[] = [];
  for (const row of rows) {
    const position = parsePosition(row);
    if (position) positions.push(position);
  }
  return positions;
}

/** One public position event. Incomplete or sealed RFQ payloads are skipped. */
export function positionFromAnnouncement(body: unknown): WatchPosition | null {
  const row = parsePosition(body);
  if (!row) return null;
  return {
    id: row.rfq_id,
    rfqId: row.rfq_id,
    kind: row.kind,
    collateral: BigInt(row.collateral),
    strike: BigInt(row.strike),
    expiry: row.expiry,
    exit: BigInt(row.exit),
    writerPk: hexToBytes(row.writer_pubkey),
    holderPk: hexToBytes(row.holder_pubkey),
    programId: row.program_id,
    payoutKey: directPayoutKey(row.writer_pubkey, row.writer_pk_script),
    holderPayoutKey: directPayoutKey(row.holder_pubkey, row.holder_pk_script),
    stake: BigInt(row.stake),
    oraclePk: hexToBytes(row.oracle_pubkey),
    oraclePkHex: row.oracle_pubkey,
    backupPk: hexToBytes(row.backup_pubkey),
    voidAfter: BigInt(row.void_after),
    fallbackDelay: BigInt(row.fallback_delay),
    finalExitDelay: BigInt(row.final_exit_delay),
    vaultAddress: row.vault_address,
    fillTxid: row.fill_txid,
  };
}

export function settlementPositions(rows: readonly OptionPosition[]): WatchPosition[] {
  const positions: WatchPosition[] = [];
  for (const row of rows) {
    const position = positionFromAnnouncement(row);
    if (!position || position.programId !== PREDICT_VAULT_PROGRAM_ID) continue;
    positions.push(position);
  }
  return positions;
}

/** Filled vaults whose expiry is at least `lag` seconds ago. Oldest first. */
export function duePositions<T extends { id: string; expiry: number }>(
  rows: readonly T[],
  now: number,
  done: ReadonlySet<string>,
  lag = 0,
): T[] {
  return rows
    .filter((row) => row.expiry + lag <= now && !done.has(row.id))
    .sort((a, b) => a.expiry - b.expiry || a.id.localeCompare(b.id));
}

export function termsFor(position: WatchPosition, serverKey: Uint8Array, emulatorKey: Uint8Array, hrp?: string): Terms {
  return {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: position.stake,
    expiry: BigInt(position.expiry),
    deadline: BigInt(position.expiry),
    exit: position.exit,
    writerPk: position.writerPk,
    payoutKey: position.payoutKey,
    holderPk: position.holderPk,
    holderPayoutKey: position.holderPayoutKey,
    oraclePk: position.oraclePk,
    serverKey,
    emulatorKey,
    backupPk: position.backupPk,
    voidAfter: position.voidAfter,
    fallbackDelay: position.fallbackDelay,
    finalExitDelay: position.finalExitDelay,
    ...(hrp ? { hrp } : {}),
  };
}
