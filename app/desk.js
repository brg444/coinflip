import {
  ACTIVE_PROFILE,
  ACTIVE_STAKE_MAX as STAKE_MAX,
  cancelIntent,
  clearAddress,
  depositAddress,
  deskPkScript,
  EXPLORER_TX_URL,
  paymentUri,
  readAddress,
  readPubkey,
  registerExecutorDelegations,
  registerIntent,
  saveAddress,
  WALLET_URL,
} from "./src/fund.ts";
import {
  callbackAllowed,
  pageCallback,
  popupHandoffMessage,
  readWalletHandoff,
  readWalletHandoffMessage,
  stripWalletParams,
  walletAppUrl,
  walletMessageTarget,
} from "./src/wallet-link.ts";
import { requestPredictQuotes } from "./src/rfq.ts";
import { btcUsdCents, deribitMultiplier, fetchSurface } from "../protocol/deribit.ts";
import {
  PREDICT_GRID_S,
  PREDICT_LOCK_S,
  PREDICT_MIN_LEFT_S,
  PREDICT_VOID_AFTER,
  QUOTE_TTL_S,
  STAKE_MIN,
} from "../protocol/constants.ts";
import { predictPayout } from "../protocol/pricing.ts";
import { openingSample, WINDOW_LINE_WITHIN_S } from "../protocol/window-line.ts";
import { parseOracleFixing } from "../protocol/oracle-client.ts";
import { PINNED_BACKUP_PUBKEY, PINNED_DESKS, PINNED_ORACLE_PUBKEY, RELAYS } from "./rfq-config.js";
import { drawMarket, drawRace, drawStep } from "./src/charts.ts";
import { startSetupWatch } from "./src/demo-setup.ts";
import {
  action,
  betIcon,
  closeGlyph,
  copyToClipboard,
  el,
  markStep,
  renderStatus,
  setFigure,
  svgEl,
  themeIcon,
  txLink,
} from "./src/dom.ts";
import { explainError } from "./src/explain.ts";
import {
  amount,
  betFault,
  capital,
  clipDetail,
  DIR,
  fmtBtc,
  int,
  lineNote,
  lineTag,
  localTime,
  mmss,
  OTHER,
  parseStake,
  parseUsd,
  shortAddress,
  timesX,
  usd0,
  usd2,
  usdFig,
  usdLine,
  usdStake,
  utcTime,
  whenDay,
  worth,
} from "./src/format.ts";
import { settlementKnown } from "./src/position-status.ts";
import { reboardVaultFromPage, refundVaultFromPage } from "./src/settle.ts";
import { addressBalance, pkScriptOf, readIntent, readKept, watchIntents } from "./src/watch.ts";

const STORE = ACTIVE_PROFILE.isMainnet ? "arkade-options-desk-mainnet-v1" : "arkade-options-desk-v1";
const REFRESH_MS = 18_000;
const WALLET_ASK = "arkade-options-wallet";

let promotedSettled = false;

const state = {
  spotCents: null,
  points: null,
  loaded: false,
  address: "",
  pubkey: "",
  /** Spendable sats at the connected address, from the indexer. */
  balance: null,
  view: "predict",
  positions: loadPositions(),
  selected: null,
  bet: {
    kind: 2,
    stake: STAKE_MAX < 50_000n ? STAKE_MAX : 50_000n,
    unit: readUnit(),
    usd: 25,
    step: 0,
    close: 0,
    open: "",
    checkout: false,
    agree: false,
    offer: null,
    quoting: false,
    quoteNote: "",
    fault: null,
  },
};

const expiring = new Set();
let walletWindow = null;

const $ = (id) => document.getElementById(id);

function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "[]");
    const rows = Array.isArray(raw) ? raw : raw.positions || [];
    return rows.map(revive);
  } catch {
    return [];
  }
}

function revive(row) {
  const position = {
    ...row,
    collateral: BigInt(row.collateral),
    premiumSats: BigInt(row.premiumSats),
    strike: BigInt(row.strike),
    expiry: BigInt(row.expiry),
  };
  if (position.status === "filled" && settlementKnown(position)) {
    position.status = "settled";
    promotedSettled = true;
  }
  return position;
}

function persist() {
  const rows = state.positions.map((p) => ({
    id: p.id,
    kind: p.kind,
    strike: p.strike.toString(),
    expiry: p.expiry.toString(),
    collateral: p.collateral.toString(),
    premiumSats: p.premiumSats.toString(),
    status: p.status,
    address: p.address,
    deadline: p.deadline,
    holderPkHex: p.holderPkHex,
    oraclePkHex: p.oraclePkHex || "",
    exit: p.exit,
    vaultAddress: p.vaultAddress,
    writerHex: p.writerHex,
    writerAddress: p.writerAddress,
    payoutAddress: p.payoutAddress,
    tenorSec: p.tenorSec || 0,
    createdAt: p.createdAt,
    refundable: Boolean(p.refundable),
    fundingTxid: p.fundingTxid || "",
    walletTxid: p.walletTxid || "",
    closeTxid: p.closeTxid || "",
    settleTxid: p.settleTxid || "",
    writerKeep: p.writerKeep || "",
    deskTake: p.deskTake || "",
    settleCents: p.settleCents || "",
    fixCents: p.fixCents || "",
    deskPkHex: p.deskPkHex || "",
    backupPkHex: p.backupPkHex || "",
    voidAfter: p.voidAfter || 0,
    fallbackDelay: p.fallbackDelay || 0,
    finalExitDelay: p.finalExitDelay || 0,
    holderAddress: p.holderAddress || "",
    holderPubkey: p.holderPubkey || "",
    placedCents: p.placedCents || "",
    windowMin: p.windowMin || 0,
    ticks: Array.isArray(p.ticks) ? p.ticks : [],
  }));
  localStorage.setItem(STORE, JSON.stringify(rows));
}

const spotUsd = () => Number(state.spotCents) / 100;

function mine(position) {
  if (position.holderAddress) return position.holderAddress === state.address;
  if (position.payoutAddress) return position.payoutAddress === state.address;
  return false;
}

const isPredict = (kind) => kind === 2 || kind === 3;

function visiblePositions() {
  return state.positions.filter((p) => isPredict(p.kind) && mine(p));
}

function pageHash(view) {
  if (view === "connect") return "#/connect";
  if (view === "home") return state.selected ? `#/positions/${state.selected}` : "#/positions";
  if (view === "how") return "#/how";
  return state.bet.kind === 3 ? "#/predict/lower" : "#/predict";
}

