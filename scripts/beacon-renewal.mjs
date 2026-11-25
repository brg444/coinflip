export const DEFAULT_MAINNET_RENEW_BEFORE_S = 5 * 86_400;
export const DEFAULT_TESTNET_RENEW_BEFORE_S = 12 * 3_600;
export const MAINNET_FREE_RENEWAL_MAX_REMAINING_S = 29 * 86_400;
export const DEPRECATED_SIGNER_ALERT_S = 7 * 86_400;

async function fetchJson(fetchFn, url, init) {
  const res = await fetchFn(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body };
}

export async function emitAlert({ message, details = {}, network, alertWebhookUrl, fetchFn = fetch, logError = console.error }) {
  logError(`[ALERT] [${network}] ${message}`, Object.keys(details).length ? JSON.stringify(details) : "");
  if (!alertWebhookUrl) return;
  try {
    await fetchFn(alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "coinflip",
        network,
        level: "error",
        message,
        details,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    logError(`[ALERT] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Automates the pause -> wait -> renew -> resume sequence when `beaconExpiry` enters the renewal window.
 * Always resumes desk quoting in `finally` if this routine enabled drain.
 */
export async function checkAndRenewBeacon(opts) {
  const {
    oracleUrl,
    deskUrl,
    adminToken = "",
    oracleAdminToken = adminToken,
    deskAdminToken = adminToken,
    network = "mutinynet",
    isMainnet = network === "bitcoin",
    renewBeforeS = isMainnet ? DEFAULT_MAINNET_RENEW_BEFORE_S : DEFAULT_TESTNET_RENEW_BEFORE_S,
    waitTimeoutMs = 70 * 60_000,
    pollMs = 10_000,
    alertWebhookUrl = "",
    fetchFn = fetch,
    nowSec = () => Math.floor(Date.now() / 1000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
    logError = console.error,
  } = opts;

  const oracleHeaders = { authorization: `Bearer ${oracleAdminToken}`, "content-type": "application/json" };
  const deskHeaders = { authorization: `Bearer ${deskAdminToken}`, "content-type": "application/json" };
  const statusRes = await fetchJson(fetchFn, `${oracleUrl}/api/status`);
  if (!statusRes.ok) {
    await emitAlert({ message: `beacon renewal check failed: oracle status ${statusRes.status}`, network, alertWebhookUrl, fetchFn, logError });
    return { action: "failed", reason: `oracle status ${statusRes.status}` };
  }

  const now = nowSec();
  const deprecated = Array.isArray(statusRes.body.deprecatedSigners) ? statusRes.body.deprecatedSigners : [];
  for (const entry of deprecated) {
    const cutoff = Number(entry?.cutoffDate ?? 0);
    if (Number.isFinite(cutoff) && cutoff > now && cutoff - now <= DEPRECATED_SIGNER_ALERT_S) {
      await emitAlert({
        message: `arkd deprecated signer cutoff in ${Math.round((cutoff - now) / 3600)}h; run scripts/migrate-beacon.ts`,
        details: { pubkey: entry.pubkey, cutoffDate: entry.cutoffDate },
        network,
        alertWebhookUrl,
        fetchFn,
        logError,
      });
    }
  }

  const beaconExpiry = Number(statusRes.body.beaconExpiry ?? 0);
  if (!Number.isFinite(beaconExpiry) || beaconExpiry <= 0) {
    await emitAlert({ message: "beacon coin missing or expired (beaconExpiry=0)", network, alertWebhookUrl, fetchFn, logError });
    return { action: "alert", reason: "beacon missing" };
  }

  const remaining = beaconExpiry - now;
  if (remaining > renewBeforeS) {
    return { action: "noop", remaining };
  }
  if (isMainnet && remaining > MAINNET_FREE_RENEWAL_MAX_REMAINING_S) {
    return { action: "noop", remaining };
  }

  log(`[renew] beacon expires in ${Math.round(remaining / 3600)}h (${beaconExpiry}); pausing desk quotes for automatic renewal`);
  const deskBefore = await fetchJson(fetchFn, `${deskUrl}/status`);
  const wasDraining = Boolean(deskBefore.ok && deskBefore.body.draining);
  let enabledDrain = false;

  try {
    if (!wasDraining) {
      const pause = await fetchJson(fetchFn, `${deskUrl}/drain?enabled=1`, { method: "POST", headers: deskHeaders });
      if (!pause.ok) {
        throw new Error(`desk drain enable failed (${pause.status}: ${pause.body.error ?? "unknown"})`);
      }
      enabledDrain = true;
    }

    const deadlineMs = nowSec() * 1000 + waitTimeoutMs;
    let lastWaitReason = "open positions";
    while (nowSec() * 1000 <= deadlineMs) {
      const deskNow = await fetchJson(fetchFn, `${deskUrl}/status`);
      const liveQuotes = Number(deskNow.body?.quoteCounts?.live ?? 0);
      if (!deskNow.ok || liveQuotes > 0) {
        lastWaitReason = deskNow.ok ? `${liveQuotes} live desk quote(s)` : `desk status ${deskNow.status}`;
        await sleep(pollMs);
        continue;
      }

      const renewed = await fetchJson(fetchFn, `${oracleUrl}/api/renew`, {
        method: "POST",
        headers: oracleHeaders,
        body: "{}",
      });
      if (renewed.ok) {
        const after = await fetchJson(fetchFn, `${oracleUrl}/api/status`);
        const newExpiry = Number(after.body?.beaconExpiry ?? 0);
        log(`[renew] beacon renewed commitment=${renewed.body.commitmentTxid ?? "-"} reseed=${renewed.body.reseedTxid ?? "-"} expiry=${beaconExpiry}->${newExpiry}`);
        return {
          action: "renewed",
          oldExpiry: beaconExpiry,
          newExpiry,
          commitmentTxid: renewed.body.commitmentTxid ?? null,
          reseedTxid: renewed.body.reseedTxid ?? null,
        };
      }
      const errMsg = String(renewed.body?.error ?? renewed.status);
      if (renewed.status === 409 && (errMsg === "live vault open" || errMsg === "live position open" || errMsg === "publish in progress")) {
        lastWaitReason = errMsg;
        await sleep(pollMs);
        continue;
      }
      throw new Error(`oracle renew failed (${renewed.status}: ${errMsg})`);
    }
    throw new Error(`timed out waiting to renew beacon (${lastWaitReason})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await emitAlert({
      message: `automatic beacon renewal failed: ${reason}`,
      details: { beaconExpiry, remaining },
      network,
      alertWebhookUrl,
      fetchFn,
      logError,
    });
    return { action: "failed", reason };
  } finally {
    if (enabledDrain) {
      const resume = await fetchJson(fetchFn, `${deskUrl}/drain?enabled=0`, { method: "POST", headers: deskHeaders }).catch(() => ({ ok: false, status: 0, body: {} }));
      if (!resume.ok) {
        await emitAlert({
          message: `failed to resume desk quoting after renewal attempt (${resume.status})`,
          network,
          alertWebhookUrl,
          fetchFn,
          logError,
        });
      } else {
        log("[renew] desk quoting resumed");
      }
    }
  }
}

export function startBeaconRenewalWatcher(opts) {
  const checkEveryMs = opts.checkEveryMs ?? 15 * 60_000;
  const initialDelayMs = opts.initialDelayMs ?? 60_000;
  const retryBackoffMs = opts.retryBackoffMs ?? 30 * 60_000;
  let stopped = false;
  let timer = null;

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      let nextDelay = checkEveryMs;
      try {
        const res = await checkAndRenewBeacon(opts);
        if (res.action === "failed" || res.action === "alert") nextDelay = retryBackoffMs;
      } catch (err) {
        (opts.logError ?? console.error)("[renew] watcher error:", err instanceof Error ? err.message : String(err));
        nextDelay = retryBackoffMs;
      }
      schedule(nextDelay);
    }, delayMs);
    timer.unref?.();
  };

  schedule(initialDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
