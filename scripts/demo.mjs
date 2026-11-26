// COINFLIP demo on Mutinynet. One command runs the whole system on this
// machine: an oracle with its own beacon, a desk, a settler, and the page built
// against them, served locally and through a Cloudflare tunnel URL. The page
// and its link come up first; the page then walks through funding the oracle
// and the desk, so the rest happens in the browser.
//
//   pnpm demo                start, or resume, the demo
//   pnpm demo -- --pages     also publish the page to Cloudflare Pages (needs `wrangler login`)
//   pnpm demo -- --no-tunnel serve on http://127.0.0.1:4173 only
//   pnpm demo -- --server    run on a server: serve on 0.0.0.0:$PAGE_PORT (default
//                            4173), no tunnel, service logs on stdout as well.
//                            coinflip.Dockerfile runs this.
//
// Keys, data and logs live in ~/.coinflip-demo (COINFLIP_DEMO_DIR to move it).
// Delete that folder to start over with a new beacon and a new desk.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPublicKey } from "nostr-tools/pure";
import { startPageServer } from "./page-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.resolve(process.env.COINFLIP_DEMO_DIR?.trim() || path.join(os.homedir(), ".coinflip-demo"));
const args = new Set(process.argv.slice(2));
/** On a server the page is the only port anyone reaches; the services stay on loopback. */
const server = args.has("--server");
const rawNetwork = (process.env.NETWORK?.trim() || "mutinynet").toLowerCase();
const netId = rawNetwork === "mainnet" ? "bitcoin" : rawNetwork;
const isMainnet = netId === "bitcoin";
if (!["bitcoin", "mutinynet", "regtest", "testnet", "signet"].includes(netId)) {
  throw new Error(`Unsupported NETWORK=${rawNetwork}`);
}
const NET_LABEL = isMainnet ? "Bitcoin" : netId === "regtest" ? "Regtest" : "Mutinynet";
const WALLET_HOME = isMainnet ? "https://arkade.money" : "https://mutinynet.arkade.money";
const PORTS = { oracle: 8789, desk: 8788, settler: 8790, page: Number(process.env.PAGE_PORT?.trim() || 4173) };
/** Stateless Predict oracle needs no on-Arkade wallet funding or beacon coin. */
const ORACLE_FUND = 0n;
/** The desk funds whole payouts. */
const DESK_FUND = isMainnet ? 500_000n : 1_000_000n;
const oracleUrl = `http://127.0.0.1:${PORTS.oracle}`;
const deskUrl = `http://127.0.0.1:${PORTS.desk}`;

const children = [];
const logStreams = [];
let stopping = false;
/** What the page shows while the demo sets itself up. Served at /demo.json (minimal healthcheck on mainnet). */
const setup = {
  stage: "starting",
  oracle: { wallet: "", balance: "0", need: ORACLE_FUND.toString() },
  desk: { address: "", balance: "0", need: DESK_FUND.toString() },
  wallet: WALLET_HOME,
};

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

function die(line) {
  say(`\n${line}`);
  stop(1);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const writer of logStreams) writer.close();
  if (children.length === 0) process.exit(code);
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}
process.on("SIGINT", () => {
  say("\nStopping the demo.");
  stop(0);
});
process.on("SIGTERM", () => stop(0));

function preflight() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) die(`Node 22.12 or later is needed; this is ${process.version}.`);
  if (!existsSync(path.join(root, "node_modules", "@arkade-os", "sdk"))) die("Run pnpm install first.");
  for (const dir of ["", "oracle", "desk", "settler", "logs", "site"]) mkdirSync(path.join(home, dir), { recursive: true });
}

