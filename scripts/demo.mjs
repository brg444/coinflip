// COINFLIP demo on Mutinynet. One command runs the whole system on this
// machine: an oracle with its own beacon, a desk, a settler, and the page built
// against them, served locally and through a Cloudflare tunnel URL. The page
// and its link come up first; the page then walks through funding the oracle
// and the desk, so the rest happens in the browser.
//
//   pnpm demo                start, or resume, the demo
//   pnpm demo -- --pages     also publish the page to Cloudflare Pages (needs `wrangler login`)
//   pnpm demo -- --no-tunnel serve on http://127.0.0.1:4173 only
//
// Keys, data and logs live in ~/.coinflip-demo (COINFLIP_DEMO_DIR to move it).
// Delete that folder to start over with a new beacon and a new desk.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPublicKey } from "nostr-tools/pure";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.resolve(process.env.COINFLIP_DEMO_DIR?.trim() || path.join(os.homedir(), ".coinflip-demo"));
const args = new Set(process.argv.slice(2));
const PORTS = { oracle: 8789, desk: 8788, settler: 8790, page: 4173 };
/** The oracle issues and deploys the beacon from this. Deploy keeps 330 sats on the beacon. */
const ORACLE_FUND = 10_000n;
/** The desk funds whole payouts. One 0.0005 BTC bet at 1.90x locks 95,000 sats. */
const DESK_FUND = 1_000_000n;
const oracleUrl = `http://127.0.0.1:${PORTS.oracle}`;
const deskUrl = `http://127.0.0.1:${PORTS.desk}`;

const children = [];
let stopping = false;
/** What the page shows while the demo sets itself up. Served at /demo.json. */
const setup = {
  stage: "starting",
  oracle: { wallet: "", balance: "0", need: ORACLE_FUND.toString() },
  desk: { address: "", balance: "0", need: DESK_FUND.toString() },
  wallet: "https://mutinynet.arkade.money",
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

/** Keys are made once and kept with the demo data, never in the repo. */
function keys() {
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

function start(name, script, env) {
  const log = path.join(home, "logs", `${name}.log`);
  const out = openSync(log, "a");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-eventsource", "--no-warnings", script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", out, out],
  });
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
    ORACLE_KEY: key.oracleKey,
    ORACLE_ADMIN: key.admin,
    DATA_DIR: path.join(home, "oracle"),
    PORT: String(PORTS.oracle),
  });
  let status = await until(async () => {
    const body = (await json(`${oracleUrl}/api/status`)).body;
    return body.wallet && body;
  }, "Starting the oracle…");
  setup.oracle.wallet = status.wallet;
  setup.oracle.balance = String(status.balance ?? "0");
  if (status.deployTxid && status.assetId) return status;

  if (!status.issueTxid) {
    if (BigInt(status.balance ?? 0) < ORACLE_FUND) {
      setup.stage = "fund-oracle";
      say("");
      say(`Fund the oracle: send at least ${sats(ORACLE_FUND)} Mutinynet sats to`);
      say(`  ${status.wallet}`);
      say("The page shows this too. This waits until they arrive.");
      status = await until(async () => {
        const next = (await json(`${oracleUrl}/api/status`)).body;
        setup.oracle.balance = String(next.balance ?? "0");
        return BigInt(next.balance ?? 0) >= ORACLE_FUND && next;
      });
      say(`Oracle funded: ${sats(status.balance)} sats.`);
    }
    setup.stage = "deploying";
    const issued = await json(`${oracleUrl}/api/issue`, { method: "POST", headers: admin(key.admin), body: "{}" });
    if (!issued.ok) die(`Issuing the beacon asset failed: ${issued.body.error ?? issued.status}`);
    say(`Beacon asset issued: ${issued.body.txid ?? ""}`);
  }
  setup.stage = "deploying";
  await until(async () => {
    const deployed = await json(`${oracleUrl}/api/deploy`, { method: "POST", headers: admin(key.admin), body: "{}" });
    return deployed.ok;
  }, "Deploying the beacon…", 3_000);
  status = await until(async () => {
    const next = (await json(`${oracleUrl}/api/status`)).body;
    return next.deployTxid && next.address && next;
  });
  say(`Beacon deployed: ${status.deployTxid}`);
  return status;
}

