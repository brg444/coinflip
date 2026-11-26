import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createGzip } from "node:zlib";

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const PAGE_SECURITY_HEADERS = {
  "content-security-policy": PAGE_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const MAX_BODY_BYTES = 8_000;
const MAX_RATE_KEYS = 2_000;

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...PAGE_SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body == null ? "" : JSON.stringify(body));
}

function sendText(res, status, text, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...PAGE_SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(text);
}

/**
 * Hardened HTTP handler for the public COINFLIP page, wallet handoff relay,
 * and read-only oracle proxies. Never throws on malformed URLs or percent-encoding,
 * never serves `.map` source maps, evicts oldest handoff slots instead of DoS-ing,
 * and emits strict web security headers on every response.
 */
export function createPageHandler(opts) {
  const siteRoot = path.resolve(opts.siteDir);
  const oracleUrl = opts.oracleUrl;
  const isMainnet = Boolean(opts.isMainnet);
  const netId = opts.netId ?? "mutinynet";
  const getSetup = opts.getSetup ?? (() => ({ stage: "ready" }));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const maxHandoffs = opts.maxHandoffs ?? 500;
  const handoffTtlMs = opts.handoffTtlMs ?? 10 * 60_000;
  const rateLimitMax = opts.rateLimitMax ?? 30;
  const rateLimitWindowMs = opts.rateLimitWindowMs ?? 60_000;

  const handoffs = new Map();
  const postRates = new Map();

  function clientKey(req) {
    const raw = req.socket?.remoteAddress || "unknown";
    return String(raw).slice(0, 64);
  }

  function allowHandoffPost(req, nowMs) {
    const ip = clientKey(req);
    let timestamps = postRates.get(ip);
    if (timestamps) {
      timestamps = timestamps.filter((at) => nowMs - at < rateLimitWindowMs);
      postRates.delete(ip);
    } else {
      timestamps = [];
    }
    if (timestamps.length >= rateLimitMax) {
      postRates.set(ip, timestamps);
      return false;
    }
    timestamps.push(nowMs);
    if (postRates.size >= MAX_RATE_KEYS) {
      const oldest = postRates.keys().next().value;
      if (oldest !== undefined) postRates.delete(oldest);
    }
    postRates.set(ip, timestamps);
    return true;
  }

  function pruneHandoffs(nowMs) {
    for (const [key, entry] of handoffs) {
      if (nowMs - entry.at > handoffTtlMs) handoffs.delete(key);
    }
  }

  return function handlePageRequest(req, res) {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }

    if (url.pathname === "/demo.json") {
      const setup = getSetup();
      const body = isMainnet ? { ok: true, network: netId, stage: setup.stage } : setup;
      sendJson(res, 200, body);
      return;
    }

    // The wallet's return, relayed: a home-screen app opens the wallet in Safari and the return lands
    // there. That window posts it under the request's random id; the app that asked reads it once.
    const relay = /^\/handoff\/([0-9a-f]{32})$/.exec(url.pathname);
    if (relay) {
      const id = relay[1];
      const nowMs = now();
      pruneHandoffs(nowMs);
      const reply = (status, body) => sendJson(res, status, body, { "x-handoff": "1" });
      if (req.method === "GET") {
        const entry = handoffs.get(id);
        if (!entry) return reply(204, null);
        handoffs.delete(id);
        return reply(200, { search: entry.search });
      }
      if (req.method === "POST") {
        if (!allowHandoffPost(req, nowMs)) return reply(429, { error: "rate limit" });
        let raw = "";
        let tooLarge = false;
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          if (tooLarge) return;
          raw += chunk;
          if (raw.length > MAX_BODY_BYTES) {
            tooLarge = true;
            reply(413, { error: "body" });
            req.destroy();
          }
        });
        req.on("error", () => {
          if (!res.headersSent) reply(400, { error: "body" });
        });
        req.on("end", () => {
          if (tooLarge || res.writableEnded) return;
          let search = "";
          try {
            search = String(JSON.parse(raw)?.search ?? "");
          } catch {
            return reply(400, { error: "body" });
          }
          if (!search.startsWith("?") || search.length > 6_000) return reply(400, { error: "search" });
          if (handoffs.has(id)) {
            handoffs.delete(id);
          } else if (handoffs.size >= maxHandoffs) {
            const oldest = handoffs.keys().next().value;
            if (oldest !== undefined) handoffs.delete(oldest);
          }
          handoffs.set(id, { search, at: nowMs });
          reply(200, { ok: true });
        });
        return;
      }
      return reply(405, { error: "method" });
    }

    // The oracle's canonical fixing, read-only. The oracle itself stays on loopback.
    if (url.pathname === "/oracle/fixing" && req.method === "GET") {
      const expiry = url.searchParams.get("expiry");
      if (!expiry || !/^[0-9]{1,12}$/.test(expiry)) {
        sendJson(res, 400, { error: "expiry" });
        return;
      }
      fetchImpl(`${oracleUrl}/api/fixing?expiry=${expiry}`, { signal: AbortSignal.timeout(8_000) })
        .then(async (upstream) => {
          const text = await upstream.text();
          if (res.headersSent) return;
          res.writeHead(upstream.status, {
            ...PAGE_SECURITY_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        })
        .catch(() => {
          sendJson(res, 502, { error: "oracle" });
        });
      return;
    }

    if (url.pathname === "/oracle/prices" && req.method === "GET") {
      const query = new URLSearchParams();
      for (const key of ["from", "to", "limit"]) {
        const value = url.searchParams.get(key);
        if (value != null && /^[0-9]{1,12}$/.test(value)) query.set(key, value);
      }
      fetchImpl(`${oracleUrl}/api/prices?${query}`, { signal: AbortSignal.timeout(8_000) })
        .then(async (upstream) => {
          const text = upstream.ok ? await upstream.text() : JSON.stringify({ error: "oracle" });
          if (res.headersSent) return;
          res.writeHead(upstream.ok ? 200 : 502, {
            ...PAGE_SECURITY_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        })
        .catch(() => {
          sendJson(res, 502, { error: "oracle" });
        });
      return;
    }

    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (rel.includes("\0")) {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(siteRoot, rel.replace(/^\/+/, ""));
    const ext = path.extname(file).toLowerCase();
    if (ext === ".map" || !file.startsWith(siteRoot + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      sendText(res, 404, "not found");
      return;
    }

    const hashed = (ext === ".js" || ext === ".css") && url.search.length > 1;
    const gzip = (ext === ".html" || ext === ".js" || ext === ".css") && /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
    const headers = {
      ...PAGE_SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-store",
      ...(gzip ? { "content-encoding": "gzip", vary: "Accept-Encoding" } : {}),
    };
    res.writeHead(200, headers);
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    if (gzip) {
      const gz = createGzip();
      gz.on("error", () => {
        if (!res.writableEnded) res.end();
      });
      stream.pipe(gz).pipe(res);
    } else {
      stream.pipe(res);
    }
  };
}

export function startPageServer(opts) {
  const srv = http.createServer(createPageHandler(opts));
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(srv));
  });
}
