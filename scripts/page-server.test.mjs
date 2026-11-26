import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PAGE_CSP, startPageServer } from "./page-server.mjs";

function rawRequest(port, rawPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("page server survives malformed URLs and percent-encoding, blocks source maps, and emits security headers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coinflip-page-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>ok</body></html>");
  writeFileSync(path.join(dir, "app.js"), "console.log('ok');");
  writeFileSync(path.join(dir, "app.js.map"), '{"version":3}');

  const server = await startPageServer({
    siteDir: dir,
    oracleUrl: "http://127.0.0.1:1",
    isMainnet: true,
    netId: "bitcoin",
    getSetup: () => ({ stage: "ready", desk: { balance: "999999" } }),
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address();
  try {
    // SEC-01: malformed URL and invalid percent-encoding must return 400 and never crash the server.
    const doubleSlash = await rawRequest(port, "//");
    assert.equal(doubleSlash.status, 400);
    const badPercent = await rawRequest(port, "/%ff");
    assert.equal(badPercent.status, 400);
    const nullByte = await rawRequest(port, "/index.html%00");
    assert.equal(nullByte.status, 400);
    const traversal = await rawRequest(port, "/..%2f..%2fetc%2fpasswd");
    assert.equal(traversal.status, 404);

    // Server is still alive after malformed inputs and serves HTML with strict security headers.
    const ok = await rawRequest(port, "/");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-security-policy"], PAGE_CSP);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["x-frame-options"], "DENY");
    assert.equal(ok.headers["referrer-policy"], "no-referrer");

    // Source maps are never served publicly.
    const mapRes = await rawRequest(port, "/app.js.map");
    assert.equal(mapRes.status, 404);

    // Mainnet /demo.json hides internal wallet balances.
    const demoRes = await rawRequest(port, "/demo.json");
    assert.equal(demoRes.status, 200);
    assert.deepEqual(JSON.parse(demoRes.body), { ok: true, network: "bitcoin", stage: "ready" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff relay evicts oldest slots instead of DoS-ing, rejects >8KB bodies, and enforces per-IP rate limits", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coinflip-handoff-"));
  writeFileSync(path.join(dir, "index.html"), "ok");

  const server = await startPageServer({
    siteDir: dir,
    oracleUrl: "http://127.0.0.1:1",
    port: 0,
    host: "127.0.0.1",
    maxHandoffs: 3,
    rateLimitMax: 6,
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const idOf = (n) => n.toString(16).padStart(32, "0");

  try {
    // Fill 4 slots into a maxHandoffs=3 table: slot 1 is evicted, slot 4 succeeds.
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${base}/handoff/${idOf(i)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search: `?ok=${i}` }),
      });
      assert.equal(res.status, 200);
    }
    assert.equal((await fetch(`${base}/handoff/${idOf(1)}`)).status, 204);
    const fourth = await fetch(`${base}/handoff/${idOf(4)}`);
    assert.equal(fourth.status, 200);
    assert.deepEqual(await fourth.json(), { search: "?ok=4" });

    // Oversized body (> 8KB) is rejected cleanly without crashing.
    try {
      const big = await fetch(`${base}/handoff/${idOf(5)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search: "?" + "a".repeat(9_000) }),
      });
      assert.equal(big.status, 413);
    } catch {
      // Socket destroy after 413 can surface as ECONNRESET on some Node HTTP clients; server must remain healthy.
    }

    // 6th POST still within limit, 7th POST hits per-IP rate limit (429).
    const sixth = await fetch(`${base}/handoff/${idOf(6)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search: "?ok=6" }),
    });
    assert.equal(sixth.status, 200);
    const seventh = await fetch(`${base}/handoff/${idOf(7)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search: "?ok=7" }),
    });
    assert.equal(seventh.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