function routeFromHash() {
  const path = (location.hash || "#/").replace(/^#/, "");
  if (path.startsWith("/positions")) return { view: "home", id: path.slice("/positions/".length) || null };
  if (path.startsWith("/connect")) return { view: "connect" };
  if (path === "/how" || path.startsWith("/how/")) return { view: "how" };
  if (path.startsWith("/predict/lower")) return { view: "predict", kind: 3 };
  if (path.startsWith("/predict")) return { view: "predict", kind: 2 };
  return { view: "predict", kind: state.bet.kind };
}

function show(view, mode = "push") {
  if (view === "connect" && state.view !== "connect") state.backTo = state.view;
  state.view = view;
  if (view !== "home") {
    $("home").classList.remove("sheet-open");
    $("list-view").inert = false;
  }
  $("connect").hidden = view !== "connect";
  $("home").hidden = view !== "home";
  $("predict").hidden = view !== "predict";
  $("how").hidden = view !== "how";
  if (view !== "predict") {
    state.bet.open = "";
    closeBet();
  }
  const next = pageHash(view);
  if (mode !== "quiet" && location.hash !== next) {
    if (mode === "replace") history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }
  renderTop();
  syncLock();
  if (view === "home") renderBlotter();
  if (view === "predict") {
    renderPredict();
    void loadHistory();
  }
  syncIndexPolling();
  if (view === "connect") {
    $("connect-current").hidden = !state.address;
    $("connect-address").textContent = shortAddress(state.address);
    // A touch screen would raise its keyboard for the address field; most people tap Open Arkade wallet instead.
    if (window.matchMedia("(pointer: coarse)").matches) $("wallet-connect").focus({ preventScroll: true });
    else $("account-key").focus();
  }
}

function renderTop() {
  const known = Boolean(state.address);
  $("who").hidden = !known;
  $("who-address").textContent = known ? shortAddress(state.address) : "";
  $("who-tail").textContent = known ? `…${state.address.slice(-4)}` : "";
  const balance = known && state.balance != null;
  $("who-balance").hidden = !balance;
  $("who-balance").textContent = balance ? `${int(state.balance)} sats` : "";
  $("who").classList.toggle("has-balance", balance);
  $("who").setAttribute("aria-expanded", String(state.view === "connect"));
  $("top-connect").setAttribute("aria-expanded", String(state.view === "connect"));
  $("who").setAttribute("aria-label", known ? `Wallet ${shortAddress(state.address)}${balance ? `, ${int(state.balance)} sats` : ""}` : "Wallet");
  $("top-connect").hidden = known;
  const count = visiblePositions().filter((p) => liveNow(p)).length;
  $("count").hidden = !count;
  $("count").textContent = String(count);
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === state.view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

let shownId = "";

/** On a phone a position opens as a drawer over the list; on wider screens it replaces the list. */
const phoneSheets = () => window.matchMedia("(max-width: 700px)").matches;

function liveNow(p, now = Math.floor(Date.now() / 1000)) {
  return ["locking", "deposited"].includes(p.status) || (p.status === "filled" && Number(p.expiry) > now);
}

function renderBlotter() {
  const rows = visiblePositions();
  const selected = rows.find((position) => position.id === state.selected) || null;
  if (!selected) state.selected = null;
  if (state.view === "home" && location.hash !== pageHash("home")) history.replaceState(null, "", pageHash("home"));
  renderTop();
  // On a phone the send step rises as a drawer over the list; every other position is its own page.
  const sheet = Boolean(selected) && phoneSheets() && ["locking", "deposited"].includes(selected.status);
  $("list-view").hidden = Boolean(selected) && !sheet;
  $("position-view").hidden = !selected;
  $("home").classList.toggle("sheet-open", sheet);
  $("list-view").inert = sheet;
  const panel = $("pv-sheet");
  if (sheet) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
  } else {
    panel.removeAttribute("role");
    panel.removeAttribute("aria-modal");
  }
  syncLock();
  if (selected) {
    const fresh = shownId !== selected.id;
    if (fresh) $("status").textContent = "";
    shownId = selected.id;
    renderPrediction(selected);
    if (fresh && sheet) {
      panel.scrollTop = 0;
      panel.querySelector(".sheet-close")?.focus({ preventScroll: true });
    }
    if (!sheet) return;
  } else {
    shownId = "";
  }
  const host = $("blotter");
  host.replaceChildren();
  const now = Math.floor(Date.now() / 1000);
  const live = rows.filter((p) => liveNow(p, now));
  $("positions-title").textContent = live.length
    ? `${live.length} ${live.length === 1 ? "prediction" : "predictions"} in play`
    : "Your positions";
  const staked = live.reduce((sum, p) => sum + p.premiumSats, 0n);
  $("positions-sub").hidden = !live.length;
  $("positions-sub").textContent = live.length
    ? `${int(staked)} sats in${state.spotCents != null ? ` · BTC is ${usd0(spotUsd())} now` : ""}`
    : "";
  if (!rows.length) {
    host.append(el("p", "empty", state.address
      ? "No positions yet. Make a prediction and it shows up here."
      : "Connect your wallet to see your positions."));
    return;
  }
  const earlier = rows.filter((p) => !liveNow(p, now));
  for (const position of live) host.append(betRow(position));
  if (live.length && earlier.length) host.append(el("h3", "plist-head", "Earlier"));
  for (const position of earlier) host.append(betRow(position));
}

function sendClock(node) {
  const left = Number(node.dataset.until) - Math.floor(Date.now() / 1000);
  node.textContent = left > 0 ? `${mmss(left)} left to send` : "Time ran out. Checking…";
}

function canSettle(position) {
  if (position.status !== "filled") return false;
  if (!position.vaultAddress || !position.deskPkHex || !position.oraclePkHex) return false;
  const expiry = Number(position.expiry) || 0;
  if (!expiry || expiry > Math.floor(Date.now() / 1000)) return false;
  if (position.settleTxid && position.settleTxid !== position.closeTxid) return false;
  return true;
}

function canVoidRefund(position) {
  if (!canSettle(position) || !position.backupPkHex) return false;
  const after = Number(position.expiry) + Number(position.voidAfter || PREDICT_VOID_AFTER);
  return Math.floor(Date.now() / 1000) >= after;
}

async function voidRefundPosition(position, button) {
  button.disabled = true;
  button.textContent = "Refunding";
  try {
    const outcome = await refundVaultFromPage({
      ...(await fundRequest(position)),
      fillTxid: position.closeTxid || undefined,
    });
    if (outcome.result !== "refunded" && outcome.result !== "spent") {
      button.disabled = false;
      button.textContent = "Try again";
      renderStatus($("status"), "Couldn’t refund yet. Try again in a moment.", outcome.result);
      return;
    }
    position.status = "settled";
    position.settleTxid = outcome.txid;
    if (outcome.result === "refunded") {
      position.writerKeep = outcome.holder.toString();
      position.deskTake = outcome.writer.toString();
    }
    persist();
    renderBlotter();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Try again";
    renderStatus($("status"), explainError("refund", err), err instanceof Error ? err.message : "refund failed");
  }
}

function voidRefundButton(position) {
  if (!canVoidRefund(position)) return null;
  return action("btn sm quiet", "Void & refund stake", (event) => {
    void voidRefundPosition(position, event.currentTarget);
  });
}

function connectAddress() {
  try {
    state.address = saveAddress($("account-key").value);
    state.pubkey = "";
    $("account-error").textContent = "";
    $("account-key").value = "";
    show("predict");
  } catch (err) {
    $("account-error").textContent = err instanceof Error ? err.message : "That address was not saved.";
  }
}

function disconnect() {
  clearAddress();
  state.address = "";
  state.pubkey = "";
  dropBet();
  show("connect");
}

async function fundRequest(position) {
  return {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: position.premiumSats,
    expiry: position.expiry,
    deadline: BigInt(position.deadline),
    writerPkHex: position.deskPkHex,
    oraclePkHex: position.oraclePkHex || undefined,
    backupPkHex: position.backupPkHex || undefined,
    voidAfter: position.voidAfter ? BigInt(position.voidAfter) : undefined,
    fallbackDelay: position.fallbackDelay ? BigInt(position.fallbackDelay) : undefined,
    finalExitDelay: position.finalExitDelay ? BigInt(position.finalExitDelay) : undefined,
    holderAddress: position.holderAddress || position.payoutAddress,
    holderPubkey: position.holderPubkey || undefined,
    exit: position.exit != null ? BigInt(position.exit) : undefined,
  };
}

async function abortLock(position, button) {
  if (!position || position.status !== "locking") return;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Checking";
  try {
    const phase = await readIntent(watchRow(position));
    if (phase.phase !== "open") {
      applyChain(position, phase);
      renderBlotter();
      return;
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : "Could not check the deposit";
    return;
  }
  state.positions = state.positions.filter((item) => item.id !== position.id);
  if (state.selected === position.id) state.selected = null;
  persist();
  button.disabled = false;
  button.textContent = previous;
  renderBlotter();
}

const TOOK_IT = "The desk took it after all, so your prediction is live.";

async function refund(position, button) {
  button.disabled = true;
  button.textContent = "Checking";
  // The page re-renders often, so what happened goes in the status line, which stays put.
  const say = (text) => {
    if (state.selected === position.id) $("status").textContent = text;
  };
  try {
    // A fill can land after the page stopped waiting for it. Read the coin again before taking anything back.
    const before = await readIntent(watchRow(position));
    if (!before.refundable) {
      applyChain(position, before);
      say(["filled", "settled"].includes(position.status) ? TOOK_IT : "There’s nothing to take back yet. Checking again in a moment.");
      return;
    }
    button.textContent = "Taking it back";
    await cancelIntent(await fundRequest(position));
    applyChain(position, await readIntent(watchRow(position)));
    if (position.status === "refunded") say("");
  } catch (err) {
    // A refund that fails is most often a fill that landed in the meantime.
    try {
      applyChain(position, await readIntent(watchRow(position)));
    } catch {
      // Keep what we know.
    }
    say(["filled", "settled"].includes(position.status)
      ? TOOK_IT
      : explainError("cancel", err));
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "Take it back";
    }
  }
}

const CHAIN_STATUS = {
  open: "locking",
  funded: "deposited",
  expired: "expired",
  filled: "filled",
  refunded: "refunded",
};

/**
 * A fill the desk sent just before the deadline can take a few seconds to reach the indexer, and the
 * phone's clock can run ahead of the desk's. A stake that arrived therefore waits this long past the
 * deadline before the page calls it missed and offers it back.
 */
const FILL_GRACE_S = 45;

const reboarding = new Set();

async function tryReboard(position) {
  if (!isPredict(position.kind) || !position.deskPkHex || reboarding.has(position.id)) return;
  reboarding.add(position.id);
  try {
    await reboardVaultFromPage({
      ...(await fundRequest(position)),
      fillTxid: position.closeTxid || undefined,
    });
  } catch {
    reboarding.delete(position.id);
  }
}

function applyChain(position, update) {
  let next = CHAIN_STATUS[update.phase];
  if (!next) return;
  const now = Math.floor(Date.now() / 1000);
  if (next === "expired" && update.fundingTxid && now < Number(position.deadline) + FILL_GRACE_S) {
    next = "deposited";
    update = { ...update, refundable: false };
  }
  if (next === "locking" && position.status !== "locking") return;
  const fundingTxid = update.fundingTxid || position.fundingTxid || "";
  const closeTxid = update.closeTxid || position.closeTxid || "";
  const settleTxid = next === "refunded" ? "" : (update.settleTxid || position.settleTxid || "");
  const display = next === "filled" && settlementKnown({ settleTxid, closeTxid }) ? "settled" : next;
  if (update.unrolled && display === "filled") void tryReboard(position);
  const same = position.status === display
    && Boolean(position.refundable) === update.refundable
    && (position.fundingTxid || "") === fundingTxid
    && (position.closeTxid || "") === closeTxid
    && (position.settleTxid || "") === settleTxid;
  if (same) return;
  position.status = display;
  position.refundable = update.refundable;
  position.fundingTxid = fundingTxid;
  position.closeTxid = closeTxid;
  position.settleTxid = settleTxid;
  persist();
  renderBlotter();
  if (display === "settled") void fillKept();
}

function watchRow(position) {
  return {
    address: position.address,
    side: 1,
    writerAddress: position.holderAddress || position.payoutAddress || "",
    collateral: BigInt(position.collateral),
    premium: BigInt(position.premiumSats),
    deadline: Number(position.deadline),
    since: Number(position.createdAt) || 0,
    vaultAddress: position.vaultAddress || "",
  };
}

let watchAbort = null;
let watchKey = "";

function startWatch() {
  const rows = state.positions.filter((position) => isPredict(position.kind) && position.address && (position.holderAddress || position.payoutAddress) && !["refunded", "settled"].includes(position.status));
  const key = rows.map((position) => position.address).sort().join("|");
  if (key === watchKey) return;
  watchAbort?.abort();
  watchKey = key;
  if (!rows.length) return;
  const ctrl = new AbortController();
  watchAbort = ctrl;
  const watched = rows.map((position) => ({
    ...watchRow(position),
    register: async () => {
      if (!position.deskPkHex || !position.oraclePkHex) return "";
      return registerIntent(await fundRequest(position));
    },
  }));
  void watchIntents(watched, (update) => {
    const position = state.positions.find((item) => item.address === update.address);
    if (position) applyChain(position, update);
  }, ctrl.signal).catch(() => {
    if (!ctrl.signal.aborted) watchKey = "";
  });
}

function tick() {
  const now = Math.floor(Date.now() / 1000);
  document.querySelectorAll("[data-until]").forEach(sendClock);
  document.querySelectorAll("[data-close]").forEach(closeClock);
  betTick(now);
  fixingTick(now);
  windowTick(now);
  balanceTick();
  for (const position of state.positions) {
    if (!isPredict(position.kind)) continue;
    if (position.status !== "deposited" || !position.deadline || now < Number(position.deadline)) continue;
    if (!position.address || expiring.has(position.address)) continue;
    // Through the grace after the deadline, look again every few seconds rather than every tick.
    if (now - (position.checkedAt || 0) < 4) continue;
    position.checkedAt = now;
    expiring.add(position.address);
    void readIntent(watchRow(position)).then((phase) => {
      applyChain(position, phase);
    }).catch(() => undefined).finally(() => expiring.delete(position.address));
  }
}

function listen(id, type, fn) {
  const node = $(id);
  if (node) node.addEventListener(type, fn);
}

function askWallet(value) {
  try {
    sessionStorage.setItem(WALLET_ASK, value);
    return true;
  } catch {
    return false;
  }
}

function takeWalletAsk() {
  try {
    const value = sessionStorage.getItem(WALLET_ASK) || "";
    sessionStorage.removeItem(WALLET_ASK);
    return value;
  } catch {
    return "";
  }
}

function openWalletPopup(url) {
  if (walletWindow && !walletWindow.closed) {
    try {
      walletWindow.close();
    } catch {
      // The previous wallet window is already gone.
    }
  }
  walletWindow = null;
  let popup = null;
  try {
    // No `noopener`: the callback window has to see this page as `window.opener`.
    popup = window.open(url, "_blank");
  } catch {
    popup = null;
  }
  if (!popup || popup === window) return false;
  walletWindow = popup;
  return true;
}

function walletDetail(handoff) {
  const parts = [];
  if (handoff.status) parts.push(`status ${handoff.status}`);
  if (handoff.error) parts.push(handoff.error);
  return parts.join(" · ");
}

function walletSentence(kind, detail) {
  if (/popup|block/i.test(detail)) return "Allow the popup, then try again.";
  if (kind === "send-error") return "Your wallet didn’t send the BTC. Try again in a moment.";
  return "Your wallet didn’t connect. Try again in a moment.";
}

function walletError(position, sentence, detail = "") {
  if (!sentence) {
    state.bet.fault = null;
    renderStatus(position ? $("status") : state.bet.checkout ? $("bet-status") : $("account-error"), "", "");
    if (!position && state.bet.checkout) renderBetFoot();
    return;
  }
  const fault = { sentence, detail: clipDetail(detail) };
  if (position) {
    renderStatus($("status"), fault.sentence, fault.detail);
    return;
  }
  if (state.bet.checkout) {
    state.bet.fault = fault;
    renderBetFoot();
    return;
  }
  renderStatus($("account-error"), fault.sentence, fault.detail);
}

function openWallet(position) {
  if (position && position.status !== "locking") return;
  const request = position ? (position.uri || paymentUri(position.address, position.premiumSats)) : "";
  const relay = newRelayId();
  const params = position ? { flow: "send", position: position.id, relay } : { flow: "connect", relay };
  const back = pageCallback(location.href, params);
  if (!callbackAllowed(back)) {
    walletError(position, "The wallet only returns to https, or to localhost.", "callback");
    return;
  }
  const action = position ? "send" : "connect";
  const payment = request || undefined;
  const popupUrl = walletAppUrl(WALLET_URL, action, pageCallback(location.href, { ...params, popup: "1" }), payment);
  if (!askWallet(position ? position.id : "connect")) {
    walletError(position, "This browser is not keeping the wallet return. Try again in a moment.", "sessionStorage");
    return;
  }
  waitForRelay(relay, position ? position.id : "connect");
  const opened = openWalletPopup(popupUrl);
  // A home-screen app hands the link to Safari and gets no window back; the relay brings the reply.
  if (!opened && !document.documentElement.classList.contains("standalone")) {
    walletError(position, "Allow the popup, then try again.", "popup blocked");
  }
}

function applyWalletHandoff(handoff, pending) {
  if (handoff.kind === "connect" && pending === "connect") {
    try {
      state.address = saveAddress(handoff.address, handoff.pubkey);
      state.pubkey = readPubkey() || "";
      walletError(null, "");
    } catch (err) {
      walletError(null, err instanceof Error ? err.message : "That address was not saved.");
    }
    return;
  }
  if (handoff.kind === "connect-error" && pending === "connect") {
    const detail = walletDetail(handoff);
    walletError(null, walletSentence("connect-error", detail), detail || "connect error");
    return;
  }
  if (handoff.kind === "send-error" && handoff.positionId === pending) {
    const detail = walletDetail(handoff);
    const position = state.positions.find((item) => item.id === pending) ?? null;
    walletError(position, walletSentence("send-error", detail), detail || "send error");
    return;
  }
  if (handoff.kind !== "sent" || handoff.positionId !== pending || !handoff.txid) return;
  const position = state.positions.find((item) => item.id === pending);
  if (!position) return;
  position.walletTxid = handoff.txid;
  persist();
}

function showWalletHandoff(handoff) {
  renderTop();
  if (handoff.kind === "connect" && state.address) {
    if (state.bet.checkout) {
      renderBet();
      void askBet();
    } else {
      show("predict");
    }
  }
  if (handoff.kind === "sent" && handoff.txid) renderBlotter();
}

function onWalletMessage(event) {
  const target = walletMessageTarget(location.origin);
  if (!target || event.origin !== target) return;
  if (!walletWindow || event.source !== walletWindow) return;
  const handoff = readWalletHandoffMessage(event.data);
  if (!handoff) return;
  stopRelay();
  applyWalletHandoff(handoff, takeWalletAsk());
  showWalletHandoff(handoff);
  void refreshBalance();
}

function walletOpener() {
  try {
    if (!window.opener || window.opener === window) return null;
    return window.opener;
  } catch {
    return null;
  }
}

// ----- the wallet's return, wherever it lands -----
// A home-screen app opens the wallet in Safari, and the wallet's return loads there, not in the app.
// Each request carries a random relay id; whichever window the return lands in posts it to the page's
// server under that id, and the window that asked picks it up. A static host has no relay, and the
// popup and same-window returns work as before.

let relayWait = null;

function newRelayId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stopRelay() {
  if (relayWait) clearInterval(relayWait.timer);
  relayWait = null;
}

function waitForRelay(id, pending) {
  stopRelay();
  relayWait = { id, pending, until: Date.now() + 10 * 60_000, busy: false, timer: setInterval(() => void pollRelay(), 1500) };
}

async function pollRelay() {
  const wait = relayWait;
  if (!wait || wait.busy) return;
  if (Date.now() > wait.until) {
    stopRelay();
    return;
  }
  wait.busy = true;
  try {
    const res = await fetch(`handoff/${wait.id}`, { cache: "no-store" });
    if (!res.headers.get("x-handoff")) {
      stopRelay();
      return;
    }
    if (res.status !== 200) return;
    const body = await res.json();
    if (relayWait !== wait) return;
    stopRelay();
    const handoff = readWalletHandoff(typeof body?.search === "string" ? body.search : "");
    applyWalletHandoff(handoff, wait.pending);
    showWalletHandoff(handoff);
    void refreshBalance();
  } catch {
    // Try again on the next beat.
  } finally {
    wait.busy = false;
  }
}

/** This window got a return it did not ask for: hand it to the window that did, and say where to go. */
async function relayHandoff(id, search) {
  try {
    const res = await fetch(`handoff/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search }),
    });
    if (!res.ok) return;
    const note = el("p", "relay-note", "Done. Switch back to COINFLIP; it has your wallet’s reply.");
    note.setAttribute("role", "status");
    document.body.append(note);
  } catch {
    // Without a relay the app still sees a stake arrive on its own.
  }
}

let balanceAt = 0;

async function refreshBalance() {
  if (!state.address) {
    state.balance = null;
    return;
  }
  const address = state.address;
  try {
    const sats = await addressBalance(address);
    if (state.address !== address) return;
    state.balance = sats;
    balanceAt = Date.now();
    renderTop();
  } catch {
    // Keep the last balance on a failed read.
  }
}

function balanceTick() {
  if (!state.address || document.visibilityState !== "visible") return;
  if (Date.now() - balanceAt >= 15_000) {
    balanceAt = Date.now();
    void refreshBalance();
  }
}

function consumeWalletHandoff() {
  const opener = walletOpener();
  const message = popupHandoffMessage(location.search, opener != null);
  if (opener && message) {
    const target = walletMessageTarget(location.origin);
    history.replaceState(null, "", stripWalletParams(location.href));
    if (target) {
      try {
        opener.postMessage(message, target);
      } catch {
        // The opener is gone.
      }
    }
    window.close();
    return true;
  }
  const handoff = readWalletHandoff(location.search);
  const pending = takeWalletAsk();
  const relay = new URLSearchParams(location.search).get("relay") || "";
  const search = location.search;
  history.replaceState(null, "", stripWalletParams(location.href));
  if (!pending && /^[0-9a-f]{32}$/.test(relay) && handoff.kind !== "none") void relayHandoff(relay, search);
  applyWalletHandoff(handoff, pending);
  return false;
}

// ---------------------------------------------------------------------------
// Predict: an all-or-nothing call on where BTC closes, against the desk.
// The page holds and pays the stake; the desk writes and funds the payout.
// ---------------------------------------------------------------------------

const STAKES = [20_000n, 50_000n, 100_000n, 200_000n];
const USD_STAKES = [10, 25, 50, 100];
const UNIT_KEY = "coinflip-unit";

function readUnit() {
  try {
    // Read while `state` is built, before UNIT_KEY is initialised, so the key is spelled out.
    return localStorage.getItem("coinflip-unit") === "usd" ? "usd" : "btc";
  } catch {
    return "btc";
  }
}

const inUsd = () => state.bet.unit === "usd";
/** Sats for a dollar amount at the current price, to the nearest 100. */
const usdToSats = (usd) => BigInt(Math.round((usd * 1e8) / spotUsd() / 100) * 100);
/** An amount as the bet reads it: dollars at the current price, or sats and ₿. */
const inUnit = (sats) => (inUsd() ? usdFig(worth(sats, spotUsd())) : amount(sats));

/** The stake in sats. Set in dollars, it follows the price until the desk quotes it. */
function stakeSats() {
  if (!inUsd() || state.spotCents == null) return state.bet.stake;
  return usdToSats(state.bet.usd);
}

/** The stake chip's text. */
const stakeText = (stake) => (inUsd() ? usdStake(state.bet.usd) : `₿${fmtBtc(stake)}`);

/** Switch the unit and keep the bet about the same size. */
function setUnit(unit) {
  if (unit === state.bet.unit || !priced()) return;
  if (unit === "usd") {
    state.bet.usd = Math.max(1, Math.round(worth(state.bet.stake, spotUsd())));
  } else {
    state.bet.stake = stakeSats();
  }
  state.bet.unit = unit;
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {
    // The unit is a convenience; it resets to BTC without storage.
  }
  document.querySelectorAll("[data-unit]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.unit === unit));
  });
  dropBet();
  renderPredict();
}

function unitPick() {
  const seg = el("div", "seg units");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Stake in");
  for (const [unit, label] of [["btc", "BTC"], ["usd", "USD"]]) {
    const btn = el("button", "", label);
    btn.type = "button";
    btn.dataset.pick = `unit:${unit}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(state.bet.unit === unit));
    seg.append(btn);
  }
  return seg;
}
/** Lines offered around the current price, in dollars. */
const LINE_STEPS = [-100, -50, 0, 50, 100];
/** A close is offered while the 60s lock, a minute of window and the round trip still fit. */
const CLOSE_LEAD_S = PREDICT_LOCK_S + PREDICT_MIN_LEFT_S + 10;
const INDEX_MS = 2_000;
const TICKS_KEPT = 400;

let betGen = 0;
let indexTimer = null;
let ticksSavedAt = 0;
/** Index prices this page has seen, newest last: [unix, cents]. */
const seen = [];
const won = (payout) => payout;

/** The next closes on the 5-minute grid, then the quarter hours after them. */
function closes(now = Math.floor(Date.now() / 1000)) {
  const first = Math.ceil((now + CLOSE_LEAD_S) / PREDICT_GRID_S) * PREDICT_GRID_S;
  const list = [0, 1, 2].map((i) => ({ unix: first + i * PREDICT_GRID_S, min: 5 }));
  let quarter = Math.ceil((first + 3 * PREDICT_GRID_S) / 900) * 900;
  while (list.length < 5) {
    list.push({ unix: quarter, min: 15 });
    quarter += 900;
  }
  return list;
}

function betClose() {
  if (lineMode() === "window") {
    state.bet.close = currentWindow().close;
    return state.bet.close;
  }
  const list = closes();
  if (!list.some((item) => item.unix === state.bet.close)) state.bet.close = list[0].unix;
  return state.bet.close;
}

function betWindow(expiry) {
  return closes().find((item) => item.unix === Number(expiry))?.min ?? 5;
}

const priced = () => state.spotCents != null && state.points != null && lineReady();

// ----- the window's line -----
// With the oracle readable, every prediction in a five-minute window is against one line: the DIA
// oracle's first sample at or after the window opens (protocol/window-line.ts), which the desk checks.
// Only the window open now is offered; once its entries close, the page waits for the next one.
// Without the oracle the page falls back to choosing a line around the current price.

const windowLines = new Map();
const windowAsked = new Map();
let windowKey = "";

function lineMode() {
  return "pick";
}

function currentWindow(now = Math.floor(Date.now() / 1000)) {
  const open = Math.floor(now / PREDICT_GRID_S) * PREDICT_GRID_S;
  if (open + PREDICT_GRID_S - now >= CLOSE_LEAD_S) return { open, close: open + PREDICT_GRID_S, waiting: false };
  return { open: open + PREDICT_GRID_S, close: open + 2 * PREDICT_GRID_S, waiting: true };
}

function windowLine(open) {
  return windowLines.get(open) ?? null;
}

/** What the composer says while a window has no line yet, or has stopped taking predictions. */
function windowNote() {
  if (lineMode() !== "window" || state.spotCents == null || state.points == null) return "";
  const w = currentWindow();
  if (w.waiting) return `This window takes no more predictions. The next one opens at ${localTime(w.open)}, against its opening price.`;
  if (windowLine(w.open) == null) return `The ${localTime(w.open)} window just opened. Its line is the oracle’s first price, due in a few seconds.`;
  return "";
}

function lineReady() {
  if (lineMode() !== "window") return true;
  const w = currentWindow();
  return !w.waiting && windowLine(w.open) != null;
}

async function readWindowLine(open) {
  const rows = await oracleSamples(open, open + WINDOW_LINE_WITHIN_S, 200);
  if (!rows) return;
  const first = openingSample(rows.map(([time, price]) => ({ time, price })), open);
  if (!first) return;
  windowLines.set(open, first.price);
  for (const key of windowLines.keys()) if (key < open - 3600) windowLines.delete(key);
  if (state.view === "predict") renderPredict();
}

function windowTick(now) {
  if (lineMode() !== "window") return;
  const w = currentWindow(now);
  const running = Math.floor(now / PREDICT_GRID_S) * PREDICT_GRID_S;
  for (const open of new Set([w.open, running])) {
    if (open > now || windowLines.has(open)) continue;
    if (now - (windowAsked.get(open) || 0) < 3) continue;
    windowAsked.set(open, now);
    void readWindowLine(open).catch(() => undefined);
  }
  const key = `${w.open}|${w.waiting}|${windowLine(w.open) != null}`;
  if (key !== windowKey) {
    windowKey = key;
    if (state.view === "predict") {
      dropBet();
      renderPredict();
    }
  }
}
const spotDollars = () => Math.round(Number(state.spotCents) / 100);

function betTerms() {
  if (lineMode() === "window") {
    const w = currentWindow();
    const cents = w.waiting ? null : windowLine(w.open);
    return {
      kind: state.bet.kind,
      line: cents == null ? null : cents / 100,
      lineCents: cents == null ? null : BigInt(cents),
      stake: stakeSats(),
      expiry: BigInt(w.close),
      step: 0,
      window: w,
    };
  }
  const line = spotDollars() + state.bet.step;
  return {
    kind: state.bet.kind,
    line,
    lineCents: BigInt(line) * 100n,
    stake: stakeSats(),
    expiry: BigInt(betClose()),
    step: state.bet.step,
  };
}

function betMultiplier(kind, lineCents, expiry) {
  if (!priced()) return null;
  return deribitMultiplier({
    kind,
    lineCents: Number(lineCents),
    expiry: Number(expiry),
    now: Math.floor(Date.now() / 1000),
    spotCents: Number(state.spotCents),
    points: state.points,
  });
}

/** Payout, or null when the desk would not quote it. */
function betPayout(stake, multiplier) {
  if (multiplier == null) return null;
  return predictPayout(stake, multiplier);
}

const beats = (payout, stake) => payout != null && won(payout) > stake;

function closeClock(node) {
  const left = Number(node.dataset.close) - Math.floor(Date.now() / 1000);
  const text = left > 0 ? mmss(left) : "0:00";
  node.textContent = node.dataset.form === "left" ? `${text} left` : node.dataset.form === "bare" ? text : `in ${text}`;
}

function clockEl(className, unix, form = "in") {
  const node = el("span", className);
  node.dataset.close = String(unix);
  node.dataset.form = form;
  closeClock(node);
  return node;
}

function betSentenceInto(node, terms, tense, stakeLabel = `₿${fmtBtc(terms.stake)}`) {
  const lead = { now: "I predict BTC closes", past: "You predicted BTC would close", none: "You were going to predict BTC would close" }[tense];
  const last = el("span", "nb");
  last.append("with\u00a0", el("span", "chip", stakeLabel), ".");
  node.replaceChildren(
    `${lead} `,
    el("span", "chip", DIR[terms.kind]),
    " ",
    el("span", "chip", usdLine(Number(terms.lineCents) / 100)),
    " at ",
    el("span", "chip", localTime(terms.expiry)),
    " ",
    last,
  );
}

function setCall(kind, mode) {
  if (state.bet.kind !== kind) {
    state.bet.kind = kind;
    state.bet.open = "";
    closeBet();
    dropBet();
  }
  show("predict", mode);
}

function renderPredict() {
  if (state.view !== "predict") return;
  document.querySelectorAll("[data-call]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.call) === state.bet.kind));
  });
  const chip = (name) => document.querySelector(`[data-bchip="${name}"]`);
  const ok = priced();
  const windowed = lineMode() === "window";
  for (const name of ["stake", "dir", "line", "close"]) chip(name).disabled = !ok;
  const foot = document.querySelector(".predict .windows");
  if (foot) {
    foot.textContent = windowed
      ? "A window opens every five minutes, and everyone in it predicts against its opening price."
      : "A new window closes every 5 minutes. 15-minute windows close on the quarter hour.";
  }
  // A window's line and close are the window's, not choices: those chips read as terms and open nothing.
  for (const name of ["line", "close"]) {
    chip(name).classList.toggle("fixed", windowed);
    if (windowed) {
      chip(name).disabled = true;
      chip(name).removeAttribute("aria-haspopup");
      chip(name).removeAttribute("aria-expanded");
    } else {
      chip(name).setAttribute("aria-haspopup", "dialog");
    }
  }
  document.querySelectorAll("[data-unit]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.unit === state.bet.unit));
  });
  if (inUsd()) {
    chip("stake").replaceChildren(usdStake(state.bet.usd));
    chip("stake").setAttribute("aria-label", `Stake, ${usdStake(state.bet.usd)}${ok ? `, about ${int(stakeSats())} sats` : ""}`);
  } else {
    const coin = el("span", "btc", "₿");
    coin.setAttribute("aria-hidden", "true");
    chip("stake").replaceChildren(coin, fmtBtc(state.bet.stake));
    chip("stake").setAttribute("aria-label", `Stake, ${fmtBtc(state.bet.stake)} BTC`);
  }
  chip("dir").textContent = DIR[state.bet.kind];
  chip("dir").setAttribute("aria-label", `Closes ${DIR[state.bet.kind]}. Switch to ${OTHER[state.bet.kind]}`);
  const expiry = betClose();
  chip("close").replaceChildren(localTime(expiry), clockEl("delta", expiry));
  chip("close").setAttribute("aria-label", `Close, ${localTime(expiry)}, ${utcTime(expiry)}`);
  const see = $("bet-see");
  const note = $("bet-estimate");
  chip("line").classList.toggle("skel-chip", !ok);
  if (!ok) {
    chip("line").textContent = "$00,000";
    document.querySelectorAll("[data-mult]").forEach((node) => {
      node.textContent = "";
    });
    renderMarket();
    note.textContent = windowNote() || (state.loaded ? "We can’t get a fair price right now. Try again in a minute." : "Getting the current price…");
    see.disabled = true;
    see.textContent = "Review prediction";
    renderBetPop();
    renderBet();
    return;
  }
  const t = betTerms();
  if (windowed) {
    chip("line").replaceChildren(usdLine(t.line), el("span", "delta", "open"));
    chip("line").setAttribute("aria-label", `Line, ${usd2(t.line)}, the price when the ${localTime(t.window.open)} window opened`);
  } else {
    chip("line").replaceChildren(usd0(t.line), el("span", "delta", lineTag(t.step)));
    chip("line").setAttribute("aria-label", `Line, ${usd0(t.line)}, ${lineNote(t.step).toLowerCase()}`);
  }
  const m = betMultiplier(t.kind, t.lineCents, t.expiry);
  const payout = betPayout(t.stake, m);
  document.querySelectorAll("[data-mult]").forEach((node) => {
    const each = betMultiplier(Number(node.dataset.mult), t.lineCents, t.expiry);
    node.textContent = each == null ? "" : timesX(each);
  });
  renderMarket();
  const outOfRange = t.stake < STAKE_MIN || t.stake > STAKE_MAX;
  if (outOfRange) {
    note.textContent = `Stake between ${inUnit(STAKE_MIN)} and ${inUnit(STAKE_MAX)}.`;
  } else if (beats(payout, t.stake)) {
    note.replaceChildren(
      "You win about ",
      el("b", "", inUsd() ? usdFig(worth(won(payout), spotUsd())) : `${int(won(payout))} sats`),
      el("span", "est-long", `${inUsd() ? ` (${int(won(payout))} sats)` : ""} if you’re right · ${timesX(m)} your stake`),
      el("span", "est-short", ` if you’re right · ${timesX(m)}`),
    );
  } else if (m == null) {
    note.textContent = "The desk doesn’t quote this line for this close. Pick one nearer the current price.";
  } else {
    note.textContent = `This wins about ${int(won(payout))} sats, which doesn’t beat your stake. Stake more or pick a further line.`;
  }
  see.disabled = outOfRange || !beats(payout, t.stake);
  see.textContent = "Review prediction";
  renderBetPop();
  renderBet();
}

