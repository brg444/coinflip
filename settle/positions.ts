import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import { isPredict, PREDICT_READ_FEE, vaultProgramId, type Kind } from "../protocol/constants.ts";
import { directPayoutKey, type Terms } from "../protocol/contracts.ts";
import { hexToBytes } from "../protocol/hex.ts";
import { parsePosition, type OptionPosition } from "../protocol/messages.ts";

/**
 * A filled vault announced on Nostr. The settler rebuilds the contract from
 * these fields. It does not read a desk book or a desk URL.
 */
export type WatchPosition = {
  id: string;
  rfqId: string;
  kind: Kind;
  collateral: bigint;
  strike: bigint;
  expiry: number;
  exit: bigint;
  writerPk: Uint8Array;
  holderPk: Uint8Array;
  programId: string;
  payoutKey?: Uint8Array;
  /** Predict: the bettor's address key, which the payout pays. */
  holderPayoutKey?: Uint8Array;
  stake?: bigint;
  oraclePk?: Uint8Array;
  oraclePkHex?: string;
  backupPk?: Uint8Array;
  voidAfter?: bigint;
  fallbackDelay?: bigint;
  finalExitDelay?: bigint;
  beaconTxid?: string;
  beaconGidx?: number;
  vaultAddress: string;
  fillTxid?: string;
};

/**
 * Vaults handed to the process directly. Accepts one position, an array, or
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
    holderPayoutKey: row.holder_pk_script ? directPayoutKey(row.holder_pubkey, row.holder_pk_script) : undefined,
    ...(row.stake ? { stake: BigInt(row.stake) } : {}),
    ...(row.oracle_pubkey ? { oraclePk: hexToBytes(row.oracle_pubkey), oraclePkHex: row.oracle_pubkey } : {}),
    ...(row.backup_pubkey ? { backupPk: hexToBytes(row.backup_pubkey) } : {}),
    ...(row.void_after != null ? { voidAfter: BigInt(row.void_after) } : {}),
    ...(row.fallback_delay != null ? { fallbackDelay: BigInt(row.fallback_delay) } : {}),
    ...(row.final_exit_delay != null ? { finalExitDelay: BigInt(row.final_exit_delay) } : {}),
    ...(row.beacon_txid ? { beaconTxid: row.beacon_txid, beaconGidx: row.beacon_gidx ?? 0 } : {}),
    vaultAddress: row.vault_address,
    fillTxid: row.fill_txid,
  };
}

export function settlementPositions(rows: readonly OptionPosition[]): WatchPosition[] {
  const positions: WatchPosition[] = [];
  for (const row of rows) {
    const position = positionFromAnnouncement(row);
    if (!position || position.programId !== vaultProgramId(position.kind)) continue;
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

const PUBLISH_EVERY_MS = 60_000;

export function publishReady(lastAt: number, nowMs: number, every = PUBLISH_EVERY_MS): boolean {
  return nowMs - lastAt >= every;
}

/**
 * `published` is a new fixing. `fixed` is 409 "already a fixing": the expiry
 * is already on the beacon. The caller still has to read the slot and refuse
 * it when it is not the sample the oracle would have chosen. Anything else,
 * including "no sample", failed.
 */
export function publishOutcome(status: number, error?: string): "published" | "fixed" | "failed" {
  if (status >= 200 && status < 300) return "published";
  if (status === 409 && error === "already a fixing") return "fixed";
  return "failed";
}

const PERMANENT_MISSING = new Set(["no sample", "sample before expiry", "sample after close", "expiry grid"]);

/**
 * Because `AttestationBeacon` requires strictly increasing close times, the settler must not
 * jump ahead to a newer close after a transient publish failure on an older live close.
 */
export function canAdvancePastFailedPublish(input: {
  status: number;
  error?: string;
  expiry: number;
  lag: number;
  now: number;
  graceS?: number;
}): boolean {
  if (input.status === 409 && input.error === "expiry order") return true;
  if (input.status === 400 && input.error && PERMANENT_MISSING.has(input.error)) {
    return input.now > input.expiry + input.lag + (input.graceS ?? 120);
  }
  return false;
}

export function termsFor(position: WatchPosition, serverKey: Uint8Array, emulatorKey: Uint8Array, readFee = 0n, hrp?: string): Terms {
  const predict = isPredict(position.kind);
  return {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: position.stake ?? 0n,
    expiry: BigInt(position.expiry),
    deadline: BigInt(position.expiry),
    exit: position.exit,
    writerPk: position.writerPk,
    payoutKey: position.payoutKey,
    holderPk: position.holderPk,
    holderPayoutKey: position.holderPayoutKey,
    ...(predict
      ? {
          oraclePk: position.oraclePk,
          readFee: PREDICT_READ_FEE,
        }
      : {
          beacon: beaconIdOf(asset.AssetId.create(position.beaconTxid!, position.beaconGidx ?? 0)),
          readFee,
        }),
    serverKey,
    emulatorKey,
    backupPk: position.backupPk,
    voidAfter: position.voidAfter,
    fallbackDelay: position.fallbackDelay,
    finalExitDelay: position.finalExitDelay,
    ...(hrp ? { hrp } : {}),
  };
}
