import path from "node:path";

import { hexToBytes } from "../protocol/hex.ts";
import { networkProfile } from "../protocol/network.ts";
import { startDiaFeed } from "./feed.ts";
import { createOracle } from "./service.ts";

/**
 * Stateless DIA fixing oracle for PredictVaultV3.
 *
 *   NETWORK        optional ("bitcoin" | "mutinynet" | "regtest"). Defaults to mutinynet.
 *   ORACLE_KEY     optional 32-byte hex. Co-signs canonical fixings for PredictVault.settle.
 *   ORACLE_ADMIN   optional bearer protecting POST /api/intent.
 *   SAMPLE_MS      how often to read the latest DIA OracleUpdate. Default 20000.
 *   DIA_WS         default wss://rpc.diadata.org. IntentRegistered, then getLatestIntentByType.
 *   DATA_DIR       oracle.json. Default ./data
 *   PORT           default 8789
 *   HOST           default 127.0.0.1
 */

function optionalKey(name: string): Uint8Array | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} must be 32 bytes`);
  return hexToBytes(raw);
}

const profile = networkProfile(process.env.NETWORK?.trim());
const oracleKey = optionalKey("ORACLE_KEY");
const adminToken = process.env.ORACLE_ADMIN?.trim() || undefined;
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8789");
const sampleEveryMs = Number(process.env.SAMPLE_MS ?? "20000");
if (!Number.isInteger(port) || port < 0) throw new Error("PORT");
if (!Number.isInteger(sampleEveryMs) || sampleEveryMs < 0) throw new Error("SAMPLE_MS");
const sampleInterval = sampleEveryMs > 0 ? sampleEveryMs : 20_000;

let onDiaIntent: ((intent: NonNullable<Awaited<ReturnType<ReturnType<typeof startDiaFeed>["latest"]>>>) => void) | undefined;
const feed = startDiaFeed(sampleInterval, undefined, (intent) => onDiaIntent?.(intent));
const oracle = await createOracle({
  dataDir,
  port,
  host: process.env.HOST?.trim() || undefined,
  adminToken,
  oracleKey,
  network: profile.id,
  pull: () => feed.latest(),
  sampleEveryMs: sampleInterval,
});
onDiaIntent = (intent) => {
  void oracle.ingestIntent(intent).catch((err) => {
    console.error("oracle sample", err instanceof Error ? err.message : "sample failed");
  });
};

console.log(`oracle http://127.0.0.1:${oracle.port}/`);
console.log(`oracle data ${path.resolve(dataDir)} (stateless)`);