/** On mainnet, all secrets must come from env vars (fail closed). On Mutinynet, auto-generate once in data dir. */
function keys() {
  const envOracle = process.env.ORACLE_KEY?.trim().toLowerCase() || "";
  const envDesk = process.env.DESK_KEY?.trim().toLowerCase() || "";
  const envAdmin = process.env.ORACLE_ADMIN?.trim() || "";
  if (isMainnet) {
    if (!/^[0-9a-f]{64}$/.test(envOracle)) die("Bitcoin mainnet requires a 64-hex ORACLE_KEY env var.");
    if (!/^[0-9a-f]{64}$/.test(envDesk)) die("Bitcoin mainnet requires a 64-hex DESK_KEY env var.");
    if (envOracle === envDesk) die("ORACLE_KEY and DESK_KEY must be distinct keys on Bitcoin mainnet.");
    if (envAdmin.length < 16) die("Bitcoin mainnet requires ORACLE_ADMIN (>= 16 chars).");
    const backup = process.env.BACKUP_EMULATOR_PUBKEY?.trim().toLowerCase() || "";
    if (!/^[0-9a-f]{64}$/.test(backup)) die("Bitcoin mainnet requires a 64-hex x-only BACKUP_EMULATOR_PUBKEY env var.");
    const deskPub = getPublicKey(Uint8Array.from(Buffer.from(envDesk, "hex")));
    const oraclePub = getPublicKey(Uint8Array.from(Buffer.from(envOracle, "hex")));
    if (backup === deskPub) die("BACKUP_EMULATOR_PUBKEY must differ from DESK_KEY pubkey.");
    if (backup === oraclePub) die("BACKUP_EMULATOR_PUBKEY must differ from ORACLE_KEY pubkey.");
    return { oracleKey: envOracle, deskKey: envDesk, admin: envAdmin };
  }
  if (envOracle && envDesk && envAdmin) {
    return { oracleKey: envOracle, deskKey: envDesk, admin: envAdmin };
  }
  const file = path.join(home, "keys.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const made = {
    oracleKey: randomBytes(32).toString("hex"),
    deskKey: randomBytes(32).toString("hex"),
    admin: randomBytes(16).toString("hex"),
  };
  writeFileSync(file, JSON.stringify(made, null, 2), { mode: 0o600 });
  return made;
}

function networkEnv() {
  const extra = { NETWORK: netId };
  for (const name of ["ARK_URL", "EMULATOR_URL", "EXECUTOR_URL", "RELAYS"]) {
    const val = process.env[name]?.trim();
    if (val) extra[name] = val;
  }
  return extra;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;

function createRotatingLog(logPath, maxBytes = MAX_LOG_BYTES) {
  let written = 0;
  try {
    if (existsSync(logPath)) written = statSync(logPath).size;
  } catch {
    written = 0;
  }
  const open = () => {
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {});
    return stream;
  };
  let stream = open();
  let closed = false;
  const writer = {
    write(chunk) {
      if (closed) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      written += buf.length;
      if (written > maxBytes) {
        const prev = stream;
        prev.end();
        try {
          renameSync(logPath, `${logPath}.1`);
        } catch {
          // Best-effort rotation; continue writing to a fresh stream.
        }
        written = buf.length;
        stream = open();
      }
      stream.write(buf);
    },
    close() {
      if (closed) return;
      closed = true;
      stream.end();
    },
  };
  logStreams.push(writer);
  return writer;
}

function start(name, script, env) {
  const log = path.join(home, "logs", `${name}.log`);
  const out = server ? null : openSync(log, "a");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-eventsource", "--no-warnings", script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", server ? "pipe" : out, server ? "pipe" : out],
  });
  if (server) {
    // The host's log viewer is where a server is read, so each line goes there too.
    const writer = createRotatingLog(log);
    const relay = (stream) => {
      let rest = "";
      stream.on("data", (chunk) => {
        writer.write(chunk);
        const lines = (rest + chunk.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) say(`[${name}] ${line}`);
      });
    };
    relay(child.stdout);
    relay(child.stderr);
  }
  child.on("exit", (code) => {
    if (!stopping) die(`The ${name} stopped (exit ${code}). See ${log}`);
  });
  children.push(child);
  return child;
}

async function json(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body };
}

