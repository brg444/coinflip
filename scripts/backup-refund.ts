/**
 * Tier-2 emergency recovery CLI: signs a Bitcoin L1 spend of an unrolled PredictVault
 * through its `refundBackup` tapleaf (`older(fallbackDelay)` + `tweak(backupPk, refund)`).
 *
 * Use ONLY if the Arkade operator / primary emulator is permanently unavailable after
 * `fallbackDelay` and `expiry + voidAfter`. Never logs `BACKUP_KEY`.
 *
 * Usage:
 *   NETWORK=bitcoin BACKUP_KEY=<64-hex> POSITION_FILE=/path/to/position.json \
 *     UTXO_TXID=<64-hex> UTXO_VOUT=0 UTXO_VALUE=<sats> FEE_SATS=1000 \
 *     [SERVER_KEY=<64-hex>] [EMULATOR_KEY=<66-hex>] \
 *     node --experimental-strip-types scripts/backup-refund.ts
 */
import { readFileSync } from "node:fs";

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  arkade,
  defaultEmulatorPubkey,
  RestArkProvider,
  Transaction,
} from "@arkade-os/sdk";

import { BEACON_READ_FEE, DUST_SATS } from "../protocol/constants.ts";
import { bindContracts } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../protocol/hex.ts";
import { parsePosition } from "../protocol/messages.ts";
import { networkProfile } from "../protocol/network.ts";
import { exitSequence, predictVaultProgram } from "../protocol/programs.ts";
import { positionFromAnnouncement, termsFor } from "../settle/positions.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function requiredEnv(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) throw new Error(`${name} is required`);
  return val;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function bigIntToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = ((value % N) + N) % N;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function tapLeafHash(script: Uint8Array, version = 0xc0): Uint8Array {
  const tag = sha256(new TextEncoder().encode("TapLeaf"));
  const len = script.length < 0xfd
    ? Uint8Array.of(script.length)
    : Uint8Array.of(0xfd, script.length & 0xff, (script.length >> 8) & 0xff);
  const preimage = new Uint8Array(tag.length * 2 + 1 + len.length + script.length);
  preimage.set(tag, 0);
  preimage.set(tag, tag.length);
  preimage[tag.length * 2] = version;
  preimage.set(len, tag.length * 2 + 1);
  preimage.set(script, tag.length * 2 + 1 + len.length);
  return sha256(preimage);
}

/** Compute Arkade script-tweaked secret matching `computeArkadeScriptPublicKey(backupPk, refundScript)`. */
function tweakedBackupSecret(rawSecret: Uint8Array, refundScript: Uint8Array): { secret: Uint8Array; xOnlyPub: Uint8Array } {
  const compressed = secp256k1.getPublicKey(rawSecret, true);
  let d = bytesToBigInt(rawSecret);
  if (compressed[0] === 0x03) d = N - d;
  const scalar = bytesToBigInt(arkade.arkadeScriptHash(refundScript)) % N;
  const tweaked = (d + scalar) % N;
  if (tweaked === 0n) throw new Error("invalid tweak");
  const secret = bigIntToBytes32(tweaked);
  const xOnlyPub = schnorr.getPublicKey(secret);
  const expectedPub = arkade.computeArkadeScriptPublicKey(compressed, refundScript);
  if (bytesToHex(xOnlyPub) !== bytesToHex(expectedPub)) {
    throw new Error("tweaked backup pubkey mismatch against SDK computeArkadeScriptPublicKey");
  }
  return { secret, xOnlyPub };
}

const profile = networkProfile(process.env.NETWORK);
const backupKeyHex = requiredEnv("BACKUP_KEY").toLowerCase();
if (!/^[0-9a-f]{64}$/.test(backupKeyHex)) throw new Error("BACKUP_KEY must be 64-hex");
const backupSecret = hexToBytes(backupKeyHex);
const backupPubHex = bytesToHex(schnorr.getPublicKey(backupSecret));

const rawPos = JSON.parse(readFileSync(requiredEnv("POSITION_FILE"), "utf8"));
const pos = parsePosition(rawPos);
if (!pos) throw new Error("POSITION_FILE is not a valid OptionPosition");
const watched = positionFromAnnouncement(pos);
if (!watched || !watched.stake) throw new Error("position is not a PredictVault");
if (pos.backup_pubkey?.toLowerCase() !== backupPubHex) {
  throw new Error(`BACKUP_KEY pubkey ${backupPubHex} does not match position backup_pubkey ${pos.backup_pubkey}`);
}