async function deskUp(key, beacon) {
  start("desk", "desk/main.ts", {
    DESK_KEY: key.deskKey,
    BEACON_TXID: beacon.issueTxid,
    DATA_DIR: path.join(home, "desk"),
    PORT: String(PORTS.desk),
  });
  setup.stage = "desk";
  const status = await until(async () => {
    const body = (await json(`${deskUrl}/status`)).body;
    return body.pubkey && body.address && body;
  }, "Starting the desk…");
  setup.desk.address = status.address;
  setup.desk.balance = String(status.balance ?? "0");
  if (BigInt(status.balance ?? 0) < DESK_FUND / 4n) {
    say("");
    say(`Fund the desk: it pays out every winning bet, so send about ${sats(DESK_FUND)} Mutinynet sats to`);
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
function buildPage(key, beacon) {
  const config = path.join(home, "site.json");
  const status = beacon
    ? { pubkeys: beacon.pubkeys, assetId: beacon.assetId, issueTxid: beacon.issueTxid, address: beacon.address, args: beacon.args }
    : null;
  const pubkey = getPublicKey(Uint8Array.from(Buffer.from(key.deskKey, "hex")));
  writeFileSync(config, JSON.stringify({ desks: [{ name: "Demo desk", pubkey }], beacon: status, setup: true }, null, 2));
  const built = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], {
    cwd: root,
    env: { ...process.env, COINFLIP_DEMO: config, OUT_DIR: path.join(home, "site") },
    encoding: "utf8",
  });
  if (built.status !== 0) die(`The page did not build:\n${built.stderr || built.stdout}`);
}

function servePage() {
  const site = path.join(home, "site");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
  };
  return new Promise((resolve) => {
    http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/demo.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(setup));
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.join(site, rel.replace(/^\//, ""));
      if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    }).listen(PORTS.page, "127.0.0.1", resolve);
  });
}

/** A quick tunnel needs no Cloudflare account. The URL changes on every start. */
function tunnel() {
  const found = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (found.error) {
    say("cloudflared is not installed, so there is no public URL. Install it with: brew install cloudflared");
    return Promise.resolve(null);
  }
  const log = openSync(path.join(home, "logs", "tunnel.log"), "a");
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORTS.page}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve) => {
    let done = false;
    const read = (chunk) => {
      const text = chunk.toString();
      try {
        writeFileSync(log, text, { flag: "a" });
      } catch {
        // The tunnel log is a convenience.
      }
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
say(`COINFLIP demo · Mutinynet · state in ${home}`);
buildPage(key, null);
await servePage();
const publicUrl = args.has("--no-tunnel") ? null : await tunnel();
const pagesUrl = args.has("--pages") ? pages() : null;
say("");
say("Open the page. It walks you through funding the demo, then you can bet:");
say(`  Page      http://127.0.0.1:${PORTS.page}/#/predict`);
if (publicUrl) say(`  Public    ${publicUrl}/#/predict`);
if (pagesUrl) say(`  Pages     ${pagesUrl}/#/predict  (setup steps show on the local and public links)`);
say("");
const beacon = await oracleUp(key);
buildPage(key, beacon);
const desk = await deskUp(key, beacon);
settlerUp(key);
void watchSetup();

say("");
say("The demo is running.");
say(`  Page      http://127.0.0.1:${PORTS.page}/#/predict`);
if (publicUrl) say(`  Public    ${publicUrl}/#/predict`);
say(`  Oracle    ${oracleUrl}/  (admin token in ${path.join(home, "keys.json")})`);
say(`  Desk      ${deskUrl}/status  (float ${desk.address})`);
say(`  Settler   http://127.0.0.1:${PORTS.settler}/status`);
say(`  Logs      ${path.join(home, "logs")}`);
say("");
say("Ctrl-C stops everything.");