async function until(read, label, everyMs = 2_000) {
  let said = false;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch {
      // Not up yet.
    }
    if (!said && label) {
      say(label);
      said = true;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function admin(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const sats = (value) => BigInt(value ?? 0).toLocaleString("en-US");

async function oracleUp(key) {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(root, "oracle/page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: path.join(root, "oracle/page.js"),
    logLevel: "warning",
  });
  start("oracle", "oracle/main.ts", {
    ...networkEnv(),
    STATELESS_ORACLE: "1",
    ORACLE_KEY: key.oracleKey,
    ORACLE_ADMIN: key.admin,
    DESK_PUBKEY: getPublicKey(Uint8Array.from(Buffer.from(key.deskKey, "hex"))),
    SAMPLE_MS: "20000",
    DATA_DIR: path.join(home, "oracle"),
    PORT: String(PORTS.oracle),
  });
  const status = await until(async () => {
    const body = (await json(`${oracleUrl}/api/status`)).body;
    return Array.isArray(body.pubkeys) && body.pubkeys.length > 0 && body;
  }, "Starting the oracle…");
  setup.oracle.wallet = status.wallet ?? "";
  setup.oracle.balance = String(status.balance ?? "0");
  return status;
}

async function deskUp(key, oracle) {
  const backupPubkey = process.env.BACKUP_EMULATOR_PUBKEY?.trim().toLowerCase();
  const oraclePubkey = oracle?.pubkeys?.[0] || getPublicKey(Uint8Array.from(Buffer.from(key.oracleKey, "hex")));
  const deskEnv = {
    ...networkEnv(),
    DESK_KEY: key.deskKey,
    DESK_ADMIN: process.env.DESK_ADMIN?.trim() || key.admin,
    ORACLE_PUBKEY: oraclePubkey,
    ORACLE_URL: oracleUrl,
    ...(backupPubkey ? { BACKUP_EMULATOR_PUBKEY: backupPubkey } : {}),
    // Always-open live-spot strikes ("any"): users can bet anytime against current BTC spot on the 5-minute grid.
    DESK_LINE_MODE: process.env.DESK_LINE_MODE?.trim() || "any",
    DATA_DIR: path.join(home, "desk"),
    PORT: String(PORTS.desk),
  };
  for (const name of ["DESK_DRAIN", "DESK_STAKE_MAX", "DESK_STRIKE_CAP", "DESK_TOTAL_CAP", "DESK_EDGE", "DESK_VOL"]) {
    const val = process.env[name]?.trim();
    if (val) deskEnv[name] = val;
  }
  start("desk", "desk/main.ts", deskEnv);
  setup.stage = "desk";
  const status = await until(async () => {
    const body = (await json(`${deskUrl}/status`)).body;
    return body.pubkey && body.address && body;
  }, "Starting the desk…");
  setup.desk.address = status.address;
  setup.desk.balance = String(status.balance ?? "0");
  if (BigInt(status.balance ?? 0) < DESK_FUND / 4n) {
    say("");
    say(`Fund the desk: it pays out every winning prediction, so send about ${sats(DESK_FUND)} ${NET_LABEL} sats to`);
    say(`  ${status.address}`);
    say("The page shows this too. The desk refuses quotes it can't cover until the float lands.");
    setup.stage = "fund-desk";
  } else {
    say(`Desk float: ${sats(status.balance)} sats.`);
    setup.stage = "ready";
  }
  return status;
}

function settlerUp(key) {
  start("settler", "settle/main.ts", {
    ...networkEnv(),
    ORACLE_URL: oracleUrl,
    ORACLE_ADMIN: key.admin,
    DATA_DIR: path.join(home, "settler"),
    PORT: String(PORTS.settler),
  });
}

/**
 * The page, pinned to this desk and, once it exists, this beacon instead of
 * arkade.trade's. The desk's nostr key is known before the desk starts, so the
 * page can go up first and be rebuilt when the beacon is deployed.
 */
function buildPage(key, oracle) {
  const config = path.join(home, "site.json");
  const oraclePubkey = oracle?.pubkeys?.[0] || getPublicKey(Uint8Array.from(Buffer.from(key.oracleKey, "hex")));
  const status = oracle && oracle.issueTxid && oracle.assetId && oracle.address
    ? { pubkeys: oracle.pubkeys, assetId: oracle.assetId, issueTxid: oracle.issueTxid, address: oracle.address, args: oracle.args }
    : null;
  const pubkey = getPublicKey(Uint8Array.from(Buffer.from(key.deskKey, "hex")));
  const backupPubkey = process.env.BACKUP_EMULATOR_PUBKEY?.trim().toLowerCase();
  const stakeMax = process.env.DESK_STAKE_MAX?.trim();
  writeFileSync(
    config,
    JSON.stringify({
      network: netId,
      desks: [{ name: isMainnet ? "COINFLIP" : "Demo desk", pubkey }],
      oraclePubkey,
      beacon: status,
      setup: !isMainnet,
      ...(backupPubkey ? { backupPubkey } : {}),
      ...(stakeMax ? { stakeMax } : {}),
      ...(process.env.ARK_URL?.trim() ? { arkUrl: process.env.ARK_URL.trim() } : {}),
      ...(process.env.EMULATOR_URL?.trim() ? { emulatorUrl: process.env.EMULATOR_URL.trim() } : {}),
      ...(process.env.EXECUTOR_URL?.trim() ? { executorUrl: process.env.EXECUTOR_URL.trim() } : {}),
    }, null, 2),
  );
  const built = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], {
    cwd: root,
    env: { ...process.env, NETWORK: netId, COINFLIP_DEMO: config, OUT_DIR: path.join(home, "site") },
    encoding: "utf8",
  });
  if (built.status !== 0) die(`The page did not build:\n${built.stderr || built.stdout}`);
}

