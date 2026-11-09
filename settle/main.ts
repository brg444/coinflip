import { readFile } from "node:fs/promises";
import http from "node:http";

import {
  arkade,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
} from "@arkade-os/sdk";

import { ARK_URL, DEFAULT_RELAYS, EMULATOR_URL } from "../protocol/constants.ts";
import { networkByName } from "../protocol/network.ts";
import { bindContracts } from "../protocol/contracts.ts";
import type { OptionPosition } from "../protocol/messages.ts";
import { quoteRelay, watchPositions } from "../protocol/nostr.ts";
import { revision } from "../protocol/sqlite-storage.ts";
import { chooseSample } from "../oracle/store.ts";
import { fetchOraclePrices, fetchOracleStatus, parseOracleBeacon, serviceOrigin } from "./oracle.ts";
import { duePositions, manualPositions, publishOutcome, publishReady, settlementPositions, termsFor } from "./positions.ts";
import { Progress } from "./progress.ts";
import { settleQuote } from "./vault.ts";

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

const relayList = (process.env.RELAYS ?? DEFAULT_RELAYS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const relay = quoteRelay(relayList);
const positionsFile = process.env.POSITIONS?.trim() || "";
const oracleUrl = serviceOrigin(required("ORACLE_URL"));
const oracleAdmin = process.env.ORACLE_ADMIN?.trim() ?? "";
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8790");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");

const progress = await Progress.open(dataDir);
const indexer = new RestIndexerProvider(arkUrl);
const ark = new RestArkProvider(arkUrl);
const network = networkByName((await ark.getInfo()).network);
const client = await arkade.Arkade.connect({
  arkade: ark,
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  network,
});
if (!client.emulatorKey || !client.emulator) throw new Error("emulator missing");

let polling = false;
let watching = 0;
const noted = new Set<string>();

function once(key: string, line: string, error = false) {
  if (noted.has(key)) return;
  noted.add(key);
  if (error) console.error(line);
  else console.log(line);
}

const asked = new Map<number, { at: number; result: "published" | "fixed" | "failed" }>();

/** Ask once a minute. "no sample" and other failures are logged. 409 still has to match the oracle's sample. */
async function askPublish(expiry: number, nowMs: number): Promise<"published" | "fixed" | "failed"> {
  const prev = asked.get(expiry);
  if (prev && !publishReady(prev.at, nowMs)) return prev.result;
  if (!oracleAdmin) {
    once("oracle-admin", "ORACLE_ADMIN unset, so a missing fixing is not published", true);
    asked.set(expiry, { at: nowMs, result: "failed" });
    return "failed";
  }
  let result: "published" | "fixed" | "failed" = "failed";
  try {
    const res = await fetch(`${oracleUrl}/api/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${oracleAdmin}`, "content-type": "application/json" },
      body: JSON.stringify({ expiry }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = res.ok ? {} : (await res.json().catch(() => ({}))) as { error?: string };
    result = publishOutcome(res.status, body.error);
    if (result === "failed") console.error(`publish ${expiry} ${body.error ?? res.status}`);
  } catch (err) {
    console.error(`publish ${expiry} ${err instanceof Error ? err.message : err}`);
  }
  asked.set(expiry, { at: nowMs, result });
  return result;
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
  if (!progress.remember(position)) return;
  void progress.save().catch((err) => {
    console.error("progress save", err instanceof Error ? err.message : err);
  });
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

  let parsed;
  try {
    parsed = parseOracleBeacon(await fetchOracleStatus(oracleUrl, AbortSignal.timeout(10_000)));
  } catch (err) {
    once("oracle-fetch", `oracle ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  if (!parsed.ok) {
    once(`oracle-parse:${parsed.error}`, `oracle ${parsed.error}`, true);
    return;
  }
  noted.delete("oracle-fetch");

  const lag = Number(parsed.beacon.expiryLag);
  const nowMs = Date.now();
  for (const position of due) {
    if (position.expiry + lag > now) continue;
    const terms = termsFor(position, client.serverKey, client.emulatorKey!, parsed.beacon.readFee);
    if (bindContracts(terms).vaultAddress !== position.vaultAddress) {
      once(`addr:${position.id}`, `skip ${position.rfqId} vault address`, true);
      continue;
    }
    const published = await askPublish(position.expiry, nowMs);
    if (published === "failed") continue;
    let expected: { price: bigint; time: bigint } | undefined;
    if (published === "fixed") {
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
    try {
      const outcome = await settleQuote({
        chain: client.indexer!,
        serverKey: client.serverKey,
        emulatorKey: client.emulatorKey!,
        emulator: client.emulator!,
        checkpoint: client.checkpoint,
        fillTxid: position.fillTxid,
        terms,
        beacon: parsed.beacon,
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
  const url = req.url?.split("?")[0];
  if (url !== "/" && url !== "/status") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({
    commit: revision(),
    oracle: oracleUrl,
    relay,
    watching,
    settled: [...progress.ids()].length,
  }));
});

server.listen(port, () => {
  console.log(`commit ${revision()}`);
  console.log(`oracle ${oracleUrl}`);
  console.log(`relay ${relay}`);
  console.log(`status http://127.0.0.1:${port}/status`);
});

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