function optionRow({ pick, on, label, note, side, off, tag, until }) {
  const btn = el("button", on ? "on" : "");
  btn.type = "button";
  btn.dataset.pick = pick;
  const left = el("span", "o-l");
  const name = el("b", "", label);
  if (tag) name.append(el("i", "tag", tag));
  left.append(name);
  if (note) left.append(el("small", "", note));
  // A pair puts the figure that decides the pick on top, and its detail under it.
  const right = until
    ? clockEl("o-r", until)
    : Array.isArray(side)
      ? el("span", "o-r o-pair")
      : el("span", "o-r", side || "");
  if (!until && Array.isArray(side)) right.append(el("b", "", side[0]), el("small", "", side[1]));
  btn.append(left, right);
  if (off) {
    btn.className = "off";
    btn.setAttribute("aria-disabled", "true");
    btn.append(el("em", "", off));
  } else {
    btn.setAttribute("aria-pressed", String(on));
  }
  return btn;
}

/** The list under a chip. A choice the desk would not quote stays listed, greyed out, with the reason. */
function renderBetPop(focus = false) {
  const pop = $("bet-pop");
  document.querySelectorAll("[data-bchip][aria-haspopup]").forEach((chip) => {
    chip.setAttribute("aria-expanded", String(chip.dataset.bchip === state.bet.open));
  });
  if (!state.bet.open || state.view !== "predict" || !priced()) {
    pop.hidden = true;
    syncScrim();
    return;
  }
  const had = pop.contains(document.activeElement) ? document.activeElement.dataset.pick || document.activeElement.id : "";
  const typedBefore = $("bet-typed-input")?.value ?? "";
  const t = betTerms();
  const at = localTime(t.expiry);
  const parts = [];
  let title;
  let hint;
  if (state.bet.open === "stake") {
    title = "How much to stake?";
    hint = inUsd()
      ? `Dollars become sats at the current ${usd0(spotUsd())}; the stake is in sats from the moment the desk quotes it.`
      : `Your stake goes to the desk; the full payout locks in the vault until ${at}.`;
    const m = betMultiplier(t.kind, t.lineCents, t.expiry);
    const list = el("div", "opts");
    const choices = inUsd() ? USD_STAKES.map((usd) => [usd, usdToSats(usd)]) : STAKES.map((sats) => [null, sats]);
    for (const [usd, stake] of choices) {
      const payout = betPayout(stake, m);
      const inRange = stake >= STAKE_MIN && stake <= STAKE_MAX;
      const ok = inRange && beats(payout, stake);
      list.append(optionRow({
        pick: usd == null ? `stake:${stake}` : `usd:${usd}`,
        on: usd == null ? stake === t.stake : usd === state.bet.usd,
        label: usd == null ? `${fmtBtc(stake)} BTC` : usdStake(usd),
        note: `${int(stake)} sats`,
        side: ok ? `Win about ${inUnit(won(payout))}` : "",
        off: ok ? "" : !inRange
          ? `Stake between ${inUnit(STAKE_MIN)} and ${inUnit(STAKE_MAX)}.`
          : m == null
            ? "The desk doesn’t quote this line."
            : `Wins ${inUnit(won(payout))}, not more than you put in.`,
      }));
    }
    const typed = el("form", "typed");
    typed.id = "bet-typed";
    const label = el("label", "", "Or type an amount");
    const field = el("span", "field");
    const sign = el("span", "btc", inUsd() ? "$" : "₿");
    sign.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.id = "bet-typed-input";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = inUsd() ? String(state.bet.usd) : fmtBtc(t.stake);
    input.value = typedBefore;
    input.setAttribute("aria-describedby", "bet-typed-error");
    field.append(sign, input, el("span", "unit", inUsd() ? "USD" : "BTC"));
    label.append(field);
    const error = el("p", "error");
    error.id = "bet-typed-error";
    error.setAttribute("role", "status");
    const use = el("button", "btn sm", "Use this amount");
    use.type = "submit";
    typed.append(label, error, use);
    parts.push(unitPick(), list, typed);
  } else if (state.bet.open === "line") {
    title = "Your line";
    hint = `A ${t.kind === 2 ? "higher" : "lower"} line is less likely, so it pays more. The desk quotes your multiplier when you confirm.`;
    const list = el("div", "opts");
    for (const step of LINE_STEPS) {
      const lineCents = BigInt(spotDollars() + step) * 100n;
      const m = betMultiplier(t.kind, lineCents, t.expiry);
      const payout = betPayout(t.stake, m);
      const ok = beats(payout, t.stake);
      list.append(optionRow({
        pick: `line:${step}`,
        on: step === t.step,
        label: usd0(spotDollars() + step),
        note: lineNote(step),
        side: ok ? [timesX(m), inUsd() ? usdFig(worth(won(payout), spotUsd())) : `${int(won(payout))} sats`] : "",
        off: ok ? "" : m == null
          ? `Too ${(t.kind === 2) === (step < 0) ? "likely" : "unlikely"} for the desk to quote.`
          : `Wins ${int(won(payout))} sats, not more than you put in.`,
      }));
    }
    parts.push(list);
  } else {
    title = "When it closes";
    hint = `A new window closes every 5 minutes; 15-minute windows close on the quarter hour. The fixing is the price in that UTC minute: ${utcTime(t.expiry)}.`;
    const list = el("div", "opts");
    for (const item of closes()) {
      list.append(optionRow({
        pick: `close:${item.unix}`,
        on: item.unix === Number(t.expiry),
        label: localTime(item.unix),
        tag: `${item.min} min`,
        until: item.unix,
      }));
    }
    parts.push(el("p", "lede", "The BTC price at that minute decides it."), list);
  }
  const heading = el("p", "q", title);
  heading.id = "bet-pop-title";
  const shut = action("sheet-x", "", closeBetPop);
  shut.setAttribute("aria-label", "Close");
  shut.append(closeGlyph());
  pop.replaceChildren(shut, heading, ...parts, el("p", "hint", hint));
  pop.hidden = false;
  syncScrim();
  const chip = document.querySelector(`[data-bchip="${state.bet.open}"]`);
  pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, pop.parentElement.clientWidth - pop.offsetWidth))}px`;
  // Below the whole sentence, so the list never covers another term.
  const sentence = $("bet-sentence");
  pop.style.top = `${Math.max(chip.offsetTop + chip.offsetHeight, sentence.offsetTop + sentence.offsetHeight) + 12}px`;
  const target = had || (focus ? pop.querySelector(".on, [data-pick]")?.dataset.pick : "");
  if (target) (pop.querySelector(`[data-pick="${target}"]`) || $(target))?.focus();
}

function onBetPick(event) {
  const btn = event.target.closest("[data-pick]");
  if (!btn || btn.getAttribute("aria-disabled") === "true") return;
  const [what, value] = btn.dataset.pick.split(":");
  if (what === "unit") {
    // Switching the unit keeps the list open, now in the other unit.
    setUnit(value);
    renderBetPop();
    return;
  }
  if (what === "stake") state.bet.stake = BigInt(value);
  if (what === "usd") state.bet.usd = Number(value);
  if (what === "line") state.bet.step = Number(value);
  if (what === "close") state.bet.close = Number(value);
  const chip = document.querySelector(`[data-bchip="${state.bet.open}"]`);
  state.bet.open = "";
  dropBet();
  renderPredict();
  chip?.focus();
}

function onTypedStake(event) {
  event.preventDefault();
  const raw = $("bet-typed-input")?.value ?? "";
  const error = $("bet-typed-error");
  if (inUsd()) {
    const usd = parseUsd(raw);
    const sats = usd == null ? null : usdToSats(usd);
    if (sats == null || sats < STAKE_MIN || sats > STAKE_MAX) {
      if (error) error.textContent = `Stake between ${usdFig(Math.ceil(worth(STAKE_MIN, spotUsd()) * 100) / 100)} and ${usdFig(Math.floor(worth(STAKE_MAX, spotUsd())))}.`;
      return;
    }
    state.bet.usd = usd;
    state.bet.open = "";
    dropBet();
    renderPredict();
    document.querySelector('[data-bchip="stake"]')?.focus();
    return;
  }
  const sats = parseStake(raw);
  if (sats == null || sats < STAKE_MIN || sats > STAKE_MAX) {
    if (error) error.textContent = `Stake between ${fmtBtc(STAKE_MIN)} and ${fmtBtc(STAKE_MAX)} BTC.`;
    return;
  }
  state.bet.stake = sats;
  state.bet.open = "";
  dropBet();
  renderPredict();
  document.querySelector('[data-bchip="stake"]')?.focus();
}

function dropBet() {
  betGen += 1;
  state.bet.quoting = false;
  state.bet.offer = null;
  state.bet.quoteNote = "";
}

function syncScrim() {
  const open = state.bet.checkout && state.view === "predict";
  // On a phone a term's list is a drawer too, so it gets the same scrim to tap away.
  const picking = Boolean(state.bet.open) && state.view === "predict" && phoneSheets() && !$("bet-pop").hidden;
  $("scrim").hidden = !(open || picking);
  for (const id of ["top", "main"]) $(id).inert = open;
  syncLock();
}

function closeBetPop() {
  if (!state.bet.open) return;
  const chip = document.querySelector(`[data-bchip="${state.bet.open}"]`);
  state.bet.open = "";
  renderBetPop();
  chip?.focus({ preventScroll: true });
}

/**
 * Opened from the home screen, the app has no browser around it and so no pull-to-refresh.
 * Pulling down from the top of a page reloads it, as a browser would.
 */
function pullToReload() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  document.documentElement.classList.toggle("standalone", standalone);
  if (!standalone) return;
  const PULL = 80;
  const mark = el("div", "pull");
  mark.setAttribute("aria-hidden", "true");
  const svg = svgEl("svg", { viewBox: "0 0 20 20" });
  svg.append(svgEl("path", { d: "M16.5 10a6.5 6.5 0 1 1-1.9-4.6" }), svgEl("path", { d: "M15.2 2.6v3.2H12" }));
  mark.append(svg);
  document.body.append(mark);
  let from = null;
  let dy = 0;
  const place = (offset, turn) => {
    mark.style.transform = `translate(-50%, ${offset}px) rotate(${turn}deg)`;
  };
  const reset = () => {
    from = null;
    dy = 0;
    mark.style.transition = "transform 220ms cubic-bezier(.16, 1, .3, 1), opacity 220ms cubic-bezier(.16, 1, .3, 1)";
    mark.style.opacity = "0";
    mark.classList.remove("ready");
    place(-48, 0);
  };
  document.addEventListener("touchstart", (event) => {
    from = null;
    if (window.scrollY > 0 || event.touches.length !== 1) return;
    if (document.body.classList.contains("locked") || !$("scrim").hidden) return;
    if (event.target.closest(".scrim, .pv-scrim, .pop, .drawer, .pv-sheet, .setup-panel, .chart, input, textarea")) return;
    from = event.touches[0].clientY;
    dy = 0;
    mark.style.transition = "none";
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (from == null) return;
    if (window.scrollY > 0) {
      reset();
      return;
    }
    dy = Math.max(0, event.touches[0].clientY - from);
    const progress = Math.min(1, dy / PULL);
    mark.style.opacity = String(Math.min(1, progress * 1.4));
    mark.classList.toggle("ready", progress >= 1);
    place(-48 + Math.min(dy, PULL * 1.25) * 0.75, progress * 300);
  }, { passive: true });
  const release = () => {
    if (from == null) return;
    if (dy >= PULL) {
      from = null;
      mark.classList.add("spinning");
      location.reload();
      return;
    }
    reset();
  };
  document.addEventListener("touchend", release);
  document.addEventListener("touchcancel", reset);
}

/** Phones: a drawer follows a finger down and closes past 90px, as the wallet's do. */
function dragToClose(node, close) {
  let from = null;
  let dy = 0;
  node.addEventListener("touchstart", (event) => {
    from = null;
    if (!phoneSheets() || event.touches.length !== 1) return;
    const scroller = event.target.closest(".scroll, .pv-sheet, .pop");
    if (scroller && scroller.scrollTop > 0) return;
    if (event.target.closest("input, .chart")) return;
    from = event.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  node.addEventListener("touchmove", (event) => {
    if (from == null) return;
    dy = Math.max(0, event.touches[0].clientY - from);
    node.style.transition = "none";
    node.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : "";
  }, { passive: true });
  const end = () => {
    if (from == null) return;
    from = null;
    node.style.transition = "transform 220ms cubic-bezier(.16, 1, .3, 1)";
    node.style.transform = "";
    if (dy > 90) close();
    dy = 0;
  };
  node.addEventListener("touchend", end);
  node.addEventListener("touchcancel", end);
}

/** The page stops scrolling while a sheet is up: the bet checkout, or a position on a phone. */
function syncLock() {
  const checkout = state.bet.checkout && state.view === "predict";
  const position = state.view === "home" && $("home").classList.contains("sheet-open");
  const picking = state.view === "predict" && !$("scrim").hidden;
  document.body.classList.toggle("locked", checkout || position || picking);
}

function openBet() {
  $("bet").classList.remove("show-chart");
  $("bet-chart-fold").setAttribute("aria-expanded", "false");
  $("bet-chart-fold").firstChild.textContent = "See the details";
  state.bet.open = "";
  state.bet.checkout = true;
  state.bet.agree = false;
  state.bet.fault = null;
  dropBet();
  renderPredict();
  $("bet-change").focus();
}

function closeBet() {
  if (!state.bet.checkout) return;
  state.bet.checkout = false;
  state.bet.agree = false;
  state.bet.fault = null;
  dropBet();
  renderBet();
  if (state.view === "predict") $("bet-see").focus();
}

/** The drawer. An estimate until the box is ticked; then the desk's offer, with its terms frozen. */
function renderBet() {
  const open = state.bet.checkout && state.view === "predict" && priced();
  $("bet").hidden = !open;
  syncScrim();
  if (!open) return;
  const offer = state.bet.offer;
  const t = offer ? offer.terms : betTerms();
  const m = offer ? offer.quote.multiplier : betMultiplier(t.kind, t.lineCents, t.expiry);
  const payout = offer ? offer.quote.payout : betPayout(t.stake, m);
  const at = localTime(t.expiry);
  const line = usdLine(Number(t.lineCents) / 100);
  // In dollars, the stake reads as asked; the amounts are worth at today's price, and the sats are what is paid.
  const usd = inUsd();
  const put = usd ? `${usdStake(state.bet.usd)} (${int(t.stake)} sats)` : `${int(t.stake)} sats`;
  betSentenceInto($("bet-said"), t, "now", usd ? usdStake(state.bet.usd) : undefined);
  if (beats(payout, t.stake)) {
    $("bet-head").replaceChildren(usd || !offer ? "You win about " : "You win ", el("span", "amt", inUnit(won(payout))), " if you’re right.");
    const sub = el("span", "", usd
      ? `${int(won(payout))} sats · ₿${fmtBtc(won(payout))} at the current ${usd0(spotUsd())} · window closes `
      : `₿${fmtBtc(won(payout))} · about ${usd0(worth(won(payout), spotUsd()))} at the current ${usd0(spotUsd())} · window closes `);
    sub.append(clockEl("", t.expiry));
    $("bet-sub").replaceChildren(sub);
  } else {
    $("bet-head").textContent = "This doesn’t beat your stake.";
    $("bet-sub").textContent = m == null
      ? "The desk doesn’t quote this line for this close."
      : `It wins ${int(won(payout))} sats, not more than the ${int(t.stake)} you put in.`;
  }
  $("bet-rows-when").textContent = `If BTC at ${at} is`;
  const rows = [
    [`${capital(DIR[t.kind])} ${line}`, payout != null ? inUnit(won(payout)) : "—",
      payout != null
        ? usd
          ? `${int(won(payout))} sats · your ${usdStake(state.bet.usd)} back plus about ${usdFig(worth(won(payout) - t.stake, spotUsd()))}`
          // Sats are spelled out only when the amount above is in ₿.
          : `${won(payout) < 100_000n ? "" : `${int(won(payout))} sats · `}your ${int(t.stake)} back plus ${int(won(payout) - t.stake)}`
        : "", false],
    [`At or ${OTHER[t.kind]} ${line}`, "Nothing", `your ${put} ${usd ? "goes" : "go"} to the desk`, true],
  ];
  $("bet-rows").replaceChildren(...rows.map(([when, get, small, zero]) => {
    const row = el("div", "row");
    const value = el("span", zero ? "get zero" : "get", get);
    if (small) value.append(el("small", "", small));
    row.append(el("span", "when", when), value);
    return row;
  }));
  $("bet-agree-text").textContent = `I understand that if BTC is at or ${OTHER[t.kind]} ${line} at ${at}, I lose the ${put} I put in.`;
  $("bet-chart-title").textContent = `What you get back at ${at}`;
  drawStep($("bet-chart"), { kind: t.kind, line: Number(t.lineCents) / 100, stake: t.stake, payout: payout ?? 0n, now: t.step === 0 });
  renderBetFoot();
}

/** The button, the firm multiplier and its ring. Runs every second while the drawer is open. */
function renderBetFoot() {
  if (!state.bet.checkout) return;
  const now = Math.floor(Date.now() / 1000);
  const quote = state.bet.offer?.quote;
  const left = quote ? Math.min(quote.validUntil, quote.deadline) - now : 0;
  const firm = $("bet-firm");
  let label = "Place prediction";
  let off = false;
  let sentence = state.bet.fault?.sentence || "";
  let detail = state.bet.fault?.detail || "";
  firm.replaceChildren();
  $("bet-agree").checked = state.bet.agree;
  if (!state.address) {
    label = "Connect wallet";
  } else if (!state.bet.agree) {
    off = true;
  } else if (state.bet.quoting) {
    label = "Getting your offer…";
    off = true;
    sentence = "";
    detail = "";
  } else if (quote && left > 0) {
    const ring = el("span", "ring", `Offer holds ${mmss(left)}`);
    ring.style.setProperty("--left", String(Math.min(100, (left / QUOTE_TTL_S) * 100)));
    firm.append(el("span", "", timesX(quote.multiplier)), ring);
    sentence = "";
    detail = "";
  } else if (quote) {
    label = "Refresh offer";
    firm.append(el("span", "ring", "Offer expired"));
    sentence = "Offers hold for 30 seconds. Refresh it.";
    detail = "offer expired";
  } else if (state.bet.quoteNote) {
    label = "Try again";
    [sentence, detail] = betFault(state.bet.quoteNote, STAKE_MIN, STAKE_MAX);
  }
  const pastedWarn = $("bet-pasted-warn");
  if (pastedWarn) {
    const isPasted = Boolean(state.address && !state.pubkey);
    pastedWarn.hidden = !isPasted;
    pastedWarn.textContent = isPasted
      ? "Pasted address: payouts and automatic settlement work, but pre-fill L1 exit and emergency 2-of-2 L1 recovery require connecting your Arkade wallet."
      : "";
  }
  $("bet-confirm").textContent = label;
  $("bet-confirm").disabled = off;
  renderStatus($("bet-status"), sentence, detail);
}

/** The only desk request: sent when "I understand" is ticked, or on Refresh offer. */
async function askBet() {
  if (!state.bet.checkout || !state.bet.agree || !state.address || state.bet.quoting || !priced()) return;
  const gen = ++betGen;
  const asked = betTerms();
  state.bet.quoting = true;
  state.bet.offer = null;
  state.bet.quoteNote = "";
  renderBetFoot();
  try {
    const live = await requestPredictQuotes({
      relays: RELAYS,
      desks: PINNED_DESKS,
      kind: asked.kind,
      line: asked.lineCents,
      stake: asked.stake,
      expiry: asked.expiry,
      holderAddress: state.address,
      holderPubkey: state.pubkey || undefined,
      oraclePubkey: PINNED_ORACLE_PUBKEY,
      backupPubkey: PINNED_BACKUP_PUBKEY,
    });
    if (gen !== betGen) return;
    const quote = live.quotes[0];
    if (!quote) throw new Error(live.note || "The desk did not answer.");
    const deposit = await depositAddress({
      kind: asked.kind,
      strike: asked.lineCents,
      collateral: quote.payout,
      premium: asked.stake,
      expiry: asked.expiry,
      deadline: BigInt(quote.deadline),
      holderAddress: state.address,
      holderPubkey: state.pubkey || undefined,
      writerPkHex: quote.deskPkHex,
      oraclePkHex: quote.oraclePkHex,
      backupPkHex: quote.backupPkHex,
      voidAfter: BigInt(quote.voidAfter),
      fallbackDelay: BigInt(quote.fallbackDelay),
      finalExitDelay: BigInt(quote.finalExitDelay),
      exit: BigInt(quote.exit),
    });
    if (gen !== betGen) return;
    if (deposit.address !== quote.intentAddress || deposit.vaultAddress !== quote.vaultAddress) {
      throw new Error("The desk address does not match this page.");
    }
    state.bet.offer = { quote, deposit, terms: asked };
  } catch (err) {
    if (gen !== betGen) return;
    state.bet.quoteNote = err instanceof Error ? err.message : "The desk did not answer.";
  }
  if (gen !== betGen) return;
  state.bet.quoting = false;
  renderBet();
}

function onBetConfirm() {
  if (!state.address) {
    openWallet();
    return;
  }
  const quote = state.bet.offer?.quote;
  const now = Math.floor(Date.now() / 1000);
  if (quote && state.bet.offer.deposit && quote.validUntil > now && quote.deadline > now) placeBet();
  else void askBet();
}

/** Synchronous from the click to window.open, so the wallet popup is not blocked. */
function placeBet() {
  const { quote, deposit, terms: placed } = state.bet.offer;
  const now = Math.floor(Date.now() / 1000);
  let position = state.positions.find((item) => item.address === deposit.address && item.status === "locking");
  if (!position) {
    position = {
      id: crypto.randomUUID(),
      kind: placed.kind,
      strike: placed.lineCents,
      expiry: placed.expiry,
      collateral: quote.payout,
      premiumSats: placed.stake,
      status: "locking",
      deadline: quote.deadline,
      address: deposit.address,
      deskPkHex: quote.deskPkHex,
      oraclePkHex: quote.oraclePkHex,
      backupPkHex: quote.backupPkHex,
      voidAfter: quote.voidAfter,
      fallbackDelay: quote.fallbackDelay,
      finalExitDelay: quote.finalExitDelay,
      exit: deposit.exit,
      vaultAddress: deposit.vaultAddress,
      holderAddress: state.address,
      holderPubkey: state.pubkey || "",
      payoutAddress: state.address,
      placedCents: state.spotCents != null ? state.spotCents.toString() : "",
      windowMin: betWindow(placed.expiry),
      ticks: [],
      createdAt: now,
      uri: deposit.uri,
    };
    state.positions.unshift(position);
  }
  persist();
  closeBet();
  state.selected = position.id;
  show("home");
  startWatch();
  void fundRequest(position).then((req) => registerExecutorDelegations(req));
  openWallet(position);
}

// ----- positions -----

/**
 * The fixing is the last DIA oracle sample within 60 seconds after the close (the vault's EXPIRY_LAG).
 * From then on the oracle signs and serves that single fixing, so the page reads it through the
 * server that serves it and shows the result while the payout settles in the background.
 */
const FIXING_LAG_S = 60;
let oracleReadable = true;
const fixingReads = new Set();

async function readFixing(position) {
  const expiry = Number(position.expiry);
  const res = await fetch(`oracle/fixing?expiry=${expiry}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  const isJson = (res.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
  if (res.status === 404 && !isJson) {
    // A static host has no oracle proxy behind it; the result then arrives with the settlement.
    oracleReadable = false;
    return;
  }
  if (!res.ok) return;
  const body = await res.json();
  const expectedPk = position.oraclePkHex || PINNED_ORACLE_PUBKEY || undefined;
  const verified = parseOracleFixing(body, expectedPk);
  if (!verified || verified.expiry !== expiry) return;
  const price = verified.cents.toString();
  if (position.fixCents === price) return;
  position.fixCents = price;
  persist();
  if (state.view === "home") renderBlotter();
}

