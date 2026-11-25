/**
 * Migrate a live AttestationBeacon VTXO to the current compiled artifact (and/or current arkd server key).
 *
 * Usage:
 *   NETWORK=bitcoin ORACLE_KEY=<64-hex> BEACON_ASSET_ID=<assetId> \
 *     OLD_ARTIFACT=/path/to/old.artifact.json [OLD_SERVER_KEY=<64-hex>] \
 *     node --experimental-strip-types scripts/migrate-beacon.ts
 *
 * When BEACON_ASSET_ID is omitted, fetches it from ORACLE_URL (default http://127.0.0.1:8789).
 * When OLD_ARTIFACT is omitted, uses the current contracts/attestation_beacon.artifact.json
 * (useful for server-key rotation migrations under arkd's deprecatedSigners).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  arkade,
  asset,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { beaconIdOf, bindBeacon, decodeState, migrateDigest, statePacketOf } from "../protocol/beacon.ts";
import { BEACON_READ_FEE } from "../protocol/constants.ts";
import { addressOf } from "../protocol/contracts.ts";
import { buildMigrate, submit } from "../protocol/cospend.ts";
import { bytesToHex, hexToBytes, xOnly } from "../protocol/hex.ts";
import { assertNetworkMatch, networkProfile } from "../protocol/network.ts";
import { exitSequence } from "../protocol/programs.ts";

const DOMAIN = new TextEncoder().encode("BTCUSD-FIX");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requiredHex(name: string): string {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be 64-hex`);
  return value;
}

async function resolveAssetId(): Promise<string> {
  const fromEnv = process.env.BEACON_ASSET_ID?.trim();
  if (fromEnv) return fromEnv;
  const oracleUrl = (process.env.ORACLE_URL?.trim() || "http://127.0.0.1:8789").replace(/\/+$/, "");
  const res = await fetch(`${oracleUrl}/api/status`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`oracle status ${res.status}`);
  const body = (await res.json()) as { assetId?: string };
  if (!body.assetId) throw new Error("oracle has no assetId");
  return body.assetId;
}

const requestedNetwork = process.env.NETWORK?.trim();
const defaults = networkProfile(requestedNetwork);
const arkUrl = process.env.ARK_URL?.trim() || defaults.arkUrl;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || defaults.emulatorUrl;
const oracleKeyHex = requiredHex("ORACLE_KEY");
const secretBytes = hexToBytes(oracleKeyHex);
const adminPk = await SingleKey.fromHex(oracleKeyHex).xOnlyPublicKey();

const arkProvider = new RestArkProvider(arkUrl);
const info = await arkProvider.getInfo();
const profile = assertNetworkMatch(requestedNetwork, info.network);
const indexer = new RestIndexerProvider(arkUrl);
const emulator = new RestEmulatorProvider(emulatorUrl);
const client = await arkade.Arkade.connect({
  arkade: arkProvider,
  indexer,
  emulator,
  network: profile.network,
});
if (!client.emulatorKey) throw new Error("emulator key missing");

const assetIdStr = await resolveAssetId();
const assetId = asset.AssetId.fromString(assetIdStr);
const beaconId = beaconIdOf(assetId);

const oldArtifactPath = process.env.OLD_ARTIFACT?.trim()
  ? path.resolve(process.env.OLD_ARTIFACT.trim())
  : path.join(root, "contracts/attestation_beacon.artifact.json");
const oldArtifact = JSON.parse(readFileSync(oldArtifactPath, "utf8")) as arkade.ContractArtifact;
const oldProgram = arkade.programFromArtifact(oldArtifact);
const oldServerKey = process.env.OLD_SERVER_KEY?.trim()
  ? xOnly(hexToBytes(process.env.OLD_SERVER_KEY.trim()))
  : client.serverKey;
const oldExit = process.env.OLD_EXIT?.trim() ? BigInt(process.env.OLD_EXIT.trim()) : profile.exit;

const oldScript = new arkade.ArkadeProgramScript(
  oldProgram,
  {
    ctrlTxid: beaconId.txid,
    ctrlGidx: beaconId.gidx,
    domain: DOMAIN,
    expiryLag: 60n,
    readFee: BEACON_READ_FEE,
    adminPk,
    exit: exitSequence(oldExit),
    server: oldServerKey,
  },
  { serverKey: oldServerKey, emulatorKey: client.emulatorKey },
);

const newBound = bindBeacon({
  id: beaconId,
  domain: DOMAIN,
  expiryLag: 60n,
  readFee: BEACON_READ_FEE,
  adminPk,
  exit: profile.exit,
  hrp: profile.hrp,
  serverKey: client.serverKey,
  emulatorKey: client.emulatorKey,
});

if (bytesToHex(oldScript.pkScript) === bytesToHex(newBound.pkScript)) {
  console.log(JSON.stringify({ status: "noop", address: newBound.address, reason: "scripts identical" }));
  process.exit(0);
}

const existing = await indexer.getVtxos({ scripts: [bytesToHex(newBound.pkScript)], spendableOnly: true });
const already = existing.vtxos.find((v) => !v.isSpent && v.assets?.some((a) => a.assetId === assetIdStr && BigInt(a.amount) === 1n));
if (already) {
  console.log(JSON.stringify({ status: "already-migrated", txid: already.txid, address: newBound.address, value: already.value }));
  process.exit(0);
}

const found = await indexer.getVtxos({ scripts: [bytesToHex(oldScript.pkScript)], spendableOnly: true });
const coin = found.vtxos.find((v) => !v.isSpent && v.assets?.some((a) => a.assetId === assetIdStr && BigInt(a.amount) === 1n));
if (!coin) throw new Error(`live beacon coin not found at old address ${addressOf(oldScript, oldServerKey, profile.hrp)}`);

const prevTxs = await indexer.getVirtualTxs([coin.txid]);
const prevTx = prevTxs.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id === coin.txid);
if (!prevTx) throw new Error("creating tx missing");

const state = statePacketOf(prevTx);
const decoded = decodeState(state);
const opSig = schnorr.sign(
  migrateDigest({ domain: DOMAIN, id: beaconId, round: decoded.round, nextProgram: newBound.program }),
  secretBytes,
);
const built = buildMigrate({
  beacon: {
    script: oldScript,
    coin: { txid: coin.txid, vout: coin.vout, value: coin.value, prevTx: prevTx.toBytes(true, true) },
    state,
    id: assetId,
  },
  nextProgram: newBound.program,
  nextPkScript: newBound.pkScript,
  opSig,
  checkpoint: client.checkpoint,
});
const migrated = await submit(built, emulator);

let newCoin;
for (let attempt = 0; attempt < 20; attempt++) {
  const poll = await indexer.getVtxos({ scripts: [bytesToHex(newBound.pkScript)], spendableOnly: true });
  newCoin = poll.vtxos.find((v) => !v.isSpent && v.assets?.some((a) => a.assetId === assetIdStr && BigInt(a.amount) === 1n));
  if (newCoin) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!newCoin) throw new Error("migrated beacon coin not yet indexed on new address");
const migratedTx = Transaction.fromPSBT(base64.decode((await indexer.getVirtualTxs([newCoin.txid])).txs[0]!));
const migratedState = statePacketOf(migratedTx);
console.log(JSON.stringify({
  status: "migrated",
  network: profile.id,
  txid: migrated.txid,
  fromAddress: addressOf(oldScript, oldServerKey, profile.hrp),
  toAddress: newBound.address,
  value: newCoin.value,
  round: decoded.round.toString(),
  statePreserved: bytesToHex(migratedState) === bytesToHex(state),
}));
