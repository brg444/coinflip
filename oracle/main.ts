import path from "node:path";

import {
  defaultEmulatorPubkey,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { DEFAULT_RELAYS, PREDICT_VOID_AFTER } from "../protocol/constants.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { assertNetworkMatch, networkProfile } from "../protocol/network.ts";
import { watchPositions } from "../protocol/nostr.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { startDiaFeed } from "./feed.ts";
import { createOracle, type OracleWallet } from "./service.ts";

/**
 *   NETWORK        optional ("bitcoin" | "mutinynet" | "regtest"). Defaults to mutinynet.
 *   ORACLE_KEY     optional 32-byte hex. Never generated. Wallet, issue, deploy, renew, and exit.
 *   ORACLE_ADMIN   optional bearer. Unset disables admin endpoints (/api/intent, /api/issue, /api/deploy, /api/recover, /api/publish, /api/renew).
 *   SAMPLE_MS      how often to read the latest DIA OracleUpdate. Default 20000.
 *   DIA_WS         default wss://rpc.diadata.org. IntentRegistered, then getLatestIntentByType.
 *   ARK_URL        default from NETWORK profile
 *   EMULATOR_URL   default from NETWORK profile
 *   DATA_DIR       oracle.json + arkade.sqlite. Default ./data
 *   PORT           default 8789
 *   HOST           default 127.0.0.1. oracle/Dockerfile sets 0.0.0.0.
 */

function optionalKey(name: string): Uint8Array | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} must be 32 bytes`);
  return hexToBytes(raw);
}

const requestedNetwork = process.env.NETWORK?.trim();
const defaults = networkProfile(requestedNetwork);
const oracleKey = optionalKey("ORACLE_KEY");
const deskPubkeyRaw = process.env.DESK_PUBKEY?.trim().toLowerCase() || undefined;
if (deskPubkeyRaw && !/^[0-9a-f]{64}$/.test(deskPubkeyRaw)) throw new Error("DESK_PUBKEY must be 32 bytes");
const adminToken = process.env.ORACLE_ADMIN?.trim() || undefined;
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8789");
const sampleEveryMs = Number(process.env.SAMPLE_MS ?? "20000");
const arkUrl = process.env.ARK_URL?.trim() || defaults.arkUrl;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || defaults.emulatorUrl;
const stateless = process.env.STATELESS_ORACLE === "1" || process.env.STATELESS_ORACLE?.trim().toLowerCase() === "true";
if (!Number.isInteger(port) || port < 0) throw new Error("PORT");
if (!Number.isInteger(sampleEveryMs) || sampleEveryMs < 0) throw new Error("SAMPLE_MS");
const sampleInterval = sampleEveryMs > 0 ? sampleEveryMs : 20_000;
if (!stateless && typeof EventSource === "undefined") {
  throw new Error("Contract events need Node's EventSource. Start the oracle with --experimental-eventsource.");
}

const arkProvider = stateless ? undefined : new RestArkProvider(arkUrl);
const arkInfo = arkProvider ? await arkProvider.getInfo() : undefined;
const profile = arkInfo ? assertNetworkMatch(requestedNetwork, arkInfo.network) : defaults;
if (arkInfo && BigInt(arkInfo.unilateralExitDelay) !== profile.exit) {
  throw new Error(`server unilateralExitDelay is ${arkInfo.unilateralExitDelay}; ${profile.id} contracts use ${profile.exit}`);
}

const storage = stateless ? undefined : await openSqliteStorage(dataDir);
const wallet = !stateless && oracleKey && arkProvider && storage
  ? await Wallet.create({
      identity: SingleKey.fromHex(bytesToHex(oracleKey)),
      arkProvider,
      indexerProvider: new RestIndexerProvider(arkUrl),
      settlementConfig: false,
      storage: {
        walletRepository: storage.walletRepository,
        contractRepository: storage.contractRepository,
      },
    })
  : undefined;

if (wallet && storage) {
  try {
    const state = (await storage.walletRepository.getWalletState()) ?? {};
    await storage.walletRepository.saveWalletState({
      ...state,
      settings: { ...state.settings, hasPendingTx: true },
    });
    const recovered = await wallet.finalizePendingTxs();
    if (recovered.finalized.length || recovered.pending.length) {
      console.log(
        `oracle recover finalized=${recovered.finalized.join(",") || "-"} pending=${recovered.pending.join(",") || "-"}`,
      );
    }
  } catch (err) {
    console.error("oracle recover failed:", err instanceof Error ? err.message : err);
  }
}

const MAX_ANNOUNCED = 2_000;
const TRACK_AGE_S = Number(PREDICT_VOID_AFTER);
const announced = new Map<string, OptionPosition>();
function pruneAnnounced(now = Math.floor(Date.now() / 1000)) {
  for (const [id, pos] of announced) {
    if (now - pos.expiry > TRACK_AGE_S) announced.delete(id);
  }
  while (announced.size > MAX_ANNOUNCED) {
    const oldest = announced.keys().next().value;
    if (!oldest) break;
    announced.delete(oldest);
  }
}
if (!stateless) {
  watchPositions({
    relays: DEFAULT_RELAYS,
    onPosition(position) {
      if (deskPubkeyRaw && position.writer_pubkey !== deskPubkeyRaw && position.holder_pubkey !== deskPubkeyRaw) return;
      const now = Math.floor(Date.now() / 1000);
      if (now - position.expiry > TRACK_AGE_S) return;
      announced.set(position.rfq_id, position);
      pruneAnnounced(now);
    },
  });
}

let onDiaIntent: ((intent: Awaited<ReturnType<typeof startDiaFeed>> extends { latest: () => Promise<infer T> } ? NonNullable<T> : never) => void) | undefined;
const feed = startDiaFeed(sampleInterval, undefined, (intent) => onDiaIntent?.(intent));
const oracle = await createOracle({
  dataDir,
  port,
  host: process.env.HOST?.trim() || undefined,
  adminToken,
  oracleKey,
  emulatorKey: hexToBytes(defaultEmulatorPubkey(profile.network)),
  wallet: wallet as unknown as OracleWallet | undefined,
  indexer: wallet?.indexerProvider,
  emulator: stateless ? undefined : new RestEmulatorProvider(emulatorUrl),
  arkProvider,
  sdkNetwork: profile.network,
  exit: profile.exit,
  hrp: profile.hrp,
  network: profile.id,
  stateless,
  deprecatedSigners: (arkInfo?.deprecatedSigners ?? []).map((item) => ({
    pubkey: item.pubkey,
    cutoffDate: item.cutoffDate.toString(),
  })),
  pull: () => feed.latest(),
  sampleEveryMs: sampleInterval,
  allowedPubkey: deskPubkeyRaw,
  announcedPositions: stateless
    ? undefined
    : () => {
        pruneAnnounced();
        return announced.values();
      },
});
onDiaIntent = (intent) => {
  void oracle.ingestIntent(intent).catch((err) => {
    console.error("oracle sample", err instanceof Error ? err.message : "sample failed");
  });
};

console.log(`oracle http://127.0.0.1:${oracle.port}/`);
console.log(`oracle data ${path.resolve(dataDir)}${storage ? ` sqlite ${storage.file}` : " (stateless)"}`);