let shownStage = "";

function fixingTick(now) {
  // The open position re-renders when it crosses the close or the fixing time, not only when the chain moves.
  const open = state.view === "home" ? state.positions.find((p) => p.id === state.selected) : null;
  if (open) {
    const stage = `${open.id}|${open.status}|${now >= Number(open.expiry)}|${now >= Number(open.expiry) + FIXING_LAG_S}`;
    if (shownStage && stage !== shownStage) renderBlotter();
    shownStage = stage;
  } else {
    shownStage = "";
  }
  if (!oracleReadable) return;
  for (const p of state.positions) {
    if (!isPredict(p.kind) || p.status !== "filled" || p.settleCents || p.fixCents) continue;
    if (now < Number(p.expiry) + FIXING_LAG_S + 2 || fixingReads.has(p.id)) continue;
    if (now - (p.fixingAt || 0) < 5) continue;
    p.fixingAt = now;
    fixingReads.add(p.id);
    void readFixing(p).catch(() => undefined).finally(() => fixingReads.delete(p.id));
  }
}

/** Won or lost by the oracle's fixing, before the settlement lands. */
function provisionalOutcome(p) {
  if (p.status !== "filled" || !p.fixCents) return "";
  const fix = BigInt(p.fixCents);
  const line = BigInt(p.strike);
  return (p.kind === 2 ? fix > line : fix < line) ? "won" : "lost";
}

