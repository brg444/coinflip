import { readFile } from "node:fs/promises";
import http from "node:http";

import {
  arkade,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
} from "@arkade-os/sdk";

import { DEFAULT_RELAYS, PREDICT_VOID_AFTER } from "../protocol/constants.ts";
import { bindContracts } from "../protocol/contracts.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { assertNetworkMatch, networkProfile } from "../protocol/network.ts";
import { quoteRelay, watchPositions } from "../protocol/nostr.ts";
import { revision } from "../protocol/sqlite-storage.ts";
import { fetchOracleFixing, fetchOracleStatus, parseOracleKey, serviceOrigin, type OracleFixing } from "./oracle.ts";
import { duePositions, manualPositions, settlementPositions, termsFor } from "./positions.ts";
import { Progress } from "./progress.ts";
import { refundQuote, settlePredictQuote } from "./vault.ts";

/**
 * Permissionless settler for standalone PredictVaultV3 positions.
 * Watches public filled-vault announcements on Nostr, fetches the oracle's
 * signed fixing after `expiry + 60`, and settles (or voids after `voidAfter`).
 * Holds no private keys or fee wallet.
 *
 *   ORACLE_URL   oracle origin (`GET /api/status` and `GET /api/fixing`).
 *   RELAYS       default nostr.arkade.sh. Filled vaults are kind 30078.
 *   POSITIONS    optional JSON file of vaults to settle without waiting for an event.
 *   ARK_URL      default from NETWORK profile
 *   EMULATOR_URL default from NETWORK profile
 *   DATA_DIR     progress.json. Default ./data
 *   PORT         status HTTP. Default 8790
 *   HOST         default 127.0.0.1
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const requestedNetwork = process.env.NETWORK?.trim();
const defaults = networkProfile(requestedNetwork);
const relayList = (process.env.RELAYS ?? DEFAULT_RELAYS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const relay = quoteRelay(relayList);
const positionsFile = process.env.POSITIONS?.trim() || "";
const oracleUrl = serviceOrigin(required("ORACLE_URL"));
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8790");
const host = process.env.HOST?.trim() || "127.0.0.1";
const arkUrl = process.env.ARK_URL?.trim() || defaults.arkUrl;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || defaults.emulatorUrl;
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");

const progress = await Progress.open(dataDir);
const indexer = new RestIndexerProvider(arkUrl);
const ark = new RestArkProvider(arkUrl);
const arkInfo = await ark.getInfo();
const profile = assertNetworkMatch(requestedNetwork, arkInfo.network);
const network = profile.network;
const client = await arkade.Arkade.connect({
  arkade: ark,
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  network,
});
if (!client.emulatorKey || !client.emulator) throw new Error("emulator missing");

let polling = false;
let watching = 0;
let oraclePkFilter: string | null = null;
const noted = new Set<string>();

function matchesOurOracle(oraclePkHex: string): boolean {
  if (!oraclePkFilter) return true;
  return oraclePkHex.toLowerCase() === oraclePkFilter;
}

const MAX_NOTED_KEYS = 2_000;
function once(key: string, line: string, error = false) {
  if (noted.has(key)) return;
  if (noted.size >= MAX_NOTED_KEYS) {
    const oldest = noted.values().next().value;
    if (oldest !== undefined) noted.delete(oldest);
  }
  noted.add(key);
  if (error) console.error(line);
  else console.log(line);
}

async function loadManual() {
  if (!positionsFile) return;
  let text: string;
  try {
    text = await readFile(positionsFile, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    once("positions-file", missing ? `positions file missing ${positionsFile}` : `positions file ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    once("positions-file", `positions file ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  noted.delete("positions-file");
  let changed = false;
  for (const position of manualPositions(body)) {
    if (progress.remember(position)) changed = true;
  }
  if (!changed) return;
  try {
    await progress.save();
  } catch (err) {
    console.error("progress save", err instanceof Error ? err.message : err);
  }
}

function onPosition(position: OptionPosition) {
  if (!matchesOurOracle(position.oracle_pubkey)) return;
  if (!progress.remember(position)) return;
  void progress.save().catch((err) => {
    console.error("progress save", err instanceof Error ? err.message : err);
  });
}

async function tryVoid(
  position: ReturnType<typeof settlementPositions>[number],
  terms: ReturnType<typeof termsFor>,
  now: number,
): Promise<boolean> {
  const voidAfter = Number(position.voidAfter ?? PREDICT_VOID_AFTER);
  if (now < position.expiry + voidAfter) return false;
  try {
    const outcome = await refundQuote({
      chain: client.indexer!,
      serverKey: client.serverKey,
      emulatorKey: client.emulatorKey!,
      emulator: client.emulator!,
      checkpoint: client.checkpoint,
      fillTxid: position.fillTxid,
      terms,
      now,
    });
    if (outcome.result === "refunded" || outcome.result === "spent") {
      progress.note(position.id, outcome.txid);
      try {
        await progress.save();
      } catch (err) {
        console.error("progress save", position.rfqId, err instanceof Error ? err.message : err);
      }
      console.log("voided", position.rfqId, outcome.txid);
      return true;
    }
  } catch (err) {
    console.error(`void ${position.rfqId} ${position.expiry} ${err instanceof Error ? err.message : err}`);
  }
  return false;
}

async function progressDue() {
  await loadManual();
  const now = Math.floor(Date.now() / 1000);
  const positions = settlementPositions(progress.positions());
  watching = positions.length;
  const due = duePositions(positions, now, progress.ids());
  if (!due.length) return;

  let statusBody: unknown;
  try {
    statusBody = await fetchOracleStatus(oracleUrl, AbortSignal.timeout(10_000));
  } catch (err) {
    once("oracle-fetch", `oracle ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  const keyInfo = parseOracleKey(statusBody);
  if (!keyInfo) {
    once("oracle-parse", "oracle key missing from /api/status", true);
    return;
  }
  oraclePkFilter = keyInfo.oraclePkHex;
  noted.delete("oracle-fetch");

  const lag = Number(keyInfo.expiryLag);
  const fixingCache = new Map<number, { status: number; fixing: OracleFixing | null; error?: string }>();

  for (const position of due) {
    if (position.expiry + lag > now) continue;
    if (!matchesOurOracle(position.oraclePkHex)) {
      once(`oracle:${position.id}`, `skip ${position.rfqId} oracle mismatch`, true);
      continue;
    }
    const terms = termsFor(position, client.serverKey, client.emulatorKey!, profile.hrp);
    const bound = bindContracts(terms);
    if (bound.vaultAddress !== position.vaultAddress) {
      once(`addr:${position.id}`, `skip ${position.rfqId} vault address`, true);
      continue;
    }
    let fetched = fixingCache.get(position.expiry);
    if (!fetched) {
      try {
        fetched = await fetchOracleFixing(oracleUrl, position.expiry, position.oraclePkHex, AbortSignal.timeout(10_000));
      } catch (err) {
        fetched = { status: 0, fixing: null, error: err instanceof Error ? err.message : String(err) };
      }
      fixingCache.set(position.expiry, fetched);
    }
    if (!fetched.fixing) {
      if (await tryVoid(position, terms, now)) continue;
      once(`fix:${position.expiry}:${fetched.error ?? fetched.status}`, `fixing ${position.expiry} ${fetched.error ?? fetched.status}`, true);
      continue;
    }
    try {
      const outcome = await settlePredictQuote({
        chain: client.indexer!,
        serverKey: client.serverKey,
        emulatorKey: client.emulatorKey!,
        emulator: client.emulator!,
        checkpoint: client.checkpoint,
        fillTxid: position.fillTxid,
        terms,
        fixing: fetched.fixing,
        now,
      });
      if (outcome.result === "settled") {
        progress.note(position.id, outcome.txid);
        try {
          await progress.save();
        } catch (err) {
          console.error("progress save", position.rfqId, err instanceof Error ? err.message : err);
        }
        console.log("settled", position.rfqId, outcome.txid);
        continue;
      }
      if (outcome.result === "mismatch") {
        once(`mismatch:${position.id}`, `skip ${position.rfqId} oracle mismatch`, true);
        continue;
      }
      if (outcome.result === "waiting") {
        once(`wait:${position.id}:${outcome.reason}`, `waiting ${position.rfqId} ${outcome.reason}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`settle ${position.rfqId} ${position.expiry} ${message}`);
    }
  }
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    await progressDue();
  } finally {
    polling = false;
  }
}

const server = http.createServer((req, res) => {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "bad request" }));
    return;
  }
  if (pathname !== "/" && pathname !== "/status") {
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({
    commit: revision(),
    network: profile.id,
    oracle: oracleUrl,
    oraclePubkey: oraclePkFilter,
    relay,
    watching,
    settled: [...progress.ids()].length,
  }));
});

server.listen(port, host, () => {
  console.log(`commit ${revision()}`);
  console.log(`oracle ${oracleUrl}`);
  console.log(`relay ${relay}`);
  console.log(`status http://${host}:${port}/status`);
});

try {
  const statusBody = await fetchOracleStatus(oracleUrl, AbortSignal.timeout(10_000));
  const keyInfo = parseOracleKey(statusBody);
  if (keyInfo) oraclePkFilter = keyInfo.oraclePkHex;
} catch {
  // Oracle may not be up yet; progressDue refreshes the oracle key once reachable.
}

const positions = watchPositions({ relays: relayList, onPosition });

const timer = setInterval(() => {
  void tick();
}, 2_000);
void tick();

function shutdown() {
  clearInterval(timer);
  positions.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
