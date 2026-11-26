import { readFile } from "node:fs/promises";
import http from "node:http";

import {
  arkade,
  asset,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
} from "@arkade-os/sdk";

import { DEFAULT_RELAYS, isPredict, PREDICT_VOID_AFTER } from "../protocol/constants.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { assertNetworkMatch, networkProfile } from "../protocol/network.ts";
import { bindContracts } from "../protocol/contracts.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { quoteRelay, watchPositions } from "../protocol/nostr.ts";
import { revision } from "../protocol/sqlite-storage.ts";
import { chooseSample } from "../oracle/store.ts";
import { fetchOracleFixing, fetchOraclePrices, fetchOracleStatus, parseOracleBeacon, parseOracleKey, serviceOrigin, type OracleFixing } from "./oracle.ts";
import { canAdvancePastFailedPublish, duePositions, manualPositions, publishOutcome, publishReady, settlementPositions, termsFor } from "./positions.ts";
import { Progress } from "./progress.ts";
import { refundQuote, settlePredictQuote, settleQuote } from "./vault.ts";

/**
 * A third party. It watches public filled-vault events on nostr.arkade.sh and
 * settles them after expiry by reading the oracle. It does not quote, fill,
 * or call a desk.
 *
 *   ORACLE_URL   oracle origin. The beacon script comes from /api/status.
 *   ORACLE_ADMIN bearer for POST /api/publish. Without it, a missing fixing is only logged.
 *   RELAYS       default nostr.arkade.sh. Filled vaults are kind 30078.
 *   POSITIONS    optional JSON file of vaults to settle without waiting for an event.
 *   ARK_URL      default Mutinynet arkd
 *   EMULATOR_URL default Mutinynet emulator
 *   DATA_DIR     progress.json. Default ./data
 *   PORT         status HTTP. Default 8790
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
const oracleAdmin = process.env.ORACLE_ADMIN?.trim() ?? "";
const dataDir = process.env.DATA_DIR?.trim() || "data";
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? "8790");
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
let beaconFilter: { txid: string; gidx: number } | null = null;
let oraclePkFilter: string | null = null;
const noted = new Set<string>();

function updateBeaconFilter(assetId: string) {
  const parsed = asset.AssetId.fromString(assetId);
  beaconFilter = { txid: bytesToHex(parsed.txid).toLowerCase(), gidx: Number(parsed.groupIndex) };
}

function matchesOurBeacon(txid: string | undefined, gidx: number | undefined): boolean {
  if (!beaconFilter) return true;
  if (!txid || gidx == null) return false;
  return txid.toLowerCase() === beaconFilter.txid && gidx === beaconFilter.gidx;
}

function matchesOurOracle(oraclePkHex: string | undefined): boolean {
  if (!oraclePkFilter) return true;
  if (!oraclePkHex) return false;
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

type AskResult = { result: "published" | "fixed" | "failed"; status: number; error?: string };
const asked = new Map<number, AskResult & { at: number }>();
const PUBLISH_RETRY_MS = 15_000;

/** Ask the oracle to publish `expiry`. Retries every 15s on failure; 409 still verifies against oracle samples. */
async function askPublish(expiry: number, nowMs: number): Promise<AskResult> {
  const prev = asked.get(expiry);
  if (prev && !publishReady(prev.at, nowMs, PUBLISH_RETRY_MS)) {
    return { result: prev.result, status: prev.status, error: prev.error };
  }
  if (!oracleAdmin) {
    once("oracle-admin", "ORACLE_ADMIN unset, so a missing fixing is not published", true);
    const out: AskResult = { result: "failed", status: 0, error: "oracle-admin unset" };
    asked.set(expiry, { at: nowMs, ...out });
    return out;
  }
  let out: AskResult = { result: "failed", status: 0 };
  try {
    const res = await fetch(`${oracleUrl}/api/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${oracleAdmin}`, "content-type": "application/json" },
      body: JSON.stringify({ expiry }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = res.ok ? {} : (await res.json().catch(() => ({}))) as { error?: string };
    const result = publishOutcome(res.status, body.error);
    out = { result, status: res.status, error: body.error };
    if (result === "failed") console.error(`publish ${expiry} ${body.error ?? res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out = { result: "failed", status: 0, error: msg };
    console.error(`publish ${expiry} ${msg}`);
  }
  asked.set(expiry, { at: nowMs, ...out });
  return out;
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
  if (isPredict(position.kind)) {
    if (!matchesOurOracle(position.oracle_pubkey)) return;
  } else {
    if (!matchesOurBeacon(position.beacon_txid, position.beacon_gidx)) return;
  }
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
  if (!isPredict(position.kind)) return false;
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

/**
 * One settle per pass. Filled vaults share one beacon coin, so the next vault
 * has to read the outpoint the previous settle created.
 */
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
  const parsedBeacon = parseOracleBeacon(statusBody, undefined, 0, profile.hrp);
  if (!keyInfo && !parsedBeacon.ok) {
    once(`oracle-parse:${parsedBeacon.error}`, `oracle ${parsedBeacon.error}`, true);
    return;
  }
  if (keyInfo) oraclePkFilter = keyInfo.oraclePkHex;
  if (parsedBeacon.ok) updateBeaconFilter(parsedBeacon.beacon.assetId);
  noted.delete("oracle-fetch");

  const lag = Number(keyInfo?.expiryLag ?? (parsedBeacon.ok ? parsedBeacon.beacon.expiryLag : 60n));
  const nowMs = Date.now();
  for (const [exp, entry] of asked) {
    if (nowMs - entry.at > 2 * 60 * 60 * 1000) asked.delete(exp);
  }
  let blockedExpiry: number | null = null;
  const fixingCache = new Map<number, { status: number; fixing: OracleFixing | null; error?: string }>();

  for (const position of due) {
    if (position.expiry + lag > now) continue;

    // PredictVaultV3 settles standalone with direct signatures — no beacon publish, no serial bottleneck.
    if (isPredict(position.kind)) {
      if (!matchesOurOracle(position.oraclePkHex)) {
        once(`oracle:${position.id}`, `skip ${position.rfqId} oracle mismatch`, true);
        continue;
      }
      const terms = termsFor(position, client.serverKey, client.emulatorKey!, 0n, profile.hrp);
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
      continue;
    }

    // Legacy OptionVault (kind 0/1) still settles via AttestationBeacon.
    if (!parsedBeacon.ok) continue;
    if (blockedExpiry != null && position.expiry > blockedExpiry) break;
    if (!matchesOurBeacon(position.beaconTxid, position.beaconGidx)) {
      once(`beacon:${position.id}`, `skip ${position.rfqId} beacon mismatch`, true);
      continue;
    }
    const terms = termsFor(position, client.serverKey, client.emulatorKey!, parsedBeacon.beacon.readFee, profile.hrp);
    const bound = bindContracts(terms);
    if (bound.vaultAddress !== position.vaultAddress) {
      once(`addr:${position.id}`, `skip ${position.rfqId} vault address`, true);
      continue;
    }
    // Only ask the oracle to attest when an unspent vault coin is live on the indexer.
    const liveVaults = await client.indexer!.getVtxos({ scripts: [bytesToHex(bound.vaultPkScript)], spendableOnly: true });
    const hasLiveVault = (liveVaults.vtxos ?? []).some(
      (coin) => !coin.isSpent && !coin.spentBy && !coin.isUnrolled && BigInt(coin.value) >= terms.collateral,
    );
    let expected: { price: bigint; time: bigint } | undefined;
    if (hasLiveVault) {
      const published = await askPublish(position.expiry, nowMs);
      if (published.result === "failed") {
        if (!canAdvancePastFailedPublish({ status: published.status, error: published.error, expiry: position.expiry, lag, now })) {
          blockedExpiry = position.expiry;
        }
        continue;
      }
      if (published.result === "fixed") {
        try {
          const samples = await fetchOraclePrices(
            oracleUrl,
            position.expiry - lag,
            position.expiry + lag,
            AbortSignal.timeout(10_000),
          );
          const chosen = chooseSample(samples, position.expiry, lag);
          if (!chosen) {
            console.error(`publish ${position.expiry} fixing is not the oracle sample`);
            continue;
          }
          expected = { price: BigInt(chosen.price), time: BigInt(chosen.time) };
        } catch (err) {
          console.error(`publish ${position.expiry} ${err instanceof Error ? err.message : err}`);
          continue;
        }
      }
    }
    try {
      const outcome = await settleQuote({
        chain: client.indexer!,
        serverKey: client.serverKey,
        emulatorKey: client.emulatorKey!,
        emulator: client.emulator!,
        checkpoint: client.checkpoint,
        fillTxid: position.fillTxid,
        terms,
        beacon: parsedBeacon.beacon,
        now,
        expected,
      });
      if (outcome.result === "rejected") {
        console.error(`skip ${position.rfqId} fixing is not the oracle sample`);
        continue;
      }
      if (outcome.result === "settled") {
        progress.note(position.id, outcome.txid);
        try {
          await progress.save();
        } catch (err) {
          console.error("progress save", position.rfqId, err instanceof Error ? err.message : err);
        }
        console.log("settled", position.rfqId, outcome.txid);
        return;
      }
      if (outcome.result === "mismatch") {
        once(`mismatch:${position.id}`, `skip ${position.rfqId} beacon mismatch`, true);
        continue;
      }
      if (outcome.result === "unfixed") {
        console.error(`publish ${position.expiry} unfixed`);
        continue;
      }
      if (outcome.reason === "beacon") {
        once("beacon-coin", "waiting beacon coin");
        return;
      }
      once(`wait:${position.id}:${outcome.reason}`, `waiting ${position.rfqId} ${outcome.reason}`);
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
  const initial = parseOracleBeacon(statusBody, undefined, 0, profile.hrp);
  if (initial.ok) updateBeaconFilter(initial.beacon.assetId);
} catch {
  // Oracle may not be up yet; progressDue refreshes filters once reachable.
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