function betOutcome(p) {
  if (!(p.status === "settled" || settlementKnown(p))) return "";
  if (p.writerKeep === "" || p.writerKeep == null) return "settled";
  const keep = BigInt(p.writerKeep);
  const desk = p.deskTake ? BigInt(p.deskTake) : 0n;
  if (keep > 0n && desk > 0n) return "voided";
  return keep > 0n ? "won" : "lost";
}

function betStatusLabel(p) {
  const now = Math.floor(Date.now() / 1000);
  if (p.status === "locking") return p.walletTxid ? "Waiting for your BTC" : "Send your BTC";
  if (p.status === "deposited") return "Placing your prediction";
  const outcome = betOutcome(p);
  if (outcome === "won") return "Won";
  if (outcome === "lost") return "Lost";
  if (outcome === "voided") return "Voided";
  if (outcome === "settled") return "Settled";
  const early = provisionalOutcome(p);
  if (early === "won") return "Won · paying out";
  if (early === "lost") return "Lost";
  if (p.status === "filled") {
    if (Number(p.expiry) > now) return "Live";
    const fixAt = Number(p.expiry) + FIXING_LAG_S;
    return now < fixAt ? `Result at ${localTime(fixAt)}` : "Reading the fixing";
  }
  if (p.status === "expired") return "Time ran out";
  if (p.status === "refunded") return "Refunded";
  return "Open";
}

