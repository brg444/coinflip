import path from "node:path";

import {
  defaultEmulatorPubkey,
  RestArkProvider,
  RestEmulatorProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { ARK_URL, DEFAULT_RELAYS, EMULATOR_URL } from "../protocol/constants.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { networkByName } from "../protocol/network.ts";
import { watchPositions } from "../protocol/nostr.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { btcUsdCents } from "./price.ts";
import { createOracle, type OracleWallet } from "./service.ts";

/**
 *   ORACLE_KEY      optional 32-byte hex. Never generated. Wallet, issue, deploy, and exit.
 *   ORACLE_SIGNERS  optional comma-separated 1 to 5 secrets that sign prices.
 *                   Defaults to ORACLE_KEY, so a test deploy can use one key.
 *   ORACLE_THRESHOLD how many of those keys must sign. Default 1.
 *   ORACLE_ADMIN    optional bearer. Unset disables /api/samples, /api/issue, /api/deploy, /api/recover, and /api/publish.
 *   SAMPLE_MS       how often to store a BTCUSD sample. Default 60000.
 *                   0 uses that same minute. Samples older than 24 hours are dropped.
 *                   That minute also publishes each nostr filled-vault expiry once
 *                   expiry + 60 has passed and a sample exists. It does not settle.
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
const signerKeys = (process.env.ORACLE_SIGNERS?.trim() || "")
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((raw) => {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("ORACLE_SIGNERS entries must be 32 bytes");
    return hexToBytes(raw);
  });
if (signerKeys.length > 5) throw new Error("ORACLE_SIGNERS accepts 1 to 5 keys");
const threshold = Number(process.env.ORACLE_THRESHOLD ?? "1");
if (!Number.isInteger(threshold) || threshold < 1) throw new Error("ORACLE_THRESHOLD");
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
      arkServerUrl: arkUrl,
      indexerUrl: arkUrl,
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

const announced = new Map<string, OptionPosition>();
watchPositions({
  relays: DEFAULT_RELAYS,
  onPosition(position) {
    announced.set(position.rfq_id, position);
  },
});

const oracle = await createOracle({
  dataDir,
  port,
  host: process.env.HOST?.trim() || undefined,
  adminToken,
  oracleKey,
  signerKeys: signerKeys.length ? signerKeys : undefined,
  threshold,
  emulatorKey: hexToBytes(defaultEmulatorPubkey(networkByName((await new RestArkProvider(arkUrl).getInfo()).network))),
  wallet: wallet as unknown as OracleWallet | undefined,
  indexer: wallet?.indexerProvider,
  emulator: new RestEmulatorProvider(emulatorUrl),
  quote: () => btcUsdCents(AbortSignal.timeout(10_000)),
  sampleEveryMs: sampleInterval,
  announcedPositions: () => announced.values(),
  onPublishedExpiry: (expiry) => {
    for (const [id, pos] of announced) {
      if (pos.expiry === expiry) announced.delete(id);
    }
  },
});

console.log(`oracle http://127.0.0.1:${oracle.port}/`);
console.log(`oracle data ${path.resolve(dataDir)} sqlite ${storage.file}`);