const serverKeyHex = process.env.SERVER_KEY?.trim()
  || bytesToHex(xOnly(hexToBytes((await new RestArkProvider(process.env.ARK_URL?.trim() || profile.arkUrl).getInfo()).signerPubkey)));
const serverKey = xOnly(hexToBytes(serverKeyHex));
const emulatorKey = hexToBytes(process.env.EMULATOR_KEY?.trim() || defaultEmulatorPubkey(profile.network));
const terms = termsFor(watched, serverKey, emulatorKey, BEACON_READ_FEE, profile.hrp);
const bound = bindContracts(terms);
if (bound.vaultAddress !== pos.vault_address) {
  throw new Error(`derived vaultAddress ${bound.vaultAddress} != position ${pos.vault_address}`);
}

const utxoTxid = requiredEnv("UTXO_TXID").toLowerCase();
if (!/^[0-9a-f]{64}$/.test(utxoTxid)) throw new Error("UTXO_TXID must be 64-hex");
const utxoVout = Number(requiredEnv("UTXO_VOUT"));
const utxoValue = BigInt(requiredEnv("UTXO_VALUE"));
const feeSats = BigInt(process.env.FEE_SATS?.trim() || "1000");
if (utxoValue <= feeSats + DUST_SATS) throw new Error("UTXO_VALUE too small for fee");

const script = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, { serverKey, emulatorKey });
const refundFn = script.functionByName("refund");
const backupFn = script.functionByName("refundBackup");
if (!refundFn?.arkadeScript || !backupFn) throw new Error("PredictVault refund/refundBackup missing");

const tweaked = tweakedBackupSecret(backupSecret, refundFn.arkadeScript);
const fallbackDelay = terms.fallbackDelay ?? profile.fallbackDelay;
const voidAfter = terms.voidAfter ?? profile.voidAfter;
const spendable = utxoValue - feeSats;
const stake = watched.stake;
const house = spendable - stake;

const tx = new Transaction({ version: 2, lockTime: Number(terms.expiry + voidAfter) });
tx.addInput({
  txid: hexToBytes(utxoTxid),
  index: utxoVout,
  sequence: Number(exitSequence(fallbackDelay)),
  witnessUtxo: { script: bound.vaultPkScript, amount: utxoValue },
  tapLeafScript: [backupFn.tapLeafScript],
});
if (house > DUST_SATS) {
  tx.addOutput({ script: bound.holderPkScript, amount: stake });
  tx.addOutput({ script: bound.writerPkScript, amount: house });
} else {
  tx.addOutput({ script: bound.holderPkScript, amount: spendable });
}

function encodeControlBlock(cb: { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] }): Uint8Array {
  const out = new Uint8Array(1 + 32 + cb.merklePath.length * 32);
  out[0] = cb.version;
  out.set(cb.internalKey, 1);
  cb.merklePath.forEach((node, i) => out.set(node, 33 + i * 32));
  return out;
}

const leafScript = backupFn.tapLeafScript[1];
const controlBlock = encodeControlBlock(backupFn.tapLeafScript[0] as { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] });
const sighash = tx.preimageWitnessV1(
  0,
  [bound.vaultPkScript],
  0, // SigHash.DEFAULT
  [utxoValue],
  undefined,
  tapLeafHash(leafScript),
);
const sig = schnorr.sign(sighash, tweaked.secret);
if (!schnorr.verify(sig, sighash, tweaked.xOnlyPub)) {
  throw new Error("generated signature failed local BIP340 verification");
}
tx.updateInput(0, {
  finalScriptWitness: [sig, leafScript, controlBlock],
});

console.log(JSON.stringify({
  network: profile.id,
  txid: tx.id,
  lockTime: Number(terms.expiry + voidAfter),
  sequence: Number(exitSequence(fallbackDelay)),
  holderSats: (house > DUST_SATS ? stake : spendable).toString(),
  writerSats: (house > DUST_SATS ? house : 0n).toString(),
  feeSats: feeSats.toString(),
  rawTxHex: bytesToHex(tx.extract()),
}));