function betRow(p) {
  const row = el("a", "prow");
  row.href = `#/positions/${p.id}`;
  const icon = el("span", p.kind === 3 ? "kindico put" : "kindico");
  icon.append(betIcon(p.kind));
  const what = el("span");
  const now = Math.floor(Date.now() / 1000);
  const live = p.status === "filled" && Number(p.expiry) > now;
  const line = Number(p.strike) / 100;
  let meta = null;
  let ahead = null;
  if (live && state.spotCents != null) {
    const price = spotUsd();
    ahead = p.kind === 2 ? price > line : price < line;
    meta = price === line
      ? "On your line · the desk is ahead"
      : `${usd0(Math.abs(price - line))} ${price > line ? "above" : "below"} your line · ${ahead ? "winning so far" : "the desk is ahead"}`;
  }
  if (live) row.classList.add("live", ahead === false ? "behind" : "ahead");
  const metaEl = el("span", "m", meta ?? `Prediction · ₿${fmtBtc(p.premiumSats)}`);
  if (meta == null) metaEl.append(el("span", "win", ` · ${p.windowMin || 5}-minute window`));
  what.append(
    el("b", "", `${capital(DIR[p.kind])} ${usdLine(line)} at ${localTime(p.expiry)}`),
    metaEl,
  );
  if (live) {
    const bar = el("span", "left-bar");
    bar.dataset.barClose = String(p.expiry);
    bar.dataset.barStart = String(Number(p.createdAt) || Number(p.expiry) - 300);
    const fill = el("i");
    const start = Number(bar.dataset.barStart);
    fill.style.width = `${Math.min(100, Math.max(0, ((now - start) / Math.max(1, Number(p.expiry) - start)) * 100)).toFixed(1)}%`;
    bar.append(fill);
    what.append(bar);
  }
  const outcome = betOutcome(p);
  const side = el("span", "r");
  const early = provisionalOutcome(p);
  const shown = outcome || early;
  const pill = live ? clockEl("pill", p.expiry, "left") : el("span", shown === "won" ? "pill ok" : shown === "lost" ? "pill lost" : "pill", betStatusLabel(p));
  side.append(pill);
  let extra = "";
  if (outcome === "won") extra = `+${int(BigInt(p.writerKeep))} sats paid`;
  else if (outcome === "lost") extra = `−${int(p.premiumSats)} sats`;
  else if (outcome === "voided") extra = `${int(BigInt(p.writerKeep))} sats returned`;
  else if (early === "won") extra = `+${int(won(p.collateral))} sats`;
  else if (early === "lost") extra = `−${int(p.premiumSats)} sats`;
  else if (["locking", "deposited", "filled"].includes(p.status)) extra = `${int(p.premiumSats)} in → ${int(won(p.collateral))} if right`;
  if (extra) side.append(el("small", "", extra));
  if (live) {
    const money = el("span", "money");
    money.append(el("span", "", `${int(p.premiumSats)} in`), el("span", "", `${int(won(p.collateral))} if right`));
    side.append(money);
  }
  row.append(icon, what, side);
  return row;
}

function betLegend() {
  $("position-legend").replaceChildren(...[["p", state.spotSource === "deribit" ? "BTC price, Deribit index" : "BTC price, DIA oracle"], ["d", "Your line"], ["w", "You win"], ["k", "The desk wins"]].map(([key, text]) => {
    const item = el("span");
    item.append(el("i", key), text);
    return item;
  }));
}

function betSteps(p) {
  const list = el("ol", "steps");
  list.setAttribute("aria-label", "Progress");
  let labels;
  let at;
  if (p.status === "expired" || p.status === "refunded") {
    labels = ["Waiting for your BTC", p.status === "refunded" ? "Refunded" : "Time ran out"];
    at = 1;
  } else {
    labels = ["Waiting for your BTC", "Prediction placed", "Window closes", "Settled"];
    const now = Math.floor(Date.now() / 1000);
    at = { locking: 0, deposited: 1, filled: Number(p.expiry) > now ? 2 : 3, settled: 4 }[p.status] ?? 0;
    if (betOutcome(p)) at = 4;
  }
  labels.forEach((label, index) => {
    const item = el("li", "", label);
    if (index < at) markStep(item, "done");
    else if (index === at) markStep(item, "now", p.status !== "expired" && p.status !== "refunded");
    list.append(item);
  });
  return list;
}

