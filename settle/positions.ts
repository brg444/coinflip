import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import type { Kind } from "../protocol/constants.ts";
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
  payoutKey?: Uint8Array;
  /** Predict: the bettor's address key, which the payout pays. */
  holderPayoutKey?: Uint8Array;
  beaconTxid: string;
  beaconGidx: number;
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
    payoutKey: directPayoutKey(row.writer_pubkey, row.writer_pk_script),
    holderPayoutKey: row.holder_pk_script ? directPayoutKey(row.holder_pubkey, row.holder_pk_script) : undefined,
    beaconTxid: row.beacon_txid,
    beaconGidx: row.beacon_gidx,
    vaultAddress: row.vault_address,
    fillTxid: row.fill_txid,
  };
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

/** How often a due vault asks the oracle to publish its own expiry. */
export const PUBLISH_EVERY_MS = 60_000;

/** Publish that expiry again only after a minute. `0` means it has not been asked. */
export function publishReady(lastAt: number, nowMs: number, every = PUBLISH_EVERY_MS): boolean {
  return nowMs - lastAt >= every;
}

/**
 * `published` is a new fixing. `fixed` is 409 "already a fixing": the expiry
 * is on the beacon, so settle it. Anything else, including "no sample", failed.
 */
export function publishOutcome(status: number, error?: string): "published" | "fixed" | "failed" {
  if (status >= 200 && status < 300) return "published";
  if (status === 409 && error === "already a fixing") return "fixed";
  return "failed";
}

export function termsFor(position: WatchPosition, serverKey: Uint8Array, emulatorKey: Uint8Array, readFee = 0n): Terms {
  return {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: 0n,
    expiry: BigInt(position.expiry),
    deadline: BigInt(position.expiry),
    exit: position.exit,
    writerPk: position.writerPk,
    payoutKey: position.payoutKey,
    holderPk: position.holderPk,
    holderPayoutKey: position.holderPayoutKey,
    beacon: beaconIdOf(asset.AssetId.create(position.beaconTxid, position.beaconGidx)),
    readFee,
    serverKey,
    emulatorKey,
  };
}
