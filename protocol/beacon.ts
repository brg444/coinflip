import { createHash } from "node:crypto";

import { arkade, asset, Extension, Transaction, UnknownPacket } from "@arkade-os/sdk";

import { beaconIdOf, type BeaconId } from "./beacon-id.ts";
import { DUST_SATS, EXIT } from "./constants.ts";
import { addressOf } from "./contracts.ts";
import { bytesToHex, xOnly } from "./hex.ts";
import { beaconProgram } from "./programs.ts";

export { beaconIdOf, type BeaconId };

/**
 * AttestationBeacon state and bindings. Layout and digests follow
 * contracts/attestation_beacon.ark; contracts/beacon.md explains them.
 */

export const STATE_TYPE = 32;
export const STATE_SIZE = 329;
export const SLOT_COUNT = 8;
export const SLOT_SIZE = 40;
export const SLOTS_AT = 9;
export const SLOT_OFFSETS = Array.from({ length: SLOT_COUNT }, (_, i) => SLOTS_AT + SLOT_SIZE * i);
export type Slot = { expiry: bigint; value: Uint8Array };
export type BeaconState = { version: number; round: bigint; slots: Slot[] };

/** `num2bin(value, size)`: little-endian sign-magnitude, so the top bit must stay clear. */
export function num2bin(value: bigint, size: number): Uint8Array {
  if (value < 0n) throw new Error("num2bin: negative");
  if (value >= 1n << BigInt(size * 8 - 1)) throw new Error(`num2bin: ${value} does not fit ${size} bytes`);
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function bin2num(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(i === bytes.length - 1 ? bytes[i]! & 0x7f : bytes[i]!);
  }
  return bytes[bytes.length - 1]! & 0x80 ? -value : value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(createHash("sha256").update(concat(...parts)).digest());
}

export function encodeState(state: BeaconState): Uint8Array {
  if (state.slots.length !== SLOT_COUNT) throw new Error(`state needs ${SLOT_COUNT} slots`);
  const parts = [Uint8Array.of(state.version), num2bin(state.round, 8)];
  for (const slot of state.slots) {
    if (slot.value.length !== 32) throw new Error("slot value must be 32 bytes");
    parts.push(num2bin(slot.expiry, 8), slot.value);
  }
  return concat(...parts);
}

export function decodeState(bytes: Uint8Array): BeaconState {
  if (bytes.length !== STATE_SIZE) throw new Error(`state is ${bytes.length} bytes, want ${STATE_SIZE}`);
  return {
    version: bytes[0]!,
    round: bin2num(bytes.subarray(1, 9)),
    slots: SLOT_OFFSETS.map((at) => ({
      expiry: bin2num(bytes.subarray(at, at + 8)),
      value: bytes.slice(at + 8, at + SLOT_SIZE),
    })),
  };
}

export function genesisState(): Uint8Array {
  return encodeState({
    version: 1,
    round: 0n,
    slots: Array.from({ length: SLOT_COUNT }, () => ({ expiry: 0n, value: new Uint8Array(32) })),
  });
}

/** The packet `attest` requires after `prev`: round + 1, the new slot first, the oldest slot dropped. */
export function nextState(prev: Uint8Array, expiry: bigint, value: Uint8Array): Uint8Array {
  const state = decodeState(prev);
  if (expiry <= 0n) throw new Error("expiry must be positive");
  if (state.slots.some((slot) => slot.expiry === expiry)) throw new Error(`expiry ${expiry} is already in a slot`);
  return encodeState({
    version: 1,
    round: state.round + 1n,
    slots: [{ expiry, value }, ...state.slots.slice(0, SLOT_COUNT - 1)],
  });
}

/**
 * Slot value the vault reads. The price is the first 8 bytes. The sample time
 * is the next 8. The rest are zero, so a price-only reader still sees the price.
 */
export function priceValue(cents: bigint, time = 0n): Uint8Array {
  const out = new Uint8Array(32);
  out.set(num2bin(cents, 8), 0);
  out.set(num2bin(time, 8), 8);
  return out;
}

/** Operator digest: `sha256(ctrlTxid || nextState)`. `ctrlTxid` is the reversed display txid. */
export function publishDigest(ctrlTxid: Uint8Array, next: Uint8Array): Uint8Array {
  if (ctrlTxid.length !== 32) throw new Error("ctrlTxid must be 32 bytes");
  if (next.length !== STATE_SIZE) throw new Error("next state size");
  return sha256(ctrlTxid, next);
}

const TICKER = new Uint8Array([0x42, 0x54, 0x43, 0x55, 0x53, 0x44]);

