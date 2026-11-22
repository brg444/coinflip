import path from "node:path";

import {
  defaultEmulatorPubkey,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { ARK_URL, DEFAULT_RELAYS, EMULATOR_URL } from "../protocol/constants.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { watchPositions } from "../protocol/nostr.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { startDiaFeed } from "./feed.ts";
import { createOracle, type OracleWallet } from "./service.ts";

/**
 *   ORACLE_KEY      optional 32-byte hex. Never generated. Wallet, issue, deploy, and exit.
 *   ORACLE_ADMIN    optional bearer. Unset disables /api/intent, /api/issue, /api/deploy, /api/recover, and /api/publish.
 *   SAMPLE_MS       how often to read the latest DIA OracleUpdate. Default 60000.
 *                   0 uses that same minute. Prints older than 24 hours are dropped.
 *                   That minute also publishes each nostr filled-vault expiry once
 *                   expiry + 60 has passed and a DIA print sits in the window. It does not settle.
 *   DIA_WS          default wss://rpc.diadata.org. IntentRegistered, then getLatestIntentByType.
 *   ARK_URL        default https://mutinynet.arkade.sh
 *   EMULATOR_URL   default Mutinynet emulator
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

const oracleKey = optionalKey("ORACLE_KEY");
const adminToken = process.env.ORACLE_ADMIN?.trim() || undefined;
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8789");
const sampleEveryMs = Number(process.env.SAMPLE_MS ?? "60000");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
if (!Number.isInteger(port) || port < 0) throw new Error("PORT");
if (!Number.isInteger(sampleEveryMs) || sampleEveryMs < 0) throw new Error("SAMPLE_MS");
const sampleInterval = sampleEveryMs > 0 ? sampleEveryMs : 60_000;
if (typeof EventSource === "undefined") {
  throw new Error("Contract events need Node's EventSource. Start the oracle with --experimental-eventsource.");
}

const storage = await openSqliteStorage(dataDir);
const wallet = oracleKey
  ? await Wallet.create({
      identity: SingleKey.fromHex(bytesToHex(oracleKey)),
      arkProvider: new RestArkProvider(arkUrl),
      indexerProvider: new RestIndexerProvider(arkUrl),
      settlementConfig: false,
      storage: {
        walletRepository: storage.walletRepository,
        contractRepository: storage.contractRepository,
      },
    })
  : undefined;

if (wallet) {
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

const announced = new Set<number>();
watchPositions({
  relays: DEFAULT_RELAYS,
  onPosition(position) {
    announced.add(position.expiry);
  },
});

const feed = startDiaFeed(sampleInterval);
const oracle = await createOracle({
  dataDir,
  port,
  host: process.env.HOST?.trim() || undefined,
  adminToken,
  oracleKey,
  emulatorKey: hexToBytes(defaultEmulatorPubkey(networkByName((await new RestArkProvider(arkUrl).getInfo()).network))),
  wallet: wallet as unknown as OracleWallet | undefined,
  indexer: wallet?.indexerProvider,
  emulator: new RestEmulatorProvider(emulatorUrl),
  pull: () => feed.latest(),
  sampleEveryMs: sampleInterval,
  announcedExpiries: () => announced,
});

console.log(`oracle http://127.0.0.1:${oracle.port}/`);
console.log(`oracle data ${path.resolve(dataDir)} sqlite ${storage.file}`);
