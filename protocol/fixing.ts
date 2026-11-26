import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/**
 * Canonical fixing digest and script-integer helpers for standalone PredictVaultV3.
 * Layout matches `contracts/predict_vault.ark`:
 *   sha256("BTCUSD-FIX" || "fix" || num2bin(expiry, 8) || num2bin(cents, 8) || num2bin(time, 8))
 */

export const FIX_GRID_S = 300n;
export const FIX_EXPIRY_LAG = 60n;
export const FIX_DOMAIN = new TextEncoder().encode("BTCUSD-FIX");

const ASCII_FIX = new TextEncoder().encode("fix");

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

/** SHA-256 digest `oraclePk` signs to authorize standalone `PredictVault.settle`. */
export function predictFixDigest(input: {
  expiry: bigint;
  cents: bigint;
  time: bigint;
}): Uint8Array {
  return nobleSha256(concat(
    FIX_DOMAIN,
    ASCII_FIX,
    num2bin(input.expiry, 8),
    num2bin(input.cents, 8),
    num2bin(input.time, 8),
  ));
}