/** Sample the beacon checks: `sha256(ctrlTxid || BTCUSD || expiry_le64 || price_le64 || time_le64)`. */
export function sampleDigest(ctrlTxid: Uint8Array, expiry: bigint, price: bigint, time: bigint): Uint8Array {
  if (ctrlTxid.length !== 32) throw new Error("ctrlTxid must be 32 bytes");
  return sha256(ctrlTxid, TICKER, num2bin(expiry, 8), num2bin(price, 8), num2bin(time, 8));
}

export const SIGNER_SLOTS = 5;

export type BeaconArgs = {
  id: BeaconId;
  /** One to five oracle keys. Unused slots are padded inside the script binding. */
  signers: readonly Uint8Array[];
  /** How many of `signers` must sign a sample. At least 1, at most the signer count. */
  threshold: bigint;
  domain: Uint8Array;
  expiryLag: bigint;
  /** Sats a read adds to the beacon. The vault being settled pays this. */
  readFee: bigint;
  adminPk: Uint8Array;
  exit?: bigint;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type Bound = {
  address: string;
  pkScript: Uint8Array;
  program: Uint8Array;
  args: Record<string, bigint | Uint8Array>;
  script: arkade.ArkadeProgramScript;
};

export function bindBeacon(input: BeaconArgs): Bound {
  if (input.signers.length < 1 || input.signers.length > SIGNER_SLOTS) throw new Error("1 to 5 signers");
  if (input.threshold < 1n || input.threshold > BigInt(input.signers.length)) throw new Error("threshold");
  if (input.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  const signers = input.signers.map((key) => xOnly(key));
  if (new Set(signers.map((key) => bytesToHex(key))).size !== signers.length) throw new Error("duplicate signer");
  const padded = [...signers];
  while (padded.length < SIGNER_SLOTS) padded.push(padded[0]!);
  const serverKey = xOnly(input.serverKey);
  const args: Record<string, bigint | Uint8Array> = {
    ctrlTxid: input.id.txid,
    ctrlGidx: input.id.gidx,
    signersN: BigInt(signers.length),
    threshold: input.threshold,
    domain: input.domain,
    expiryLag: input.expiryLag,
    readFee: input.readFee,
    adminPk: xOnly(input.adminPk),
    exit: input.exit ?? EXIT,
    server: serverKey,
  };
  padded.forEach((key, index) => {
    args[`signers.${index}`] = key;
  });
  const script = new arkade.ArkadeProgramScript(beaconProgram(), args, {
    serverKey,
    emulatorKey: input.emulatorKey,
  });
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    program: script.tweakedPublicKey,
    args,
    script,
  };
}

export type FundingCoin = {
  value: number | bigint;
  assets?: readonly { assetId: string; amount: bigint | number }[];
};

/**
 * Outputs for the deploy transaction. Output 0 is the beacon. Other assets on
 * the issued coin go to a change output. The SDK appends the anchor.
 */
export function genesisOutputs(
  inputCoin: FundingCoin,
  assetId: asset.AssetId,
  beaconPkScript: Uint8Array,
  changeScript: Uint8Array,
): { script: Uint8Array; amount: bigint }[] {
  const value = BigInt(inputCoin.value);
  if (value < DUST_SATS) throw new Error("beacon needs 330 sats");
  const identity = assetId.toString();
  const others: { assetId: string; amount: bigint }[] = [];
  for (const item of inputCoin.assets ?? []) {
    const amount = BigInt(item.amount);
    if (amount <= 0n) continue;
    if (item.assetId === identity) {
      if (amount !== 1n) throw new Error("identity amount");
      continue;
    }
    others.push({ assetId: item.assetId, amount });
  }
  const remainder = value - DUST_SATS;
  if (others.length > 0 && remainder < DUST_SATS) throw new Error("change cannot be paid");
  const fold = remainder < DUST_SATS;
  const outputs: { script: Uint8Array; amount: bigint }[] = [
    { script: beaconPkScript, amount: fold ? value : DUST_SATS },
  ];
  if (!fold) outputs.push({ script: changeScript, amount: remainder });
  const groups = [
    asset.AssetGroup.create(
      assetId,
      null,
      [asset.AssetInput.create(0, 1n)],
      [asset.AssetOutput.create(0, 1n)],
      [],
    ),
  ];
  for (const other of others) {
    groups.push(
      asset.AssetGroup.create(
        asset.AssetId.fromString(other.assetId),
        null,
        [asset.AssetInput.create(0, other.amount)],
        [asset.AssetOutput.create(1, other.amount)],
        [],
      ),
    );
  }
  const extension = Extension.create([
    asset.Packet.create(groups),
    new UnknownPacket(STATE_TYPE, genesisState()),
  ]).txOut();
  outputs.push({ script: extension.script!, amount: BigInt(extension.amount ?? 0n) });
  return outputs;
}

export function statePacketOf(tx: Transaction): Uint8Array {
  const packet = Extension.fromTx(tx).getPacketByType(STATE_TYPE);
  if (!packet) throw new Error("state packet missing");
  return packet.serialize();
}