function servePage() {
  return startPageServer({
    siteDir: path.join(home, "site"),
    oracleUrl,
    isMainnet,
    netId,
    getSetup: () => setup,
    port: PORTS.page,
    host: server ? "0.0.0.0" : "127.0.0.1",
  });
}

/** A quick tunnel needs no Cloudflare account. The URL changes on every start. */
function tunnel() {
  const found = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (found.error) {
    say("cloudflared is not installed, so there is no public URL. Install it with: brew install cloudflared");
    return Promise.resolve(null);
  }
  const writer = createRotatingLog(path.join(home, "logs", "tunnel.log"));
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORTS.page}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve) => {
    let done = false;
    const read = (chunk) => {
      const text = chunk.toString();
      writer.write(chunk);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
      if (match && !done) {
        done = true;
        resolve(match[0]);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", () => {
      if (!done) resolve(null);
    });
    setTimeout(() => {
      if (!done) resolve(null);
    }, 45_000);
  });
}

function pages() {
  say("Publishing the page to Cloudflare Pages…");
  const run = spawnSync("npx", ["--yes", "wrangler", "pages", "deploy", path.join(home, "site"), "--project-name", "coinflip", "--branch", "demo", "--commit-dirty=true"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const match = /https:\/\/[a-z0-9.-]+\.pages\.dev/.exec(text);
  if (run.status !== 0 || !match) {
    say(`Cloudflare Pages did not publish. Run npx wrangler login, then try again.\n${text.trim().split("\n").slice(-6).join("\n")}`);
    return null;
  }
  return match[0];
}

/** The desk float and the oracle balance move as deposits land; the page reads them here. */
async function watchSetup() {
  for (;;) {
    try {
      const desk = (await json(`${deskUrl}/status`)).body;
      if (desk.address) {
        setup.desk.address = desk.address;
        setup.desk.balance = String(desk.balance ?? "0");
        const funded = BigInt(desk.balance ?? 0) >= DESK_FUND / 4n;
        if (setup.stage === "fund-desk" && funded) say(`Desk funded: ${sats(desk.balance)} sats. Ready to bet.`);
        setup.stage = funded ? "ready" : "fund-desk";
      }
    } catch {
      // The desk is restarting; keep the last reading.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

preflight();
const key = keys();
say(`COINFLIP · ${NET_LABEL} · state in ${home}`);
buildPage(key, null);
await servePage();
const publicUrl = server || args.has("--no-tunnel") ? null : await tunnel();
const pagesUrl = args.has("--pages") ? pages() : null;
say("");
say("Open the page. It walks you through funding the demo, then you can bet:");
say(server ? `  Page      port ${PORTS.page} on this server, at the domain the host routes to it` : `  Page      http://127.0.0.1:${PORTS.page}/#/predict`);
if (publicUrl) say(`  Public    ${publicUrl}/#/predict`);
if (pagesUrl) say(`  Pages     ${pagesUrl}/#/predict  (setup steps show on the local and public links)`);
say("");
const oracle = await oracleUp(key);
buildPage(key, oracle);
const desk = await deskUp(key, oracle);
settlerUp(key);
void watchSetup();

say("");
say("The demo is running.");
say(server ? `  Page      port ${PORTS.page}` : `  Page      http://127.0.0.1:${PORTS.page}/#/predict`);
if (publicUrl) say(`  Public    ${publicUrl}/#/predict`);
say(isMainnet ? `  Oracle    ${oracleUrl}/` : `  Oracle    ${oracleUrl}/  (admin token in ${path.join(home, "keys.json")})`);
say(`  Desk      ${deskUrl}/status  (float ${desk.address})`);
say(`  Settler   http://127.0.0.1:${PORTS.settler}/status`);
say(`  Logs      ${path.join(home, "logs")}`);
say("");
if (!server) say("Ctrl-C stops everything.");