function renderPrediction(p) {
  const now = Math.floor(Date.now() / 1000);
  const line = Number(p.strike) / 100;
  const lineUsd = usdLine(line);
  const at = localTime(p.expiry);
  const stake = p.premiumSats;
  const payout = p.collateral;
  const outcome = betOutcome(p);
  const unlocked = p.status === "expired" || p.status === "refunded";
  betSentenceInto($("position-sentence"), { kind: p.kind, stake, lineCents: p.strike, expiry: p.expiry }, unlocked ? "none" : "past");
  const phone = phoneSheets();
  const card = $("position-chart").parentElement;
  const grid = card.parentElement === $("position-body") ? $("pv-sheet").querySelector(".grid") : card.parentElement;
  if (card.parentElement !== grid) grid.append(card);
  let head = el("h2");
  const body = [];
  let badge = null;
  let chartAfter = null;
  let tucked = null;
  const pill = (text, className = "pill") => {
    const box = el("p", "badge");
    box.append(el("span", className, text));
    return box;
  };
  const ledger = (rows) => {
    const box = el("div", "ledger");
    for (const [name, value, className] of rows) {
      const row = el("div", className === "tot" ? "tot" : "");
      row.append(el("span", "", name), el("span", className === "minus" ? "minus" : "", value));
      box.append(row);
    }
    return box;
  };
  const fixing = p.settleCents || p.fixCents ? Number(p.settleCents || p.fixCents) / 100 : null;
  const nextClose = closes()[0].unix;
  const again = () => {
    const box = el("div", "acts");
    box.append(action("btn sm go", "Predict the next window", () => {
      state.bet.close = nextClose;
      show("predict");
    }));
    return [box, el("p", "sub", `The next window closes at ${localTime(nextClose)}.`)];
  };
  if (p.status === "locking") {
    head.textContent = p.walletTxid ? "Your wallet sent it." : "Send your stake to place the prediction.";
    body.push(el("p", "sub", p.walletTxid
      ? `Waiting for ₿${fmtBtc(stake)} to arrive. As soon as it lands, the desk locks ${int(payout)} sats in the vault.`
      : `Send ₿${fmtBtc(stake)} from your wallet. As soon as it lands, the desk locks ${int(payout)} sats in the vault.`));
    const timer = el("p", "clock");
    timer.dataset.until = String(p.deadline);
    sendClock(timer);
    const acts = el("div", "acts");
    acts.append(
      action("btn sm", "Reopen wallet", () => openWallet(p)),
      action("textbtn", "Copy payment link", (event) => {
        void copyToClipboard(event.currentTarget, p.uri || paymentUri(p.address, stake));
      }),
      action("textbtn", "Cancel", (event) => {
        void abortLock(p, event.currentTarget);
      }),
    );
    body.push(timer, acts);
  } else if (p.status === "deposited") {
    head.textContent = "Your stake arrived.";
    body.push(el("p", "sub", "The desk is funding the vault…"));
  } else if (outcome === "won") {
    const back = BigInt(p.writerKeep);
    head.replaceChildren("You won ", el("span", "amt", `${int(back)} sats`), ".");
    badge = pill(`Won · settled at ${at}`, "pill ok");
    body.push(el("p", "sub", fixing != null
      ? `The ${at} fixing was ${usd2(fixing)}, ${usd2(Math.abs(fixing - line))} ${DIR[p.kind]} your ${lineUsd} line. That’s your ${int(stake)} back plus ${int(back - stake)}.`
      : `BTC closed ${DIR[p.kind]} your ${lineUsd} line. That’s your ${int(stake)} back plus ${int(back - stake)}.`));
    body.push(ledger([
      ["You staked", `${int(stake)} sats`],
      ["From the desk", `+${int(back - stake)}`],
      ["Paid to you", `${int(back)} sats`, "tot"],
    ]));
    body.push(el("p", "sub", "Paid to your Arkade wallet. Nothing left to do."), ...again());
  } else if (outcome === "lost") {
    head.textContent = fixing != null
      ? `BTC closed ${usd2(Math.abs(fixing - line))} ${fixing === line ? "on" : OTHER[p.kind]} your line.`
      : `BTC closed at or ${OTHER[p.kind]} your line.`;
    badge = pill(`Lost · settled at ${at}`, "pill lost");
    body.push(el("p", "sub", `${fixing != null ? `The ${at} fixing was ${usd2(fixing)}. ` : ""}Your ${int(stake)} sats went to the desk.`));
    body.push(ledger([
      ["You staked", `${int(stake)} sats`],
      [`To the desk, at or ${OTHER[p.kind]} ${lineUsd}`, `−${int(stake)}`, "minus"],
      ["Paid to you", "0 sats", "tot"],
    ]));
    body.push(el("p", "sub", "One fixing decides it. All or nothing, no partial payouts."), ...again());
  } else if (outcome === "voided") {
    const back = BigInt(p.writerKeep);
    head.replaceChildren("Bet voided · ", el("span", "amt", `${int(back)} sats`), " returned.");
    badge = pill("Voided · stake returned", "pill");
    body.push(el("p", "sub", "No price fixing settled this window in time, so the vault returned your stake and sent the rest back to the desk."));
    body.push(ledger([
      ["Your stake returned", `${int(back)} sats`, "tot"],
    ]));
    body.push(...again());
  } else if (outcome === "settled") {
    head.textContent = "Settled.";
    body.push(el("p", "sub", "The vault paid out. Reading what came back…"));
  } else if (p.status === "filled" && Number(p.expiry) > now && phone) {
    // Phones: the countdown leads, then where BTC stands, then the chart.
    head = el("div", "clock-row");
    const fig = el("p", "clock-fig");
    fig.append(clockEl("big", p.expiry, "bare"), el("span", "cap", `left until the ${at} fixing`));
    head.append(fig, el("span", "pill live", "Live"));
    if (state.spotCents != null) {
      const price = spotUsd();
      const ahead = p.kind === 2 ? price > line : price < line;
      const where = price === line ? "on your line" : `${usd0(Math.abs(price - line))} ${price > line ? "above" : "below"} your line`;
      const well = el("div", "state-well");
      well.append(el("p", "", `BTC is ${usd0(price)} now, ${where}.`), el("p", ahead ? "ahead" : "behind", ahead ? "Winning so far" : "The desk is ahead so far"));
      body.push(well);
      chartAfter = well;
    } else {
      chartAfter = head;
    }
    body.push(ledger([
      ["Your stake", `${int(stake)} sats`],
      ["In the vault", `${int(payout)} sats`],
      ["If you’re right", `${int(won(payout))} sats`],
    ]));
    tucked = el("p", "sub", `Nothing for you to do. One price fixing at ${at} (${utcTime(p.expiry)}) decides it and the payout goes to your Arkade wallet. At or ${OTHER[p.kind]} ${lineUsd}, the desk wins.`);
  } else if (p.status === "filled" && Number(p.expiry) > now) {
    head.classList.add("live-clock");
    head.append(clockEl("", p.expiry, "left"));
    badge = pill(`Live · ${p.windowMin || 5}-minute window`);
    if (state.spotCents != null) {
      const price = spotUsd();
      const gap = Math.abs(price - line);
      const ahead = p.kind === 2 ? price > line : price < line;
      const where = price === line ? "on your line" : `${usd0(gap)} ${price > line ? "above" : "below"} your line`;
      body.push(el("p", "sub", `BTC is ${usd0(price)} now, ${where}, ${ahead ? "winning so far" : "the desk is ahead so far"}.`));
    }
    body.push(ledger([
      ["Your stake", `${int(stake)} sats`],
      ["In the vault", `${int(payout)} sats`],
      ["If you’re right", `${int(won(payout))} sats`],
      ["Window closes", `${at} · ${utcTime(p.expiry)}`],
    ]));
    body.push(el("p", "sub", `Nothing for you to do. One price fixing at ${at} decides it and the payout goes to your Arkade wallet. At or ${OTHER[p.kind]} ${lineUsd}, the desk wins.`));
  } else if (p.status === "filled") {
    // After the close: a countdown to the fixing, then the result straight away while the payout settles.
    const fixAt = Number(p.expiry) + FIXING_LAG_S;
    const early = provisionalOutcome(p);
    if (early === "won") {
      head.replaceChildren("You won ", el("span", "amt", `${int(won(payout))} sats`), ".");
      badge = pill("Won · paying out", "pill ok");
      body.push(el("p", "sub", `The ${at} fixing was ${usd2(fixing)}, ${usd2(Math.abs(fixing - line))} ${DIR[p.kind]} your ${lineUsd} line. The payout is on its way to your Arkade wallet; nothing for you to do.`));
      body.push(ledger([
        ["You staked", `${int(stake)} sats`],
        ["From the desk", `+${int(won(payout) - stake)}`],
        ["Paid to you", `${int(won(payout))} sats`, "tot"],
      ]));
      body.push(...again());
    } else if (early === "lost") {
      head.textContent = `BTC closed ${usd2(Math.abs(fixing - line))} ${fixing === line ? "on" : OTHER[p.kind]} your line.`;
      badge = pill(`Lost · ${at} fixing`, "pill lost");
      body.push(el("p", "sub", `The ${at} fixing was ${usd2(fixing)}. Your ${int(stake)} sats go to the desk.`));
      body.push(ledger([
        ["You staked", `${int(stake)} sats`],
        [`To the desk, at or ${OTHER[p.kind]} ${lineUsd}`, `−${int(stake)}`, "minus"],
        ["Paid to you", "0 sats", "tot"],
      ]));
      body.push(el("p", "sub", "One fixing decides it. All or nothing, no partial payouts."), ...again());
    } else if (now < fixAt) {
      head.append("Result in ", clockEl("", fixAt, "bare"));
      badge = pill(`Closed at ${at}`);
      const standing = state.spotCents != null ? (() => {
        const price = spotUsd();
        const ahead = p.kind === 2 ? price > line : price < line;
        return ` BTC is ${usd0(price)} now, ${price === line ? "on your line" : `${usd0(Math.abs(price - line))} ${price > line ? "above" : "below"} your line`}, ${ahead ? "winning so far" : "the desk is ahead so far"}.`;
      })() : "";
      body.push(el("p", "sub", `The fixing is the oracle’s last price by ${localTime(fixAt)}, and it decides the result.${standing}`));
    } else {
      head.textContent = "Reading the fixing.";
      body.push(el("p", "sub", `The oracle’s price for ${at} decides it, and the payout goes to your Arkade wallet. Nothing for you to do.`));
    }
    // A window the oracle never fixed: after its void delay anyone may return the stake (the settler does it too).
    const voidRefund = voidRefundButton(p);
    if (voidRefund || p.refundable) {
      const acts = el("div", "acts");
      if (voidRefund) acts.append(voidRefund);
      if (p.refundable) {
        acts.append(action("btn sm", "Take it back", (event) => {
          void refund(p, event.currentTarget);
        }));
      }
      body.push(acts);
    }
  } else if (p.status === "expired") {
    head.textContent = p.refundable ? "The desk didn’t take it in time." : "Time ran out before your BTC arrived.";
    body.push(el("p", "sub", p.refundable ? `Your ₿${fmtBtc(stake)} is still yours. Take it back.` : "Nothing was staked."));
    if (p.refundable) {
      const acts = el("div", "acts");
      acts.append(action("btn sm", "Take it back", (event) => {
        void refund(p, event.currentTarget);
      }));
      body.push(acts);
    }
  } else if (p.status === "refunded") {
    head.textContent = "Your stake is back in your wallet.";
    body.push(el("p", "sub", "The desk didn’t take it, so nothing was staked."));
  }
  const host = $("position-body");
  const opened = Boolean(host.querySelector("details")?.open);
  host.replaceChildren(...(badge ? [badge] : []), head, ...body);
  if (!outcome) host.append(betSteps(p));
  const txs = el("div", "txs");
  for (const [label, txid] of [
    ["Stake", p.fundingTxid],
    ["Vault tx", p.status === "refunded" ? "" : p.closeTxid],
    ["Refund", p.status === "refunded" ? p.closeTxid : ""],
    ["Payout tx", p.settleTxid && p.settleTxid !== p.closeTxid ? p.settleTxid : ""],
  ]) {
    const link = txLink(label, txid, EXPLORER_TX_URL);
    if (link) txs.append(link);
  }
  const more = el("details", "more");
  if (txs.childNodes.length && !phone) host.append(txs);
  more.open = opened;
  const facts = el("dl", "kv");
  for (const [name, value] of [
    ["Vault", p.vaultAddress],
    ["Paid to", p.holderAddress || p.payoutAddress],
    ["Price check", `DIA BTC/USD oracle, last price by ${utcTime(Number(p.expiry) + FIXING_LAG_S)} on ${whenDay(p.expiry)}`],
    ["Multiplier", timesX(payoutMultiplierOf(p))],
  ]) {
    if (value) facts.append(el("dt", "", name), el("dd", "", value));
  }
  more.append(el("summary", "", phone ? "Details and transactions" : "Details"));
  if (phone && tucked) more.append(tucked);
  if (phone && txs.childNodes.length) more.append(txs);
  more.append(facts);
  host.append(more);
  card.hidden = unlocked || p.status === "locking";
  if (card.hidden) return;
  if (phone) {
    // On a phone the chart sits in the story, under what it shows, not in a second card.
    const anchor = chartAfter || host.querySelector(":scope > h2 ~ .sub") || head;
    anchor.after(card);
  }
  const done = Boolean(outcome || provisionalOutcome(p));
  $("position-chart-title").textContent = done ? `How BTC got to ${at}` : "BTC since you placed it";
  const cap = $("position-chart-cap");
  cap.hidden = false;
  cap.textContent = done && fixing != null
    ? `One fixing decided it: ${usd2(fixing)}, ${fixing === line ? "on" : fixing > line ? "above" : "below"} your line.`
    : `${capital(DIR[p.kind])} your line when the window closes and you win.`;
  betLegend();
  drawRace($("position-chart"), {
    kind: p.kind,
    line,
    start: Number(p.createdAt) || Number(p.expiry) - 300,
    expiry: Number(p.expiry),
    ticks: p.ticks || [],
    fixing,
    now,
  });
}

function payoutMultiplierOf(p) {
  const stake = BigInt(p.premiumSats);
  return stake > 0n ? Number((BigInt(p.collateral) * 100n) / stake) / 100 : 0;
}

// ----- the index, sampled while it matters -----

function livePredictions(now) {
  return state.positions.filter((p) => isPredict(p.kind) && (p.status === "filled" || p.status === "deposited" || p.status === "locking") && Number(p.expiry) + 90 > now);
}

function syncIndexPolling() {
  const now = Math.floor(Date.now() / 1000);
  const want = state.view === "predict" || livePredictions(now).length > 0;
  if (want && !indexTimer) {
    indexTimer = setInterval(() => {
      void sampleIndex();
    }, INDEX_MS);
    void sampleIndex();
  }
  if (!want && indexTimer) {
    clearInterval(indexTimer);
    indexTimer = null;
  }
}

async function sampleIndex() {
  await loadSpot();
  if (state.spotCents == null) return;
  const now = Math.floor(Date.now() / 1000);
  const cents = Number(state.spotCents);
  seen.push([now, cents]);
  while (seen.length > TICKS_KEPT) seen.shift();
  let changed = false;
  for (const p of livePredictions(now)) {
    p.ticks = Array.isArray(p.ticks) ? p.ticks : [];
    if (!p.ticks.length) {
      for (const tick of seen) if (tick[0] >= (Number(p.createdAt) || now) - 5) p.ticks.push(tick);
    } else if (p.ticks.at(-1)[0] !== now) {
      p.ticks.push([now, cents]);
    }
    while (p.ticks.length > TICKS_KEPT) p.ticks.splice(0, 2);
    changed = true;
  }
  if (changed && Date.now() - ticksSavedAt > 15_000) {
    ticksSavedAt = Date.now();
    persist();
  }
  if (state.view === "predict" && !state.bet.open) renderPredict();
  else if (state.view === "predict") renderMarket();
  const shown = state.view === "home" && state.selected
    ? state.positions.find((p) => p.id === state.selected && isPredict(p.kind))
    : null;
  if (shown) renderPrediction(shown);
  if (!livePredictions(now).length && state.view !== "predict") syncIndexPolling();
}

function betTick(now) {
  marketClock(now);
  windowBars(now);
  if (state.view === "predict") {
    const chosen = state.bet.close;
    if (chosen && chosen < now + CLOSE_LEAD_S && !state.bet.offer) {
      betClose();
      if (state.bet.open !== "stake") renderPredict();
    }
  }
  renderBetFoot();
  if (state.view === "home" && state.selected) {
    const p = state.positions.find((item) => item.id === state.selected && isPredict(item.kind));
    if (p && p.status === "filled" && Math.abs(Number(p.expiry) - now) <= 1) renderPrediction(p);
  }
}

// ----- the market panel: the price, its last minutes, the line and the close -----

const HISTORY_URL = "https://www.deribit.com/api/v2/public/get_index_chart_data?index_name=btc_usd&range=1h";
let historyLoaded = false;

/** The last hour of prices, so the chart has a past on first paint: the oracle's, or the index's. */
async function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = await oracleSamples(now - 3600, now + 60);
    if (rows && rows.length >= 2) {
      const first = seen[0]?.[0] ?? Infinity;
      seen.unshift(...rows.filter(([time]) => time < first).slice(-(TICKS_KEPT - seen.length)));
      renderMarket();
      return;
    }
  } catch {
    // Fall back to the index history.
  }
  try {
    const res = await fetch(HISTORY_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(String(res.status));
    const rows = (await res.json()).result;
    if (!Array.isArray(rows)) throw new Error("history");
    const past = rows
      .filter((row) => Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]))
      .map(([ms, usd]) => [Math.floor(ms / 1000), Math.round(usd * 100)]);
    const first = seen[0]?.[0] ?? Infinity;
    seen.unshift(...past.filter(([t]) => t < first).slice(-(TICKS_KEPT - seen.length)));
    renderMarket();
  } catch {
    historyLoaded = false;
  }
}

function renderMarket() {
  if (state.view !== "predict") return;
  const now = Math.floor(Date.now() / 1000);
  const close = betClose();
  marketClock(now);
  if (state.spotCents == null) return;
  const price = Number(state.spotCents) / 100;
  setFigure($("mkt-price"), usd2(price));
  const offer = state.bet.offer?.terms;
  const kind = offer ? offer.kind : state.bet.kind;
  const sub = $("mkt-sub");
  const windowed = lineMode() === "window";
  sub.closest(".market")?.classList.toggle("one-line", windowed);
  if (windowed && !offer) {
    // One window at a time: the one open now, or, once its entries close, the one about to open.
    const w = currentWindow(now);
    const running = Math.floor(now / PREDICT_GRID_S) * PREDICT_GRID_S;
    const cents = !w.waiting ? windowLine(w.open) : windowLine(running);
    const shownClose = w.waiting ? running + PREDICT_GRID_S : w.close;
    $("mkt-close").textContent = w.waiting ? `Next window ${localTime(w.open)}` : `Closes ${localTime(w.close)}`;
    if (w.waiting) {
      sub.textContent = `Next window opens at ${localTime(w.open)}`;
    } else if (cents == null) {
      sub.textContent = `Setting the ${localTime(w.open)} opening price…`;
    } else {
      const gap = price - cents / 100;
      const arrow = el("span", gap >= 0 ? "up" : "down");
      arrow.setAttribute("aria-hidden", "true");
      const ahead = kind === 2 ? gap > 0 : gap < 0;
      sub.replaceChildren(arrow, el("b", "", usd2(Math.abs(gap))), ` ${gap >= 0 ? "above" : "below"} the opening price · ${ahead ? "you’re ahead" : "you’re behind"}`);
    }
    drawMarket($("mkt-chart"), {
      points: seen,
      line: cents == null ? null : cents / 100,
      kind,
      close: shownClose,
      now,
      showLine: cents != null,
      windowed: true,
      readyForFit: priced() && state.view === "predict",
    });
    return;
  }
  $("mkt-close").textContent = `Closes ${localTime(close)}`;
  const line = offer ? Number(offer.lineCents) / 100 : spotDollars() + state.bet.step;
  const gap = price - line;
  const arrow = el("span", gap >= 0 ? "up" : "down");
  arrow.setAttribute("aria-hidden", "true");
  const ahead = kind === 2 ? gap > 0 : gap < 0;
  sub.replaceChildren(arrow, el("b", "", usd2(Math.abs(gap))), ` ${gap >= 0 ? "above" : "below"} your ${usd0(line)} line${Math.abs(gap) >= 0.01 ? ` · ${ahead ? "you’d win" : "the desk would win"} now` : ""}`);
  drawMarket($("mkt-chart"), { points: seen, line, kind, close, now, windowed, readyForFit: priced() && state.view === "predict" });
}

function marketClock(now) {
  const node = $("mkt-count");
  if (!node || state.view !== "predict") return;
  // Waiting for the next window, the clock counts to its opening instead.
  const w = lineMode() === "window" ? currentWindow(now) : null;
  const left = (w?.waiting ? w.open : betClose()) - now;
  node.textContent = left > 0 ? mmss(left) : "0:00";
}

/** Live rows: the bar is how much of the window has gone. */
function windowBars(now) {
  document.querySelectorAll("[data-bar-close]").forEach((bar) => {
    const close = Number(bar.dataset.barClose);
    const start = Number(bar.dataset.barStart);
    const done = Math.min(1, Math.max(0, (now - start) / Math.max(1, close - start)));
    bar.firstElementChild.style.width = `${(done * 100).toFixed(1)}%`;
  });
}

// ----- light and dark -----

const THEME_KEY = "arkade-trade-theme";

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncTheme() {
  const theme = effectiveTheme();
  const button = $("theme");
  if (button) {
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.replaceChildren(themeIcon(theme));
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0f0d17" : "#ffffff");
}

function bindTheme() {
  syncTheme();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", syncTheme);
  listen("theme", "click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice holds for this visit.
    }
    syncTheme();
  });
}


function bindBet() {
  document.querySelectorAll("[data-call]").forEach((btn) => {
    btn.addEventListener("click", () => setCall(Number(btn.dataset.call), state.view === "predict" ? "replace" : "push"));
  });
  document.querySelectorAll("[data-bchip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (chip.dataset.bchip === "dir") {
        setCall(5 - state.bet.kind, "replace");
        chip.focus();
        return;
      }
      state.bet.open = state.bet.open === chip.dataset.bchip ? "" : chip.dataset.bchip;
      renderBetPop(true);
    });
  });
  listen("bet-pop", "click", onBetPick);
  listen("bet-pop", "submit", onTypedStake);
  listen("bet-see", "click", openBet);
  listen("bet-change", "click", closeBet);
  listen("bet-agree", "change", () => {
    state.bet.agree = $("bet-agree").checked;
    if (state.bet.agree) void askBet();
    else dropBet();
    renderBetFoot();
  });
  listen("bet-confirm", "click", onBetConfirm);
}

function bind() {
  listen("wallet-connect", "click", () => openWallet());
  listen("account-save", "click", connectAddress);
  listen("account-key", "keydown", (event) => {
    if (event.key === "Enter") connectAddress();
  });
  listen("account-change", "click", disconnect);
  // The wallet pill and Connect open the wallet page, and a second tap closes it back to where you were.
  const toggleWallet = () => show(state.view === "connect" ? (state.backTo || "predict") : "connect");
  listen("top-connect", "click", toggleWallet);
  listen("who", "click", toggleWallet);
  document.querySelectorAll("[data-unit]").forEach((btn) => {
    btn.addEventListener("click", () => setUnit(btn.dataset.unit));
  });
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "home") state.selected = null;
      show(btn.dataset.tab);
    });
  });
  document.addEventListener("click", (event) => {
    if (!state.bet.open || event.target.closest("#bet-pop, [data-bchip]")) return;
    event.preventDefault();
    event.stopPropagation();
    state.bet.open = "";
    renderBetPop();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.bet.open) {
      const chip = document.querySelector(`[data-bchip="${state.bet.open}"]`);
      state.bet.open = "";
      renderBetPop();
      chip?.focus();
      return;
    }
    if (state.bet.checkout) {
      closeBet();
      return;
    }
    if (state.view === "home" && $("home").classList.contains("sheet-open")) location.hash = "#/positions";
  });
  listen("how-start", "click", () => show("predict"));
  listen("scrim", "click", () => {
    if (state.bet.open) closeBetPop();
    else closeBet();
  });
  dragToClose($("bet-pop"), closeBetPop);
  dragToClose($("bet"), closeBet);
  dragToClose($("pv-sheet"), () => {
    if ($("home").classList.contains("sheet-open")) location.hash = "#/positions";
  });
  // Phones fold the payout chart in the checkout; it is drawn again at its real width when opened.
  listen("bet-chart-fold", "click", () => {
    const open = $("bet").classList.toggle("show-chart");
    $("bet-chart-fold").setAttribute("aria-expanded", String(open));
    $("bet-chart-fold").firstChild.textContent = open ? "Hide the details" : "See the details";
    renderBet();
  });
  bindBet();
  bindTheme();
  pullToReload();
  // The market chart is sized once the fonts are in; redraw it then.
  document.fonts?.ready.then(() => renderMarket()).catch(() => undefined);
  window.addEventListener("resize", () => {
    if (state.view === "home") renderBlotter();
    renderBet();
    renderMarket();
  });
}

function writerScriptOf(position) {
  if (position.writerScript) return position.writerScript;
  const address = position.holderAddress || position.payoutAddress;
  if (!address) return "";
  try {
    return pkScriptOf(address);
  } catch {
    return "";
  }
}

async function fillKept() {
  const rows = state.positions.filter((p) => isPredict(p.kind));
  let changed = false;
  await Promise.all(rows.map(async (position) => {
    if (position.keptChecked || position.writerKeep || !settlementKnown(position)) return;
    const script = writerScriptOf(position);
    if (!script) return;
    const deskPk = position.deskPkHex || "";
    const deskScript = deskPk ? await deskPkScript(deskPk, position.exit).catch(() => "") : "";
    const split = await readKept(position.settleTxid, script, BigInt(position.expiry), deskScript);
    if (!split) return;
    position.keptChecked = true;
    position.writerKeep = split.writer.toString();
    position.deskTake = split.desk.toString();
    if (split.cents != null && !position.settleCents) position.settleCents = split.cents.toString();
    changed = true;
  }));
  if (changed) persist();
  if (changed && state.view === "home") renderBlotter();
  if (changed && state.view === "predict") renderPredict();
}

/**
 * The price is the DIA oracle's: the feed the desk quotes on and the vault settles on, read through the
 * page's server. The oracle publishes about every 25 seconds. A host without the oracle route, or an
 * oracle gone quiet, falls back to the Deribit index and says so.
 */
const ORACLE_FRESH_S = 180;
let oracleSpotAt = 0;

async function oracleSamples(from, to, limit = 200) {
  if (!oracleReadable) return null;
  const res = await fetch(`oracle/prices?from=${from}&to=${to}&limit=${limit}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (res.status === 404) {
    oracleReadable = false;
    return null;
  }
  if (!res.ok) return null;
  const body = await res.json();
  return (Array.isArray(body?.samples) ? body.samples : [])
    .filter((s) => typeof s?.price === "string" && /^[0-9]+$/.test(s.price) && Number.isSafeInteger(s.time))
    .map((s) => [s.time, Number(s.price)])
    .sort((a, b) => a[0] - b[0]);
}

function setSource(source) {
  if (state.spotSource === source) return;
  state.spotSource = source;
  const label = $("mkt-label");
  if (label) label.textContent = source === "dia" ? "BTC · DIA oracle" : "BTC · Deribit index";
}

let oracleRead = null;

async function oracleSpot() {
  const now = Math.floor(Date.now() / 1000);
  const rows = await oracleSamples(now - ORACLE_FRESH_S, now + 60, 5);
  const last = rows?.at(-1);
  return last && now - last[0] <= ORACLE_FRESH_S ? BigInt(last[1]) : null;
}

async function loadSpot() {
  const now = Math.floor(Date.now() / 1000);
  try {
    if (oracleReadable) {
      // One read at a time, at most every five seconds; callers in between share it.
      if (!oracleRead || now - oracleSpotAt >= 5) {
        oracleSpotAt = now;
        oracleRead = oracleSpot().catch(() => null);
      }
      const cents = await oracleRead;
      if (cents != null) {
        state.spotCents = cents;
        setSource("dia");
        return;
      }
    }
  } catch {
    // Fall through to the index.
  }
  try {
    const cents = await btcUsdCents();
    if (cents != null && cents > 100_000n && cents < 1_000_000_000n) {
      state.spotCents = cents;
      setSource("deribit");
    }
  } catch {
    // Keep the last price on a failed refresh.
  }
}

async function loadPrices() {
  const [, points] = await Promise.all([loadSpot(), fetchSurface().catch(() => null)]);
  state.points = points;
  state.loaded = true;
  renderPredict();
  if (state.view === "home") renderBlotter();
}

function showFromHash(mode = "quiet") {
  const route = routeFromHash();
  if (route.view === "connect" && state.address) {
    show("predict", "replace");
    return;
  }
  if (route.view === "predict") {
    setCall(route.kind, mode);
    return;
  }
  if (route.view === "home") state.selected = route.id;
  show(route.view, mode);
}

state.address = readAddress() || "";
state.pubkey = readPubkey() || "";
window.addEventListener("message", onWalletMessage);
if (!consumeWalletHandoff()) {
  bind();
  showFromHash("replace");
  window.addEventListener("hashchange", () => showFromHash());
  void loadPrices();
  if (promotedSettled) persist();
  void fillKept();
  startWatch();
  setInterval(tick, 1000);
  setInterval(startWatch, 15_000);
  setInterval(() => {
    void loadPrices();
  }, REFRESH_MS);
  startSetupWatch({
    enabled: Boolean(typeof __COINFLIP_DEMO__ !== "undefined" && __COINFLIP_DEMO__?.setup),
    networkLabel: ACTIVE_PROFILE.label,
    defaultWalletUrl: WALLET_URL,
  });
}
