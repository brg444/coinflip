import {
  btcAmount,
  cancelIntent,
  clearAddress,
  depositAddress,
  legacyWriterHex,
  paymentUri,
  readAddress,
  registerIntent,
  saveAddress,
  WALLET_URL,
  writerPayoutAddress,
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
import { requestPredictQuotes, requestQuotes } from "./src/rfq.ts";
import { btcUsdCents, deribitMultiplier, deribitPremium, fetchSurface } from "../protocol/deribit.ts";
import {
  BEACON_READ_FEE,
  isPredict,
  PREDICT_GRID_S,
  PREDICT_LOCK_S,
  PREDICT_MIN_LEFT_S,
  QUOTE_TTL_S,
  STAKE_MAX,
  STAKE_MIN,
} from "../protocol/constants.ts";
import { predictPayout, quotedPremium } from "../protocol/pricing.ts";
import { bestQuote } from "./quote.js";
import { PINNED_DESKS, RELAYS } from "./rfq-config.js";
import { holderPayoff, settlementOutputs } from "./settle-math.js";
import { settlementKnown, usdFromCents } from "./src/position-status.ts";
import { restoreVault } from "./src/restore.ts";
import { settleFromPage } from "./src/settle.ts";
import { pkScriptOf, readIntent, readKept, watchIntents } from "./src/watch.ts";

const STORE = "arkade-options-desk-v1";
const REFRESH_MS = 18_000;
const WALLET_ASK = "arkade-options-wallet";
// `?test` adds 0.0098 BTC, which a 1,000,000-sat test wallet can lock. The 10-minute
// date and the line at today's price are on the normal quote. The line is set once,
// so a price refresh does not move it. Only that date is lifted above the read fee.
const TEST = new URLSearchParams(location.search).has("test");
const SIZES = [200_000n, 500_000n, ...(TEST ? [980_000n] : []), 1_000_000n, 2_000_000n];
let testLine = 0;
const VERBS = {
  now: ["I’ll lock", "give up gains above", "take the loss below"],
  ing: ["You’re locking", "giving up gains above", "taking the loss below"],
  past: ["You locked", "gave up gains above", "took the loss below"],
  none: ["You were going to lock", "give up gains above", "take the loss below"],
};

let promotedSettled = false;

const state = {
  spotCents: null,
  points: null,
  loaded: false,
  address: "",
  kind: 0,
  size: 1_000_000n,
  date: 0,
  tenorSec: 0,
  lines: { 0: 0, 1: 0 },
  open: "",
  view: "predict",
  checkout: false,
  agree: false,
  offer: null,
  quoteNote: "",
  quoting: false,
  walletFault: null,
  positions: loadPositions(),
  restored: [],
  selected: null,
  /** Predict: what the sentence says, and the drawer's offer. */
  bet: {
    kind: 2,
    stake: 50_000n,
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

let quoteGen = 0;
let restoreKind = 0;
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
    beaconTxid: p.beaconTxid,
    beaconGidx: p.beaconGidx,
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
    deskPkHex: p.deskPkHex || "",
    holderAddress: p.holderAddress || "",
    placedCents: p.placedCents || "",
    windowMin: p.windowMin || 0,
    ticks: Array.isArray(p.ticks) ? p.ticks : [],
  }));
  localStorage.setItem(STORE, JSON.stringify(rows));
}

function fmtBtc(sats) {
  const neg = sats < 0n;
  const body = btcAmount(neg ? -sats : sats);
  return neg ? `-${body}` : body;
}

let pinnedExpiry = 0;

function expiryUnix() {
  if (state.tenorSec > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (pinnedExpiry <= now + 90) pinnedExpiry = now + state.tenorSec;
    return BigInt(pinnedExpiry);
  }
  return BigInt(state.date || 0);
}

const nearestTo = (list, want) => list.reduce((best, value) => (best == null || Math.abs(value - want) < Math.abs(best - want) ? value : best), null);
const clears = (sats) => sats != null && sats > BEACON_READ_FEE;
const takes = clears;
const spotUsd = () => Number(state.spotCents) / 100;
const cents = (usd) => BigInt(Math.round(usd * 100));

/** Listed Friday expiries: the nearest one, then the month-end ones. */
function dates() {
  const now = Math.floor(Date.now() / 1000);
  const month = (unix) => new Date(unix * 1000).getUTCMonth();
  return [...new Set(state.points.map((point) => point.expiry))]
    .filter((unix) => unix > now + 3600 && new Date(unix * 1000).getUTCDay() === 5)
    .sort((a, b) => a - b)
    .filter((unix, index) => index === 0 || month(unix) !== month(unix + 7 * 86400))
    .slice(0, 4);
}

/** Strikes Deribit lists at this date on the far side of today's price, nearest first. */
function linesFor(kind, expiry) {
  const call = kind === 0;
  const spot = spotUsd();
  const book = state.points.filter((point) => point.call === call && point.expiry >= expiry);
  const at = Math.min(...book.map((point) => point.expiry));
  const listed = book
    .filter((point) => point.expiry === at && (call ? point.strike > spot : point.strike < spot))
    .map((point) => point.strike);
  const want = call ? [1.05, 1.075, 1.1, 1.15] : [0.95, 0.925, 0.9, 0.85];
  const lines = [(testLine ||= Math.round(spot / 100) * 100)];
  for (const step of want) {
    const line = nearestTo(listed, spot * step);
    if (line != null && !lines.includes(line)) lines.push(line);
  }
  return lines.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
}

function estimate(kind, line, expiry, size) {
  const priced = deribitPremium({
    kind,
    strikeUsd: line,
    expiry,
    now: Math.floor(Date.now() / 1000),
    collateralSats: size,
    spotUsd: spotUsd(),
    points: state.points,
  });
  return priced ? quotedPremium(priced.sats, expiry, Math.floor(Date.now() / 1000)) : null;
}

/** Picks the date and both lines from the book. False until prices load. */
function ready() {
  if (!state.points || state.spotCents == null) return false;
  const list = dates();
  if (!list.length) return false;
  if (!list.includes(state.date)) state.date = nearestTo(list, Date.now() / 1000 + 42 * 86400);
  const expiry = Number(expiryUnix());
  for (const kind of [0, 1]) {
    const lines = linesFor(kind, expiry);
    if (!lines.length) return false;
    if (lines.includes(state.lines[kind])) continue;
    const first = !state.lines[kind];
    state.lines[kind] = nearestTo(lines, state.lines[kind] || spotUsd() * (kind === 0 ? 1.075 : 0.925));
    if (first) fitLine(kind);
  }
  return true;
}

/** A line that pays no more than the fee moves toward today's price, to the first one that does. */
function fitLine(kind) {
  const expiry = Number(expiryUnix());
  const lines = linesFor(kind, expiry);
  const pays = (line) => takes(estimate(kind, line, expiry, state.size));
  if (pays(state.lines[kind])) return;
  const closer = lines.slice(0, lines.indexOf(state.lines[kind])).reverse().find(pays);
  if (closer != null) state.lines[kind] = closer;
}

function terms() {
  const line = state.lines[state.kind];
  return { kind: state.kind, line, strike: cents(line), expiry: expiryUnix(), size: state.size, tenorSec: state.tenorSec };
}

/** What the vault sends back to you at this price, after the price-check fee. */
function backSats(kind, price, line, q) {
  return settlementOutputs(holderPayoff(kind, cents(price), cents(line), q), q, BEACON_READ_FEE).writer;
}

/** The highest price at which a put sends nothing back. */
function zeroAt(line, q) {
  const k = cents(line);
  let lo = 1n;
  let hi = k;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (settlementOutputs(holderPayoff(1, mid, k, q), q, BEACON_READ_FEE).writer === 0n) lo = mid;
    else hi = mid - 1n;
  }
  return Number(lo) / 100;
}

const int = (n) => BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const usd0 = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
const usd2 = (x) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const worth = (sats, usd) => (Number(sats) * usd) / 1e8;
const capital = (text) => text[0].toUpperCase() + text.slice(1);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

function pct(line) {
  const p = (line / spotUsd() - 1) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

function whenDay(unix) {
  return new Date(Number(unix) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** "Fri, Nov 27" for an 08:00 UTC date, otherwise the day and the time. */
function whenShort(unix) {
  const d = new Date(Number(unix) * 1000);
  if (hhmm(d) !== "08:00") return `${whenDay(unix)}, ${hhmm(d)} UTC`;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

function atTime(unix) {
  return `${hhmm(new Date(Number(unix) * 1000))} UTC on ${whenDay(unix)}`;
}

function away(unix) {
  const days = (unix - Date.now() / 1000) / 86400;
  if (days < 1.5) {
    const hours = Math.max(1, Math.round(days * 24));
    return `In ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (days < 14) return `In ${Math.round(days)} days`;
  const weeks = days < 31 ? Math.round(days / 3.5) / 2 : Math.round(days / 7);
  return `In ${String(weeks).replace(".5", "½")} weeks`;
}

function toGo(unix) {
  const s = Number(unix) - Date.now() / 1000;
  if (s >= 2 * 86400) return `${Math.floor(s / 86400)} days to go`;
  if (s >= 7200) return `${Math.floor(s / 3600)} hours to go`;
  return `${Math.max(1, Math.ceil(s / 60))} min to go`;
}

function sentenceInto(node, kind, size, expiry, line, tense) {
  const verbs = VERBS[tense];
  node.replaceChildren(
    `${verbs[0]} `,
    el("span", "chip", `₿${fmtBtc(size)}`),
    " until ",
    el("span", "chip", whenShort(expiry)),
    ` and ${verbs[1 + kind]} `,
    el("span", "chip", usd0(line)),
    ".",
  );
}

function shortAddress(address) {
  if (!address || address.length < 20) return address || "";
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}

const STEPS = ["Waiting for your BTC", "BTC received", "Paying you", "You’re paid", "Done"];

function progressIndex(status) {
  if (status === "locking") return 0;
  if (status === "deposited") return 2;
  if (status === "filled") return 3;
  if (status === "settled") return 4;
  return -1;
}

function markStep(item, kind, busy = false) {
  item.className = kind;
  if (!busy) return;
  const spin = el("span", "spin");
  spin.setAttribute("aria-hidden", "true");
  item.append(spin);
}

function progressSteps(status, received) {
  const list = el("ol", "steps");
  list.setAttribute("aria-label", "Progress");
  if (status === "expired" || status === "refunded") {
    const labels = status === "refunded"
      ? ["Waiting for your BTC", "BTC received", "Sent back"]
      : received ? ["Waiting for your BTC", "BTC received", "Time ran out"] : ["Waiting for your BTC", "Time ran out"];
    labels.forEach((label, step) => {
      const item = el("li", "", label);
      markStep(item, step === labels.length - 1 ? "now" : "done", false);
      list.append(item);
    });
    return list;
  }
  const index = progressIndex(status);
  if (index < 0) return null;
  STEPS.forEach((label, step) => {
    const item = el("li", "", label);
    const currentDone = status === "settled" || step < index || (status === "filled" && step === index);
    if (currentDone) markStep(item, "done");
    else if (step === index) markStep(item, "now", true);
    list.append(item);
  });
  return list;
}

function statusLabel(position) {
  if (isPredict(position.kind)) return betStatusLabel(position);
  if (position.status === "locking") return position.walletTxid ? "Waiting for your BTC" : "Send your BTC";
  if (position.status === "deposited") return "Paying you";
  if (position.status === "settled" || settlementKnown(position)) return "Done";
  if (position.status === "filled") return Number(position.expiry) > Date.now() / 1000 ? toGo(position.expiry) : "Checking the price";
  if (position.status === "expired") return "Time ran out";
  if (position.status === "refunded") return "Sent back";
  return "Open";
}

function clipDetail(text) {
  const line = String(text ?? "").split("\n").map((row) => row.trim()).find(Boolean) ?? "";
  return line.replace(/(bearer|token|authorization|secret|password)\s*[:=]?\s*\S+/gi, "$1 …").slice(0, 240);
}

/** One place for a failure: a sentence, then the backend text a tester can copy. */
function renderStatus(node, sentence, detail) {
  if (!node) return;
  node.replaceChildren();
  if (sentence) node.append(document.createTextNode(sentence));
  const shown = detail && detail !== sentence ? clipDetail(detail) : "";
  if (shown) node.append(el("code", "fault", shown));
}

function quoteFault(note) {
  const detail = clipDetail(note);
  const asked = terms();
  if (note.includes("float short")) {
    return ["The desk can’t pay this much right now. Try a smaller amount, or try again later.", detail];
  }
  if (/refused: (spot|deribit) unavailable/.test(note)) {
    return ["We can’t get a fair price right now. Try again in a moment.", detail];
  }
  if (note.includes("refused: expiry")) return ["That date is too close. Pick a later one.", detail];
  if (note.includes("below dust")) {
    return ["This doesn’t pay more than the 1,000-sat price-check fee. Pick a closer line, a later date or more BTC.", detail];
  }
  if (note.includes("refused: premium")) {
    return ["The payment is at least as large as the BTC you lock, so the desk will not take it.", detail];
  }
  if (note.includes("refused: collateral")) return ["Try a smaller amount.", detail];
  if (note.includes("exposure")) {
    return [`The desk has taken all it can at ${usd0(asked.line)} for ${whenDay(asked.expiry)}. Try another line or date.`, detail];
  }
  if (note.includes("did not answer")) return ["The desk didn’t answer. Try again in a moment.", detail];
  return ["Try again in a moment.", detail];
}

function mine(position) {
  if (position.writerAddress) return position.writerAddress === state.address;
  if (position.payoutAddress) return position.payoutAddress === state.address;
  return false;
}

function visiblePositions() {
  return state.positions.filter(mine);
}

function svgEl(name, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function action(className, text, fn) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}

function kindIcon(kind) {
  const svg = svgEl("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  svg.append(
    svgEl("path", { d: kind === 0 ? "M2.5 16.5l4.5-4.5 3 2.5 6-7" : "M2.5 3.5l4.5 4.5 3-2.5 6 7" }),
    svgEl("path", { d: kind === 0 ? "M2.5 4.5h15" : "M2.5 15.5h15", "stroke-dasharray": "2.2 2.4" }),
  );
  return svg;
}

let chartSeq = 0;

/** What you end up with at each price on the date: what comes back, plus what you were paid. */
function drawChart(host, { kind, k, q, pay, at, day }) {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 250;
  const top = 50;
  const ly = 15;
  let x0 = kind === 0 ? k * 0.65 : k * 0.4;
  let x1 = kind === 0 ? k * 1.6 : k * 1.3;
  if (at) {
    x0 = Math.min(x0, at.p * 0.9);
    x1 = Math.max(x1, at.p * 1.1);
  }
  const lock = Number(q);
  const ymax = (lock + Math.max(Number(pay), 14_000)) * 1.06;
  const X = (p) => 2 + ((p - x0) / (x1 - x0)) * (W - 4);
  const Y = (s) => top + (1 - s / ymax) * (H - top - 28);
  const yb = Y(0);
  const yt = top - 8;
  const yl = Y(lock);
  const end = (p) => Number(backSats(kind, p, k, q) + pay);
  const prices = Array.from({ length: 97 }, (_, i) => x0 + ((x1 - x0) * i) / 96);
  prices.push(k);
  if (kind === 1) prices.push(zeroAt(k, q));
  prices.sort((a, b) => a - b);
  const curve = prices.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)} ${Y(end(p)).toFixed(1)}`).join("");
  const under = `${curve}L${X(x1).toFixed(1)} ${yb.toFixed(1)}L${X(x0).toFixed(1)} ${yb.toFixed(1)}Z`;
  const over = `${curve}L${X(x1).toFixed(1)} ${yt}L${X(x0).toFixed(1)} ${yt}Z`;
  const id = `chart${++chartSeq}`;
  const safe = kind === 0 ? "under" : "above";
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "slider",
    tabindex: 0,
    "aria-valuemin": Math.round(x0),
    "aria-valuemax": Math.round(x1),
    "aria-valuenow": Math.round(at ? at.p : k),
    "aria-label": `What you end up with on ${day}: ₿${fmtBtc(backSats(kind, k, k, q) + pay)} if BTC is ${safe} ${usd0(k)}, and less the further it goes ${kind === 0 ? "above" : "below"}.`,
  });
  const defs = svgEl("defs", {});
  for (const [name, y, h] of [["a", yt - 20, yl - yt + 20], ["b", yl, yb - yl]]) {
    const clip = svgEl("clipPath", { id: id + name });
    clip.append(svgEl("rect", { x: 0, y, width: W, height: Math.max(0, h) }));
    defs.append(clip);
  }
  svg.append(defs);
  const step = W < 460 ? 20_000 : 10_000;
  for (let p = Math.ceil(x0 / step) * step; p <= x1; p += step) {
    svg.append(
      svgEl("line", { x1: X(p), x2: X(p), y1: yt, y2: yb, class: "gl" }),
      svgEl("text", { x: X(p), y: yb + 19, "text-anchor": "middle", class: "tick" }, `$${p / 1000}k`),
    );
  }
  svg.append(
    svgEl("path", { d: under, class: "area" }),
    svgEl("path", { d: under, class: "more", "clip-path": `url(#${id}a)` }),
    svgEl("path", { d: over, class: "less", "clip-path": `url(#${id}b)` }),
    svgEl("path", { d: curve, class: "curve" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: yl, y2: yl, class: "lock" }),
    svgEl("text", { x: kind === 1 ? W - 8 : 8, y: yl + 17, "text-anchor": kind === 1 ? "end" : "start" }, `You lock ₿${fmtBtc(q)}`),
    svgEl("line", { x1: 2, x2: W - 2, y1: yb, y2: yb, class: "base" }),
  );
  if (pay > 0n) {
    const label = `+${int(pay)} sats paid now`;
    const half = label.length * 3.5;
    const mid = X(kind === 0 ? (x0 + k) / 2 : (k + x1) / 2);
    svg.append(svgEl("text", {
      x: Math.min(W - half - 4, Math.max(half + 4, mid)),
      y: Y(lock + Number(pay)) - 9,
      "text-anchor": "middle",
      class: "paid",
    }, label));
  }
  const right = !at || at.p < k;
  const mark = (p, className, text, onRight) => {
    const x = X(p);
    svg.append(
      svgEl("line", { x1: x, x2: x, y1: ly - 11, y2: yb, class: className }),
      svgEl("text", { x: onRight ? x + 7 : x - 7, y: ly, "text-anchor": onRight ? "start" : "end", class: `${className}-label` }, text),
    );
  };
  mark(k, "mark", `Your line ${usd0(k)}`, right);
  if (at) mark(at.p, "today", `${at.label} ${usd0(at.p)}`, !right);
  // The scrub reads any price on a $250 grid. Prices refresh while the chart is open,
  // so a redraw keeps the reading and the focus.
  const probe = svgEl("g", { class: "probe" });
  const tip = el("div", "tip");
  const key = `${kind}:${k}:${q}`;
  const row = (name, value, className = "r") => {
    const node = el("div", className);
    node.append(el("span", "", name), el("span", "", value));
    return node;
  };
  let now = null;
  const read = (p) => {
    now = p == null ? null : Math.min(x1, Math.max(x0, Math.round(p / 250) * 250));
    host.dataset.scrub = now == null ? "" : `${key}@${now}`;
    tip.hidden = now == null;
    probe.replaceChildren();
    if (now == null) return;
    const back = backSats(kind, now, k, q);
    const total = back + pay;
    const x = X(now);
    probe.append(svgEl("line", { x1: x, x2: x, y1: yt, y2: yb }), svgEl("circle", { cx: x, cy: Y(Number(total)), r: 7 }));
    tip.replaceChildren(
      el("div", "t", `If BTC is ${usd0(now)} on ${day}`),
      row("You get back", `${int(back)} sats`),
      ...(pay > 0n ? [row("Paid now", `+${int(pay)} sats`)] : []),
      row("You end with", `${int(total)} sats`, "r end"),
      el("div", "s", `₿${fmtBtc(total)} · worth ${usd0(worth(total, now))}`),
    );
    const room = tip.offsetWidth + 16;
    tip.style.left = `${x + room > W ? Math.max(0, x - room) : x + 16}px`;
    svg.setAttribute("aria-valuenow", String(now));
    svg.setAttribute("aria-valuetext", `If BTC is ${usd0(now)} on ${day}, you end with ${int(total)} sats.`);
  };
  const aim = (event) => read(x0 + ((event.clientX - svg.getBoundingClientRect().left - 2) / (W - 4)) * (x1 - x0));
  svg.addEventListener("pointerdown", aim);
  svg.addEventListener("pointermove", aim);
  // A mouse that leaves clears the reading; a finger that lifts leaves it up, unless it was scrolling.
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") read(null);
  });
  svg.addEventListener("pointercancel", () => read(null));
  svg.addEventListener("blur", () => read(null));
  svg.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    read((now ?? (at ? at.p : k)) + step * (event.shiftKey ? 1000 : 250));
  });
  const [was, price] = (host.dataset.scrub || "").split("@");
  const focused = host.contains(document.activeElement);
  svg.append(probe);
  host.replaceChildren(svg, tip);
  read(was === key ? Number(price) : null);
  if (focused) svg.focus({ preventScroll: true });
}

function renderSell() {
  if (state.view !== "sell") return;
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.kind) === state.kind));
  });
  $("verb").textContent = `and ${VERBS.now[1 + state.kind]}`;
  const ok = ready();
  const [sizeChip, dateChip, lineChip] = ["size", "date", "line"].map((name) => document.querySelector(`[data-chip="${name}"]`));
  for (const chip of [sizeChip, dateChip, lineChip]) chip.disabled = !ok;
  const coin = el("span", "btc", "₿");
  coin.setAttribute("aria-hidden", "true");
  sizeChip.replaceChildren(coin, fmtBtc(state.size));
  sizeChip.setAttribute("aria-label", `Amount, ${fmtBtc(state.size)} BTC`);
  const see = $("see");
  if (!ok) {
    dateChip.textContent = "…";
    lineChip.textContent = "…";
    $("estimate").textContent = state.loaded
      ? "We can’t get a fair price right now. Try again in a minute."
      : "Getting today’s prices…";
    see.disabled = true;
    see.textContent = "See what happens";
    renderPop();
    renderCheckout();
    return;
  }
  const t = terms();
  const day = whenDay(t.expiry);
  dateChip.textContent = whenShort(t.expiry);
  dateChip.setAttribute("aria-label", `Date, ${whenShort(t.expiry)}`);
  lineChip.replaceChildren(usd0(t.line), el("span", "delta", pct(t.line)));
  lineChip.setAttribute("aria-label", `Price, ${usd0(t.line)}, ${pct(t.line)} from today`);
  const pay = estimate(t.kind, t.line, Number(t.expiry), t.size);
  const note = $("estimate");
  if (takes(pay)) note.replaceChildren("You get paid about ", el("b", "", `${int(pay)} sats`), ` now · 1,000-sat fee on ${day}`);
  else if (pay == null) note.textContent = "We can’t price this one right now. Pick another date or line.";
  else note.textContent = `This pays about ${int(pay)} sats, which doesn’t cover the 1,000-sat fee on ${day}. Pick a closer line, a later date or more BTC.`;
  see.disabled = !takes(pay);
  see.textContent = `See what happens on ${day}`;
  renderPop();
  renderCheckout();
}

/** The short list under a chip. A choice that pays no more than the fee stays listed, greyed out, with the reason. */
function renderPop(focus = false) {
  const pop = $("pop");
  document.querySelectorAll("[data-chip]").forEach((chip) => {
    chip.setAttribute("aria-expanded", String(chip.dataset.chip === state.open));
  });
  if (!state.open || state.view !== "sell" || !ready()) {
    pop.hidden = true;
    return;
  }
  const had = pop.contains(document.activeElement) ? document.activeElement.dataset.pick : "";
  const t = terms();
  const kind = t.kind;
  const expiry = Number(t.expiry);
  let title;
  let hint;
  let rows;
  if (state.open === "size") {
    title = "How much BTC to lock?";
    hint = "The 1,000-sat price-check fee comes out of this on the date. We start at 0.002 BTC so the fee stays small.";
    rows = SIZES.map((q) => ({
      pick: `size:${q}`,
      on: q === t.size,
      label: `${fmtBtc(q)} BTC`,
      note: `${int(q)} sats · about ${usd0(worth(q, spotUsd()))}`,
      pay: estimate(kind, t.line, expiry, q),
    }));
  } else if (state.open === "date") {
    title = "Until when?";
    hint = "Fridays at 08:00 UTC, the same dates as Deribit’s BTC options. Your BTC stays locked until then.";
    const row = (pick, on, label, note, unix) => {
      const at = nearestTo(linesFor(kind, unix), t.line);
      return { pick, on, label, note, at, pay: estimate(kind, at, unix, t.size) };
    };
    rows = dates().map((unix) => row(`date:${unix}`, !state.tenorSec && unix === state.date, whenShort(unix), away(unix), unix));
    const soon = Math.floor(Date.now() / 1000) + 600;
    rows.push(row("tenor:600", state.tenorSec === 600, "In 10 minutes", whenShort(soon), soon));
  } else {
    title = kind === 0 ? "Give up gains above" : "Take the loss below";
    hint = `Today’s price is ${usd0(spotUsd())}.`;
    rows = linesFor(kind, expiry).map((k) => {
      const atm = k === testLine;
      return {
        pick: `line:${k}`,
        on: k === t.line,
        label: atm ? "At today’s price" : usd0(k),
        note: atm ? usd0(k) : `${Math.abs((k / spotUsd() - 1) * 100).toFixed(1)}% ${k > spotUsd() ? "above" : "below"} today`,
        pay: estimate(kind, k, expiry, t.size),
      };
    });
  }
  const list = el("div", "opts");
  for (const row of rows) {
    const btn = el("button", row.on ? "on" : "");
    btn.type = "button";
    btn.dataset.pick = row.pick;
    btn.append(el("b", "", row.label), el("span", "", row.note));
    const allowed = clears(row.pay);
    if (allowed) {
      btn.setAttribute("aria-pressed", String(row.on));
    } else {
      btn.className = "off";
      btn.setAttribute("aria-disabled", "true");
      btn.append(el("em", "", row.pay == null
        ? "There’s no price for this yet."
        : `Pays ${int(row.pay)} sats${row.at ? ` at ${usd0(row.at)}` : ""}, which doesn’t cover the 1,000-sat price-check fee.`));
    }
    list.append(btn);
  }
  const heading = el("p", "q", title);
  heading.id = "pop-title";
  pop.replaceChildren(heading, list, el("p", "hint", hint));
  pop.hidden = false;
  const chip = document.querySelector(`[data-chip="${state.open}"]`);
  pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, pop.parentElement.clientWidth - pop.offsetWidth))}px`;
  pop.style.top = `${chip.offsetTop + chip.offsetHeight + 12}px`;
  const target = had || (focus ? (rows.find((row) => row.on) || rows[0])?.pick : "");
  if (target) pop.querySelector(`[data-pick="${target}"]`)?.focus();
}

function onPick(event) {
  const btn = event.target.closest("[data-pick]");
  if (!btn || btn.getAttribute("aria-disabled") === "true") return;
  const [what, value] = btn.dataset.pick.split(":");
  if (what === "size") state.size = BigInt(value);
  if (what === "date") {
    state.date = Number(value);
    state.tenorSec = 0;
  }
  if (what === "tenor") {
    state.tenorSec = Number(value);
    if (testLine) state.lines[state.kind] = testLine;
  }
  if (what === "line") state.lines[state.kind] = Number(value);
  const chip = document.querySelector(`[data-chip="${state.open}"]`);
  state.open = "";
  onTermsChanged();
  chip?.focus();
}

/** The drawer. Everything in it is a local estimate until the box is ticked. */
function renderCheckout() {
  const open = state.checkout && state.view === "sell" && ready();
  $("checkout").hidden = !open;
  syncScrim();
  if (!open) return;
  const t = terms();
  const { kind, line: k, size: q } = t;
  const day = whenDay(t.expiry);
  const est = estimate(kind, k, Number(t.expiry), q);
  const pay = state.offer ? state.offer.quote.sats : est;
  const all = backSats(kind, k, k, q);
  sentenceInto($("checkout-sentence"), kind, q, t.expiry, k, "now");
  if (takes(pay)) {
    $("pay-head").replaceChildren(state.offer ? "You get paid " : "You get paid about ", el("span", "amt", `₿${fmtBtc(pay)}`), " now.");
    const was = state.offer && est != null && Math.abs(Number(pay - est)) * 100 > Number(est) ? ` · the estimate was ${int(est)} sats` : "";
    $("pay-sub").textContent = `${int(pay)} sats · about ${usd2(worth(pay, spotUsd()))} at today’s ${usd0(spotUsd())}${was}`;
  } else {
    $("pay-head").textContent = "This doesn’t cover the price-check fee.";
    $("pay-sub").textContent = pay == null
      ? "We can’t price this one right now."
      : `It pays ${state.offer ? "" : "about "}${int(pay)} sats, not more than the 1,000-sat price-check fee, so it can’t be locked.`;
  }
  $("fee-label").textContent = `Price-check fee on ${day}`;
  $("rows-when").textContent = `If BTC on ${day} is`;
  const rows = [[`Stays ${kind === 0 ? "under" : "above"} ${usd0(k)}`, `₿${fmtBtc(all)}`, `${int(all)} sats · all of it, less the fee`]];
  let worst;
  if (kind === 0) {
    const high = Math.ceil((k * 1.1) / 10_000) * 10_000;
    const kept = usd0(worth(backSats(0, high, k, q), high));
    rows.push([`Goes above ${usd0(k)}`, "Fewer sats", `always worth about ${kept}`]);
    worst = `I understand that if BTC is above ${usd0(k)} on ${day}, I get back fewer sats (worth about ${kept}).`;
  } else {
    const zero = usd0(Math.floor(zeroAt(k, q)));
    rows.push(
      [`Falls below ${usd0(k)}`, "Fewer sats", `${usd0(Number(q) / 1e5)} of your BTC for every $1,000 it falls`],
      [`${zero} or lower`, "Nothing", "the desk keeps what you locked"],
    );
    worst = `I understand that if BTC is below ${usd0(k)} on ${day}, I get back less, and nothing at ${zero} or lower.`;
  }
  $("rows").replaceChildren(...rows.map(([when, get, small], index) => {
    const row = el("div", "row");
    const value = el("span", index === 2 ? "get zero" : "get", get);
    value.append(el("small", "", small));
    row.append(el("span", "when", when), value);
    return row;
  }));
  $("agree-text").textContent = worst;
  $("chart-title").textContent = `What you end up with on ${day}`;
  $("chart-cap").textContent = takes(pay)
    ? `Back from the lock, plus the ${int(pay)} sats paid now. Drag across to explore.`
    : "No payment: this doesn’t pay more than the 1,000-sat price-check fee.";
  drawChart($("checkout-chart"), { kind, k, q, pay: takes(pay) ? pay : 0n, at: { p: spotUsd(), label: "Today" }, day });
  renderFoot();
}

/** The button, the firm offer and its ring. Runs every second while the drawer is open. */
function renderFoot() {
  if (!state.checkout) return;
  const now = Math.floor(Date.now() / 1000);
  const quote = state.offer?.quote;
  const left = quote ? Math.min(quote.validUntil, quote.deadline) - now : 0;
  const firm = $("firm");
  let label = "Lock and get paid";
  let off = false;
  let sentence = state.walletFault?.sentence || "";
  let detail = state.walletFault?.detail || "";
  firm.replaceChildren();
  $("agree").checked = state.agree;
  if (!state.address) {
    label = "Connect wallet";
  } else if (!state.agree) {
    off = true;
  } else if (state.quoting) {
    label = "Getting your offer…";
    off = true;
    sentence = "";
    detail = "";
  } else if (quote && !takes(quote.sats)) {
    off = true;
    firm.append(el("span", "", `${int(quote.sats)} sats`));
    sentence = "This doesn’t pay more than the 1,000-sat price-check fee. Pick a closer line, a later date or more BTC.";
    detail = `${quote.sats} sats`;
  } else if (quote && left > 0) {
    const ring = el("span", "ring", `Offer holds ${mmss(left)}`);
    ring.style.setProperty("--left", String(Math.min(100, (left / QUOTE_TTL_S) * 100)));
    firm.append(el("span", "", `₿${fmtBtc(quote.sats)}`), ring);
    sentence = "";
    detail = "";
  } else if (quote) {
    label = "Refresh offer";
    firm.append(el("span", "ring", "Offer expired"));
    sentence = "Refresh the offer.";
    detail = "offer expired";
  } else if (state.quoteNote) {
    label = "Try again";
    [sentence, detail] = quoteFault(state.quoteNote);
  }
  $("confirm").textContent = label;
  $("confirm").disabled = off;
  renderStatus($("checkout-status"), sentence, detail);
}

function pageHash(view) {
  if (view === "connect") return "#/connect";
  if (view === "home") return state.selected ? `#/positions/${state.selected}` : "#/positions";
  if (view === "how") return "#/how";
  if (view === "predict") return state.bet.kind === 3 ? "#/predict/lower" : "#/predict";
  return state.kind === 1 ? "#/quote/put" : "#/quote/call";
}

function routeFromHash() {
  const path = (location.hash || "#/").replace(/^#/, "");
  if (path.startsWith("/sell/put") || path.startsWith("/quote/put")) return { view: "sell", kind: 1 };
  if (path.startsWith("/sell/call") || path.startsWith("/quote/call")) return { view: "sell", kind: 0 };
  if (path.startsWith("/positions")) return { view: "home", kind: state.kind, id: path.slice("/positions/".length) || null };
  if (path.startsWith("/connect")) return { view: "connect", kind: state.kind };
  if (path === "/how" || path.startsWith("/how/")) return { view: "how", kind: state.kind };
  if (path.startsWith("/predict/lower")) return { view: "predict", kind: 3 };
  if (path.startsWith("/predict")) return { view: "predict", kind: 2 };
  // Predict is the home page.
  return { view: "predict", kind: state.bet.kind };
}

let lastCompose = "predict";

function show(view, mode = "push") {
  if (view === "sell" || view === "predict") lastCompose = view;
  state.view = view;
  $("connect").hidden = view !== "connect";
  $("home").hidden = view !== "home";
  $("sell").hidden = view !== "sell";
  $("predict").hidden = view !== "predict";
  $("how").hidden = view !== "how";
  if (view !== "sell") {
    state.open = "";
    closeCheckout();
  }
  if (view !== "predict") {
    state.bet.open = "";
    closeBet();
  }
  const predicting = view === "predict";
  $("note-lead").textContent = "Coinflip is an educational demo";
  $("note-body").textContent = predicting
    ? "of calls on where bitcoin closes: one price fixing, one vault, paid in sats."
    : "of BTC options settled by a contract on bitcoin.";
  const next = pageHash(view);
  if (mode !== "quiet" && location.hash !== next) {
    if (mode === "replace") history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }
  renderTop();
  if (view === "home") renderBlotter();
  if (view === "sell") renderSell();
  if (view === "predict") {
    renderPredict();
    void loadHistory();
  }
  syncIndexPolling();
  if (view === "connect") {
    $("connect-current").hidden = !state.address;
    $("connect-address").textContent = shortAddress(state.address);
    $("account-key").focus();
  }
}

function renderTop() {
  const known = Boolean(state.address);
  $("who").hidden = !known;
  $("who-address").textContent = known ? shortAddress(state.address) : "";
  $("who-tail").textContent = known ? `…${state.address.slice(-4)}` : "";
  $("top-connect").hidden = known;
  const count = state.restored.length + visiblePositions().length;
  $("count").hidden = !count;
  $("count").textContent = String(count);
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === state.view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

let shownId = "";

function renderBlotter() {
  const rows = [...state.restored, ...visiblePositions()];
  const selected = rows.find((position) => position.id === state.selected) || null;
  if (!selected) state.selected = null;
  if (state.view === "home" && location.hash !== pageHash("home")) history.replaceState(null, "", pageHash("home"));
  renderTop();
  $("list-view").hidden = Boolean(selected);
  $("position-view").hidden = !selected;
  if (selected) {
    if (shownId !== selected.id) $("status").textContent = "";
    shownId = selected.id;
    renderPosition(selected);
    return;
  }
  shownId = "";
  const host = $("blotter");
  host.replaceChildren();
  if (!rows.length) {
    host.append(el("p", "empty", state.address
      ? "No positions yet. Lock some BTC or make a prediction and it shows up here."
      : "Connect your wallet to see your positions."));
    return;
  }
  for (const position of rows) {
    if (isPredict(position.kind)) {
      host.append(betRow(position));
      continue;
    }
    const row = el("a", "prow");
    row.href = `#/positions/${position.id}`;
    const icon = el("span", position.kind === 1 ? "kindico put" : "kindico");
    icon.append(kindIcon(position.kind));
    const what = el("span");
    what.append(
      el("b", "", `${capital(VERBS[["expired", "refunded"].includes(position.status) ? "none" : "past"][1 + position.kind])} ${usd0(Number(position.strike) / 100)}`),
      el("span", "m", `${fmtBtc(position.collateral)} BTC · until ${whenShort(position.expiry)}`),
    );
    const done = position.status === "settled" || settlementKnown(position);
    const side = el("span", "r");
    side.append(el("span", done ? "pill ok" : "pill", statusLabel(position)));
    const pay = position.premiumSats || 0n;
    let extra = "";
    if (done && position.writerKeep) {
      const net = BigInt(position.writerKeep) + pay - position.collateral;
      extra = `${net < 0n ? "−" : "+"}${int(net < 0n ? -net : net)} sats overall`;
    } else if (pay > 0n && (position.status === "filled" || done)) extra = `+${int(pay)} sats paid`;
    else if (pay > 0n && (position.status === "locking" || position.status === "deposited")) extra = `Pays ${int(pay)} sats`;
    if (extra) side.append(el("small", "", extra));
    row.append(icon, what, side);
    host.append(row);
  }
}

function sendClock(node) {
  const left = Number(node.dataset.until) - Math.floor(Date.now() / 1000);
  node.textContent = left > 0 ? `${mmss(left)} left to send` : "Time ran out. Checking…";
}

function renderPosition(p) {
  if (isPredict(p.kind)) {
    renderPrediction(p);
    return;
  }
  optionChrome();
  const k = Number(p.strike) / 100;
  const q = p.collateral;
  const pay = p.premiumSats || 0n;
  const now = Math.floor(Date.now() / 1000);
  const done = p.status === "settled" || settlementKnown(p);
  const live = p.status === "locking" || p.status === "deposited";
  const unlocked = p.status === "expired" || p.status === "refunded";
  const side = (price) => (p.kind === 0 ? (price > k ? "above" : "under") : (price < k ? "below" : "above"));
  sentenceInto($("position-sentence"), p.kind, q, p.expiry, k, live ? "ing" : unlocked ? "none" : "past");
  const head = el("h2");
  const body = [];
  let at = state.spotCents == null ? null : { p: spotUsd(), label: "Now" };
  if (p.status === "locking") {
    head.textContent = p.walletTxid ? "Your wallet sent it." : "Send your BTC to finish.";
    body.push(el("p", "sub", p.walletTxid
      ? `Waiting for ₿${fmtBtc(q)} to arrive. As soon as it lands, we pay you ${int(pay)} sats.`
      : `Send ₿${fmtBtc(q)} from your wallet. As soon as it lands, we pay you ${int(pay)} sats.`));
    const timer = el("p", "clock");
    timer.dataset.until = String(p.deadline);
    sendClock(timer);
    const acts = el("div", "acts");
    acts.append(
      action("btn sm", "Reopen wallet", () => openWallet(p)),
      action("textbtn", "Copy payment link", (event) => {
        void copyToClipboard(event.currentTarget, p.uri || paymentUri(p.address, sendAmount(p)));
      }),
      action("textbtn", "Cancel", (event) => {
        void abortLock(p, event.currentTarget);
      }),
    );
    body.push(timer, acts);
  } else if (p.status === "deposited") {
    head.textContent = "Your BTC arrived.";
    body.push(el("p", "sub", "Paying you now…"));
  } else if (done) {
    const keep = p.writerKeep ? BigInt(p.writerKeep) : null;
    const desk = p.deskTake ? BigInt(p.deskTake) : 0n;
    if (p.settleCents) at = { p: Number(p.settleCents) / 100, label: "BTC was" };
    if (keep == null) {
      head.textContent = "Done.";
      body.push(el("p", "sub", "Your BTC left the vault. Reading what came back…"));
    } else {
      head.textContent = `Done. You ended with ₿${fmtBtc(keep + pay)}.`;
      const where = p.settleCents
        ? `BTC was $${usdFromCents(BigInt(p.settleCents))} at ${atTime(p.expiry)}, ${side(at.p)}`
        : `BTC ended ${desk > 0n ? (p.kind === 0 ? "above" : "below") : (p.kind === 0 ? "under" : "above")}`;
      const then = desk === 0n ? ", so all of it came back." : keep === 0n ? ", so the desk kept what you locked." : ".";
      body.push(el("p", "sub", `${where} your ${usd0(k)} line${then}`));
      const ledger = el("div", "ledger");
      const line = (name, value, className = "") => {
        const row = el("div", className === "tot" ? "tot" : "");
        row.append(el("span", "", name), el("span", className === "minus" ? "minus" : "", value));
        ledger.append(row);
      };
      line("You locked", `${int(q)} sats`);
      if (pay > 0n) line("Paid to you", `+${int(pay)}`);
      if (desk > 0n) line(`To the desk, for ${p.kind === 0 ? "gains above" : "the loss below"} ${usd0(k)}`, `−${int(desk)}`, "minus");
      line(`Price-check fee on ${whenDay(p.expiry)}`, `−${int(q - keep - desk)}`, "minus");
      line("You ended with", `${int(keep + pay)} sats`, "tot");
      body.push(ledger);
    }
  } else if (p.status === "filled" && Number(p.expiry) > now) {
    head.textContent = `${capital(toGo(p.expiry))}.`;
    if (at) {
      const back = backSats(p.kind, at.p, k, q);
      const box = el("div", "ifnow");
      box.append(el("p", "", "If it ended now, you’d get back"), el("p", "big", `₿${fmtBtc(back)} · ${int(back)} sats`));
      if (pay > 0n) box.append(el("p", "small", `on top of the ${int(pay)} sats you already have.`));
      body.push(el("p", "sub", `BTC is ${usd0(at.p)}, ${side(at.p)} your ${usd0(k)} line.`), box);
    }
  } else if (p.status === "filled") {
    head.textContent = "Checking the price.";
    body.push(el("p", "sub", `We check the BTC price at ${atTime(p.expiry)} and send back what’s yours. Nothing for you to do.`));
    const settle = settleButton(p);
    if (settle) {
      const acts = el("div", "acts");
      acts.append(settle);
      body.push(acts);
    }
  } else if (p.status === "expired") {
    head.textContent = p.refundable ? "The desk didn’t take it in time." : "Time ran out before your BTC arrived.";
    body.push(el("p", "sub", p.refundable ? `Your ₿${fmtBtc(q)} is still yours. Take it back.` : "Nothing was locked."));
    if (p.refundable) {
      const acts = el("div", "acts");
      acts.append(action("btn sm", "Take it back", (event) => {
        void refund(p, event.currentTarget);
      }));
      body.push(acts);
    }
  } else if (p.status === "refunded") {
    head.textContent = "Your BTC is back in your wallet.";
    body.push(el("p", "sub", "The desk didn’t take it, so nothing was locked."));
  }
  const host = $("position-body");
  const opened = Boolean(host.querySelector("details")?.open);
  host.replaceChildren(head, ...body);
  const steps = progressSteps(p.status, p.refundable || Boolean(p.fundingTxid));
  if (steps) host.append(steps);
  const txs = txLinks(p);
  if (txs) host.append(txs);
  const more = el("details", "more");
  more.open = opened;
  const facts = el("dl", "kv");
  for (const [name, value] of [
    ["Position ID", p.restored ? p.id.replace(/^restore:/, "") : ""],
    ["Vault", p.vaultAddress],
    ["Paid to", p.payoutAddress || p.writerAddress],
    ["Price check", `Deribit BTC index, ${atTime(p.expiry)}`],
  ]) {
    if (value) facts.append(el("dt", "", name), el("dd", "", value));
  }
  more.append(el("summary", "", "Details"), facts);
  host.append(more);
  $("position-chart").parentElement.hidden = unlocked;
  if (unlocked) return;
  $("position-chart-title").textContent = `What you end up with on ${whenDay(p.expiry)}`;
  drawChart($("position-chart"), { kind: p.kind, k, q, pay, at, day: whenDay(p.expiry) });
}

function canSettle(position) {
  if (position.restored) return false;
  if (position.status !== "filled") return false;
  if (!position.vaultAddress || !(position.holderPkHex || position.deskPkHex) || !position.beaconTxid) return false;
  const expiry = Number(position.expiry) || 0;
  if (!expiry || expiry > Math.floor(Date.now() / 1000)) return false;
  if (position.settleTxid && position.settleTxid !== position.closeTxid) return false;
  return true;
}

function settleFault(outcome) {
  const detail = outcome.reason ? `${outcome.result} ${outcome.reason}` : outcome.result;
  if (outcome.result === "unfixed") return ["The price check isn’t published yet. Try again in a moment.", detail];
  if (outcome.result === "mismatch") return ["This position reads a different price feed. Try again in a moment.", detail];
  if (outcome.result === "waiting" && outcome.reason === "early") return ["Wait until the date.", detail];
  if (outcome.result === "waiting") return ["Try again in a moment.", detail];
  return ["Couldn’t pay out. Try again in a moment.", detail];
}

async function settlePosition(position, button) {
  button.disabled = true;
  button.textContent = isPredict(position.kind) ? "Settling" : "Paying out";
  try {
    const outcome = await settleFromPage({
      ...(await fundRequest(position)),
      fillTxid: position.closeTxid || undefined,
    });
    if (outcome.result !== "settled") {
      button.disabled = false;
      button.textContent = "Try again";
      const [sentence, detail] = settleFault(outcome);
      renderStatus($("status"), sentence, detail);
      return;
    }
    position.status = "settled";
    position.settleTxid = outcome.txid;
    // `writerKeep` is what came back to this page's user: the writer of an
    // option, the holder of a prediction.
    const mineOut = isPredict(position.kind) ? outcome.holder : outcome.writer;
    const deskOut = isPredict(position.kind) ? outcome.writer : outcome.holder;
    if (mineOut != null) position.writerKeep = mineOut.toString();
    if (deskOut != null) position.deskTake = deskOut.toString();
    if (outcome.price != null) position.settleCents = outcome.price.toString();
    persist();
    renderBlotter();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Try again";
    renderStatus($("status"), "Couldn’t pay out. Try again in a moment.", err instanceof Error ? err.message : "settle failed");
  }
}

function settleButton(position) {
  if (!canSettle(position)) return null;
  return action("btn sm", isPredict(position.kind) ? "Settle now" : "Pay out now", (event) => {
    void settlePosition(position, event.currentTarget);
  });
}

function txLink(label, txid) {
  if (!/^[0-9a-f]{64}$/.test(txid || "")) return null;
  const row = el("p", "tx-link");
  const link = el("a", "", `${txid.slice(0, 8)}…${txid.slice(-4)}`);
  link.href = `https://explorer.mutinynet.arkade.sh/tx/${txid}`;
  link.target = "_blank";
  link.rel = "noopener";
  row.append(el("span", "", label), link);
  return row;
}

function txLinks(position) {
  const box = el("div", "txs");
  const funding = txLink("Lock", position.fundingTxid);
  const refunded = position.status === "refunded";
  const refund = refunded ? txLink("Sent back", position.closeTxid) : null;
  const filled = position.status === "filled" || position.status === "settled";
  const completed = filled ? txLink("Payment to you", position.closeTxid) : null;
  const settlement = position.settleTxid && position.settleTxid !== position.closeTxid
    ? txLink("Payout", position.settleTxid)
    : null;
  if (!funding && !refund && !completed && !settlement) return null;
  for (const node of [funding, completed, settlement, refund]) {
    if (node) box.append(node);
  }
  return box;
}

let copiedUntil = 0;

async function copyToClipboard(button, text) {
  if (!text) return;
  const previous = button.textContent;
  copiedUntil = Date.now() + 1200;
  button.textContent = "Copied";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
      copiedUntil = 0;
      button.textContent = "Copy failed";
      return;
    }
  }
  setTimeout(() => {
    if (button.isConnected && Date.now() >= copiedUntil) button.textContent = previous;
  }, 1200);
}

function onTermsChanged() {
  pinnedExpiry = 0;
  dropQuote();
  renderSell();
}

function dropQuote() {
  quoteGen += 1;
  state.quoting = false;
  state.offer = null;
  state.quoteNote = "";
}

/** The only desk request: sent when "I understand" is ticked, or on Refresh offer. */
async function askQuote() {
  if (!state.checkout || !state.agree || !state.address || state.quoting || !ready()) return;
  const gen = ++quoteGen;
  const asked = terms();
  state.quoting = true;
  state.offer = null;
  state.quoteNote = "";
  renderFoot();
  try {
    const live = await requestQuotes({
      relays: RELAYS,
      desks: PINNED_DESKS,
      kind: asked.kind,
      strike: asked.strike,
      collateral: asked.size,
      expiry: asked.expiry,
      spotCents: state.spotCents,
      writerAddress: state.address,
    });
    if (gen !== quoteGen) return;
    const quote = live.quotes.length ? bestQuote(live.quotes, 0) : null;
    if (!quote) throw new Error(live.note || "The desk did not answer.");
    let deposit = null;
    // The vault is derived now, so the Lock click can open the wallet without waiting.
    if (takes(quote.sats)) {
      deposit = await depositAddress({
        kind: asked.kind,
        strike: asked.strike,
        collateral: asked.size,
        premium: quote.sats,
        expiry: asked.expiry,
        deadline: BigInt(quote.deadline),
        writerAddress: state.address,
        holderPkHex: quote.holderPkHex,
        beaconTxidHex: quote.beaconTxid,
        beaconGidx: quote.beaconGidx,
        exit: quote.exit != null ? BigInt(quote.exit) : undefined,
      });
      if (gen !== quoteGen) return;
      if (deposit.address !== quote.intentAddress || deposit.vaultAddress !== quote.vaultAddress) {
        throw new Error("The desk address does not match this page.");
      }
    }
    state.offer = { quote, deposit, terms: asked };
  } catch (err) {
    if (gen !== quoteGen) return;
    state.quoteNote = err instanceof Error ? err.message : "The desk did not answer.";
  }
  if (gen !== quoteGen) return;
  state.quoting = false;
  renderCheckout();
}

function onConfirm() {
  if (!state.address) {
    openWallet();
    return;
  }
  const quote = state.offer?.quote;
  const now = Math.floor(Date.now() / 1000);
  if (quote && state.offer.deposit && takes(quote.sats) && quote.validUntil > now && quote.deadline > now) lock();
  else void askQuote();
}

/** Synchronous from the click to window.open, so the wallet popup is not blocked. */
function lock() {
  const { quote, deposit, terms: locked } = state.offer;
  const now = Math.floor(Date.now() / 1000);
  let position = state.positions.find((item) => item.address === deposit.address && item.status === "locking");
  if (!position) {
    position = {
      id: crypto.randomUUID(),
      kind: locked.kind,
      strike: locked.strike,
      expiry: locked.expiry,
      collateral: locked.size,
      premiumSats: quote.sats,
      status: "locking",
      deadline: quote.deadline,
      address: deposit.address,
      holderPkHex: deposit.holderPkHex,
      beaconTxid: deposit.beaconTxidHex,
      beaconGidx: deposit.beaconGidx,
      exit: deposit.exit,
      vaultAddress: deposit.vaultAddress,
      writerAddress: state.address,
      payoutAddress: state.address,
      tenorSec: locked.tenorSec,
      createdAt: now,
      uri: deposit.uri,
    };
    state.positions.unshift(position);
  }
  persist();
  closeCheckout();
  state.selected = position.id;
  show("home");
  startWatch();
  openWallet(position);
}

function setKind(kind, mode) {
  if (state.kind !== kind) {
    state.kind = kind;
    state.open = "";
    closeCheckout();
    if (ready()) fitLine(kind);
    dropQuote();
  }
  show("sell", mode);
}

function openCheckout() {
  state.open = "";
  state.checkout = true;
  state.agree = false;
  state.walletFault = null;
  dropQuote();
  renderSell();
  $("checkout-change").focus();
}

function closeCheckout() {
  if (!state.checkout) return;
  state.checkout = false;
  state.agree = false;
  state.walletFault = null;
  dropQuote();
  renderCheckout();
  if (state.view === "sell") $("see").focus();
}

function connectAddress() {
  try {
    state.address = saveAddress($("account-key").value);
    $("account-error").textContent = "";
    $("account-key").value = "";
    show(lastCompose);
  } catch (err) {
    $("account-error").textContent = err instanceof Error ? err.message : "That address was not saved.";
  }
}

function disconnect() {
  clearAddress();
  state.address = "";
  dropQuote();
  show("connect");
}

async function hydrateMissing() {
  let changed = false;
  for (const position of state.positions) {
    if (position.payoutAddress || position.writerAddress) continue;
    const hex = position.writerHex || legacyWriterHex();
    if (!hex) continue;
    try {
      position.writerHex = position.writerHex || hex;
      position.payoutAddress = await writerPayoutAddress(hex);
      changed = true;
    } catch {
      // A position we cannot price stays out of the list.
    }
  }
  if (!changed) return;
  persist();
  renderBlotter();
}

async function fundRequest(position) {
  if (isPredict(position.kind)) {
    return {
      kind: position.kind,
      strike: position.strike,
      collateral: position.collateral,
      premium: position.premiumSats,
      expiry: position.expiry,
      deadline: BigInt(position.deadline),
      writerPkHex: position.deskPkHex,
      holderAddress: position.holderAddress || position.payoutAddress,
      beaconTxidHex: position.beaconTxid,
      beaconGidx: position.beaconGidx,
      exit: position.exit != null ? BigInt(position.exit) : undefined,
    };
  }
  const base = {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: position.premiumSats,
    expiry: position.expiry,
    deadline: BigInt(position.deadline),
    holderPkHex: position.holderPkHex,
    beaconTxidHex: position.beaconTxid,
    beaconGidx: position.beaconGidx,
    exit: position.exit != null ? BigInt(position.exit) : undefined,
  };
  if (position.writerAddress) return { ...base, writerAddress: position.writerAddress };
  const hex = position.writerHex || legacyWriterHex();
  if (!hex) throw new Error("This position has no address in this browser.");
  return { ...base, writerHex: hex };
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
      renderSell();
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
  renderSell();
  renderBlotter();
}

async function refund(position, button) {
  button.disabled = true;
  button.textContent = "Taking it back";
  try {
    await cancelIntent(await fundRequest(position));
    applyChain(position, await readIntent(watchRow(position)));
    if (position.status !== "refunded" && button.isConnected) {
      button.disabled = false;
      button.textContent = "Take it back";
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : "Couldn’t take it back";
  }
}

const CHAIN_STATUS = {
  open: "locking",
  funded: "deposited",
  expired: "expired",
  filled: "filled",
  refunded: "refunded",
};

function applyChain(position, update) {
  const next = CHAIN_STATUS[update.phase];
  if (!next) return;
  if (next === "locking" && position.status !== "locking") return;
  const fundingTxid = update.fundingTxid || position.fundingTxid || "";
  const closeTxid = update.closeTxid || position.closeTxid || "";
  const settleTxid = next === "refunded" ? "" : (update.settleTxid || position.settleTxid || "");
  const display = next === "filled" && settlementKnown({ settleTxid, closeTxid }) ? "settled" : next;
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
  renderSell();
  if (display === "settled") void fillKept();
}

function watchRow(position) {
  return {
    address: position.address,
    side: isPredict(position.kind) ? 1 : 0,
    writerAddress: position.writerAddress || position.holderAddress || position.payoutAddress || "",
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
  const rows = state.positions.filter((position) => position.address && (position.writerAddress || position.holderAddress) && !["refunded", "settled"].includes(position.status));
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
      if (!(position.holderPkHex || position.deskPkHex) || !position.beaconTxid) return "";
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
  renderFoot();
  betTick(now);
  for (const position of state.positions) {
    if (position.status !== "deposited" || !position.deadline || now < Number(position.deadline)) continue;
    if (!position.address || expiring.has(position.address)) continue;
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

/** A connect or send error shows in the drawer, on the position, or on the connect card. */
function walletError(position, sentence, detail = "") {
  if (!sentence) {
    state.walletFault = null;
    state.bet.fault = null;
    renderStatus(position ? $("status") : state.checkout ? $("checkout-status") : state.bet.checkout ? $("bet-status") : $("account-error"), "", "");
    if (!position && state.checkout) renderFoot();
    if (!position && state.bet.checkout) renderBetFoot();
    return;
  }
  const fault = { sentence, detail: clipDetail(detail) };
  if (position) {
    renderStatus($("status"), fault.sentence, fault.detail);
    return;
  }
  if (state.checkout) {
    state.walletFault = fault;
    renderFoot();
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
  const request = position ? (position.uri || paymentUri(position.address, sendAmount(position))) : "";
  const params = position ? { flow: "send", position: position.id } : { flow: "connect" };
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
  // The wallet redirects the window it was opened in. Keep this page, and let
  // that window post the return. A blocked popup stays here so the tester can allow it.
  if (!openWalletPopup(popupUrl)) {
    walletError(position, "Allow the popup, then try again.", "popup blocked");
  }
}

function applyWalletHandoff(handoff, pending) {
  if (handoff.kind === "connect" && pending === "connect") {
    try {
      state.address = saveAddress(handoff.address);
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
    if (state.checkout) {
      renderCheckout();
      void askQuote();
    } else if (state.bet.checkout) {
      renderBet();
      void askBet();
    } else {
      show(lastCompose);
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
  applyWalletHandoff(handoff, takeWalletAsk());
  showWalletHandoff(handoff);
}

function walletOpener() {
  try {
    if (!window.opener || window.opener === window) return null;
    return window.opener;
  } catch {
    return null;
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
  history.replaceState(null, "", stripWalletParams(location.href));
  applyWalletHandoff(handoff, pending);
  return false;
}

// ---------------------------------------------------------------------------
// Predict: an all-or-nothing call on where BTC closes, against the desk.
// The page holds and pays the stake; the desk writes and funds the payout.
// ---------------------------------------------------------------------------

const STAKES = [20_000n, 50_000n, 100_000n, 200_000n];
/** Lines offered around the current price, in dollars. */
const LINE_STEPS = [-100, -50, 0, 50, 100];
/** A close is offered while the 60s lock, a minute of window and the round trip still fit. */
const CLOSE_LEAD_S = PREDICT_LOCK_S + PREDICT_MIN_LEFT_S + 10;
const INDEX_MS = 2_000;
const TICKS_KEPT = 400;
const DIR = { 2: "above", 3: "below" };
const OTHER = { 2: "below", 3: "above" };

let betGen = 0;
let indexTimer = null;
let ticksSavedAt = 0;
/** Index prices this page has seen, newest last: [unix, cents]. */
const seen = [];

const localTime = (unix) => new Date(Number(unix) * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const utcTime = (unix) => `${hhmm(new Date(Number(unix) * 1000))} UTC`;
const usdCents = (cents) => `$${usdFromCents(BigInt(cents))}`;
const timesX = (m) => `${m.toFixed(2)}×`;
const won = (payout) => payout - BEACON_READ_FEE;
/** The review's units rule: sats under 0.001 BTC, ₿ at or above it. */
const amount = (sats) => (sats < 100_000n ? `${int(sats)} sats` : `₿${fmtBtc(sats)}`);

/** What the user sends: the stake for a prediction, the collateral for an option. */
function sendAmount(position) {
  return isPredict(position.kind) ? position.premiumSats : position.collateral;
}

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
  const list = closes();
  if (!list.some((item) => item.unix === state.bet.close)) state.bet.close = list[0].unix;
  return state.bet.close;
}

function betWindow(expiry) {
  return closes().find((item) => item.unix === Number(expiry))?.min ?? 5;
}

const priced = () => state.spotCents != null && state.points != null;
const spotDollars = () => Math.round(Number(state.spotCents) / 100);

function betTerms() {
  const line = spotDollars() + state.bet.step;
  return {
    kind: state.bet.kind,
    line,
    lineCents: BigInt(line) * 100n,
    stake: state.bet.stake,
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

/** Payout before the fee, or null when the desk would not quote it or it cannot beat the stake. */
function betPayout(stake, multiplier) {
  if (multiplier == null) return null;
  return predictPayout(stake, multiplier);
}

const beats = (payout, stake) => payout != null && won(payout) > stake;

function lineNote(step) {
  if (step === 0) return "Current price";
  return `$${Math.abs(step)} ${step > 0 ? "above" : "under"} current price`;
}

function lineTag(step) {
  if (step === 0) return "now";
  return `${step > 0 ? "+" : "−"}$${Math.abs(step)}`;
}

function closeClock(node) {
  const left = Number(node.dataset.close) - Math.floor(Date.now() / 1000);
  const text = left > 0 ? mmss(left) : "0:00";
  node.textContent = node.dataset.form === "left" ? `${text} left` : `in ${text}`;
}

function clockEl(className, unix, form = "in") {
  const node = el("span", className);
  node.dataset.close = String(unix);
  node.dataset.form = form;
  closeClock(node);
  return node;
}

function betSentenceInto(node, terms, tense) {
  const lead = { now: "I bet", past: "You bet", none: "You were going to bet" }[tense];
  node.replaceChildren(
    `${lead} `,
    el("span", "chip", `₿${fmtBtc(terms.stake)}`),
    " that BTC closes ",
    el("span", "chip", DIR[terms.kind]),
    " ",
    el("span", "chip", usd0(Number(terms.lineCents) / 100)),
    " at ",
    el("span", "chip", localTime(terms.expiry)),
    ".",
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
  for (const name of ["stake", "dir", "line", "close"]) chip(name).disabled = !ok;
  const coin = el("span", "btc", "₿");
  coin.setAttribute("aria-hidden", "true");
  chip("stake").replaceChildren(coin, fmtBtc(state.bet.stake));
  chip("stake").setAttribute("aria-label", `Stake, ${fmtBtc(state.bet.stake)} BTC`);
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
    note.textContent = state.loaded ? "We can’t get a fair price right now. Try again in a minute." : "Getting the current price…";
    see.disabled = true;
    see.textContent = "See what happens";
    renderBetPop();
    renderBet();
    return;
  }
  const t = betTerms();
  chip("line").replaceChildren(usd0(t.line), el("span", "delta", lineTag(t.step)));
  chip("line").setAttribute("aria-label", `Line, ${usd0(t.line)}, ${lineNote(t.step).toLowerCase()}`);
  const m = betMultiplier(t.kind, t.lineCents, t.expiry);
  const payout = betPayout(t.stake, m);
  document.querySelectorAll("[data-mult]").forEach((node) => {
    const each = betMultiplier(Number(node.dataset.mult), t.lineCents, t.expiry);
    node.textContent = each == null ? "" : timesX(each);
  });
  renderMarket();
  if (beats(payout, t.stake)) {
    note.replaceChildren("You win about ", el("b", "", `${int(won(payout))} sats`), ` if you’re right · ${timesX(m)} your stake, less the 1,000‑sat fee`);
  } else if (m == null) {
    note.textContent = "The desk doesn’t quote this line for this close. Pick one nearer the current price.";
  } else {
    note.textContent = `This wins about ${int(won(payout))} sats, which doesn’t beat your stake after the 1,000-sat fee. Bet more or pick a further line.`;
  }
  see.disabled = !beats(payout, t.stake);
  see.textContent = `See what happens at ${localTime(t.expiry)}`;
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
  const right = until ? clockEl("o-r", until) : el("span", "o-r", side || "");
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
    title = "How much BTC to bet?";
    hint = `The 1,000-sat price-check fee comes out of the payout at ${at}.`;
    const m = betMultiplier(t.kind, t.lineCents, t.expiry);
    const list = el("div", "opts");
    for (const stake of STAKES) {
      const payout = betPayout(stake, m);
      const ok = beats(payout, stake);
      list.append(optionRow({
        pick: `stake:${stake}`,
        on: stake === t.stake,
        label: `${fmtBtc(stake)} BTC`,
        note: `${int(stake)} sats`,
        side: ok ? `Win about ${int(won(payout))} sats` : "",
        off: ok ? "" : m == null
          ? "The desk doesn’t quote this line."
          : `Wins ${int(won(payout))} sats after the fee, not more than you put in.`,
      }));
    }
    const typed = el("form", "typed");
    typed.id = "bet-typed";
    const label = el("label", "", "Or type an amount");
    const field = el("span", "field");
    const sign = el("span", "btc", "₿");
    sign.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.id = "bet-typed-input";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = fmtBtc(t.stake);
    input.value = typedBefore;
    input.setAttribute("aria-describedby", "bet-typed-error");
    field.append(sign, input, el("span", "unit", "BTC"));
    label.append(field);
    const error = el("p", "error");
    error.id = "bet-typed-error";
    error.setAttribute("role", "status");
    const use = el("button", "btn sm", "Use this amount");
    use.type = "submit";
    typed.append(label, error, use);
    parts.push(list, typed);
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
        side: ok ? `${timesX(m)} · ${int(won(payout))} sats` : "",
        off: ok ? "" : m == null
          ? `Too ${(t.kind === 2) === (step < 0) ? "likely" : "unlikely"} for the desk to quote.`
          : `Wins ${int(won(payout))} sats after the fee, not more than you put in.`,
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
  pop.replaceChildren(heading, ...parts, el("p", "hint", hint));
  pop.hidden = false;
  const chip = document.querySelector(`[data-bchip="${state.bet.open}"]`);
  pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, pop.parentElement.clientWidth - pop.offsetWidth))}px`;
  pop.style.top = `${chip.offsetTop + chip.offsetHeight + 12}px`;
  const target = had || (focus ? pop.querySelector(".on, [data-pick]")?.dataset.pick : "");
  if (target) (pop.querySelector(`[data-pick="${target}"]`) || $(target))?.focus();
}

/** "0.0005" → 50,000 sats. Eight decimals at most. */
function parseStake(raw) {
  const text = String(raw).trim().replace(",", ".");
  if (!/^\d*\.?\d{0,8}$/.test(text) || !/\d/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole || "0") * 100_000_000n + BigInt(frac.padEnd(8, "0"));
}

function onBetPick(event) {
  const btn = event.target.closest("[data-pick]");
  if (!btn || btn.getAttribute("aria-disabled") === "true") return;
  const [what, value] = btn.dataset.pick.split(":");
  if (what === "stake") state.bet.stake = BigInt(value);
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
  const sats = parseStake($("bet-typed-input")?.value ?? "");
  const error = $("bet-typed-error");
  if (sats == null || sats < STAKE_MIN || sats > STAKE_MAX) {
    if (error) error.textContent = `Bet between ${fmtBtc(STAKE_MIN)} and ${fmtBtc(STAKE_MAX)} BTC.`;
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
  const optionsOpen = state.checkout && state.view === "sell";
  const betOpen = state.bet.checkout && state.view === "predict";
  const open = optionsOpen || betOpen;
  $("scrim").hidden = !open;
  document.body.classList.toggle("locked", open);
  for (const id of ["top", "main", "note"]) $(id).inert = open;
}

function openBet() {
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
  const line = usd0(Number(t.lineCents) / 100);
  betSentenceInto($("bet-said"), t, "now");
  if (beats(payout, t.stake)) {
    $("bet-head").replaceChildren(offer ? "You win " : "You win about ", el("span", "amt", amount(won(payout))), " if you’re right.");
    const sub = el("span", "", `₿${fmtBtc(won(payout))} · about ${usd0(worth(won(payout), spotUsd()))} at the current ${usd0(spotUsd())} · window closes `);
    sub.append(clockEl("", t.expiry));
    $("bet-sub").replaceChildren(sub);
  } else {
    $("bet-head").textContent = "This doesn’t beat your stake.";
    $("bet-sub").textContent = m == null
      ? "The desk doesn’t quote this line for this close."
      : `It wins ${int(won(payout))} sats after the 1,000-sat fee, not more than the ${int(t.stake)} you put in.`;
  }
  $("bet-fee-label").textContent = `Price-check fee at ${at}`;
  $("bet-rows-when").textContent = `If BTC at ${at} is`;
  const rows = [
    [`${capital(DIR[t.kind])} ${line}`, payout != null ? amount(won(payout)) : "—",
      payout != null ? `${int(won(payout))} sats · your ${int(t.stake)} back plus ${int(won(payout) - t.stake)}` : "", false],
    [`At or ${OTHER[t.kind]} ${line}`, "Nothing", `your ${int(t.stake)} sats go to the desk`, true],
  ];
  $("bet-rows").replaceChildren(...rows.map(([when, get, small, zero]) => {
    const row = el("div", "row");
    const value = el("span", zero ? "get zero" : "get", get);
    if (small) value.append(el("small", "", small));
    row.append(el("span", "when", when), value);
    return row;
  }));
  $("bet-agree-text").textContent = `I understand that if BTC is at or ${OTHER[t.kind]} ${line} at ${at}, I lose the ${int(t.stake)} sats I put in.`;
  $("bet-chart-title").textContent = `What you get back at ${at}`;
  drawStep($("bet-chart"), { kind: t.kind, line: Number(t.lineCents) / 100, stake: t.stake, payout: payout ?? 0n, now: t.step === 0 });
  renderBetFoot();
}

function betFault(note) {
  const detail = clipDetail(note);
  if (note.includes("float short")) return ["The desk can’t cover this payout right now. Bet less, or try again later.", detail];
  if (/refused: (spot|deribit) unavailable/.test(note)) return ["We can’t get a fair price right now. Try again in a moment.", detail];
  if (note.includes("refused: expiry")) return ["That window is closing too soon. Pick a later close.", detail];
  if (note.includes("refused: line")) return ["The desk doesn’t quote this line right now. Pick one nearer the current price.", detail];
  if (note.includes("refused: payout")) return ["This payout doesn’t beat your stake after the fee. Bet more or pick a further line.", detail];
  if (note.includes("refused: stake")) return [`Bet between ${fmtBtc(STAKE_MIN)} and ${fmtBtc(STAKE_MAX)} BTC.`, detail];
  if (note.includes("exposure")) return ["The desk has taken all it can for now. Try a smaller bet or a later close.", detail];
  if (note.includes("did not answer")) return ["The desk didn’t answer. Try again in a moment.", detail];
  return ["Try again in a moment.", detail];
}

/** The button, the firm multiplier and its ring. Runs every second while the drawer is open. */
function renderBetFoot() {
  if (!state.bet.checkout) return;
  const now = Math.floor(Date.now() / 1000);
  const quote = state.bet.offer?.quote;
  const left = quote ? Math.min(quote.validUntil, quote.deadline) - now : 0;
  const firm = $("bet-firm");
  let label = "Place bet";
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
    [sentence, detail] = betFault(state.bet.quoteNote);
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
      writerPkHex: quote.deskPkHex,
      beaconTxidHex: quote.beaconTxid,
      beaconGidx: quote.beaconGidx,
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
      beaconTxid: deposit.beaconTxidHex,
      beaconGidx: deposit.beaconGidx,
      exit: deposit.exit,
      vaultAddress: deposit.vaultAddress,
      holderAddress: state.address,
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
  openWallet(position);
}

// ----- positions -----

function betOutcome(p) {
  if (!(p.status === "settled" || settlementKnown(p))) return "";
  if (p.writerKeep === "" || p.writerKeep == null) return "settled";
  return BigInt(p.writerKeep) > 0n ? "won" : "lost";
}

function betStatusLabel(p) {
  const now = Math.floor(Date.now() / 1000);
  if (p.status === "locking") return p.walletTxid ? "Waiting for your BTC" : "Send your BTC";
  if (p.status === "deposited") return "Placing your bet";
  const outcome = betOutcome(p);
  if (outcome === "won") return "Won";
  if (outcome === "lost") return "Lost";
  if (outcome === "settled") return "Settled";
  if (p.status === "filled") return Number(p.expiry) > now ? "Live" : "Checking the price";
  if (p.status === "expired") return "Time ran out";
  if (p.status === "refunded") return "Refunded";
  return "Open";
}

function betIcon(kind) {
  const svg = svgEl("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  svg.append(
    svgEl("path", { d: kind === 2 ? "M2.5 15.5l4.5-4.5 3 2.5 6-8" : "M2.5 4.5l4.5 4.5 3-2.5 6 8" }),
    svgEl("path", { d: kind === 2 ? "M13 5.5h3.5V9" : "M13 14.5h3.5V11" }),
  );
  return svg;
}

function betRow(p) {
  const row = el("a", "prow");
  row.href = `#/positions/${p.id}`;
  const icon = el("span", p.kind === 3 ? "kindico put" : "kindico");
  icon.append(betIcon(p.kind));
  const what = el("span");
  const now = Math.floor(Date.now() / 1000);
  const live = p.status === "filled" && Number(p.expiry) > now;
  const meta = live && state.spotCents != null
    ? `Prediction · ₿${fmtBtc(p.premiumSats)} · BTC is ${usd0(spotUsd())} now`
    : `Prediction · ₿${fmtBtc(p.premiumSats)} · ${p.windowMin || 5}-minute window`;
  what.append(
    el("b", "", `${capital(DIR[p.kind])} ${usd0(Number(p.strike) / 100)} at ${localTime(p.expiry)}`),
    el("span", "m", meta),
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
  const pill = live ? clockEl("pill", p.expiry, "left") : el("span", outcome === "won" ? "pill ok" : outcome === "lost" ? "pill lost" : "pill", betStatusLabel(p));
  side.append(pill);
  let extra = "";
  if (outcome === "won") extra = `+${int(BigInt(p.writerKeep))} sats paid`;
  else if (outcome === "lost") extra = `−${int(p.premiumSats)} sats`;
  else if (["locking", "deposited", "filled"].includes(p.status)) extra = `${int(p.premiumSats)} in → ${int(won(p.collateral))} if right`;
  if (extra) side.append(el("small", "", extra));
  row.append(icon, what, side);
  return row;
}

/** The option chart card's title, caption and legend, after a prediction has used them. */
function optionChrome() {
  $("position-chart-cap").hidden = true;
  $("position-legend").replaceChildren(...[["a", "What you end up with"], ["m", "More than you lock"], ["l", "Less than you lock"], ["d", "What you lock"]].map(([key, text]) => {
    const item = el("span");
    item.append(el("i", key), text);
    return item;
  }));
}

function betLegend() {
  $("position-legend").replaceChildren(...[["p", "BTC price, Deribit index"], ["d", "Your line"], ["w", "You win"], ["k", "The desk wins"]].map(([key, text]) => {
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
    labels = ["Waiting for your BTC", "Bet placed", "Window closes", "Settled"];
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
  const lineUsd = usd0(line);
  const at = localTime(p.expiry);
  const stake = p.premiumSats;
  const payout = p.collateral;
  const outcome = betOutcome(p);
  const unlocked = p.status === "expired" || p.status === "refunded";
  betSentenceInto($("position-sentence"), { kind: p.kind, stake, lineCents: p.strike, expiry: p.expiry }, unlocked ? "none" : "past");
  const head = el("h2");
  const body = [];
  let badge = null;
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
  const fixing = p.settleCents ? Number(p.settleCents) / 100 : null;
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
    head.textContent = p.walletTxid ? "Your wallet sent it." : "Send your stake to place the bet.";
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
      ["You bet", `${int(stake)} sats`],
      ["From the desk", `+${int(payout - stake)}`],
      [`Price-check fee at ${at}`, `−${int(payout - back)}`, "minus"],
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
      ["You bet", `${int(stake)} sats`],
      [`To the desk, at or ${OTHER[p.kind]} ${lineUsd}`, `−${int(stake)}`, "minus"],
      ["Paid to you", "0 sats", "tot"],
    ]));
    body.push(el("p", "sub", "One fixing decides it. All or nothing, no partial payouts."), ...again());
  } else if (outcome === "settled") {
    head.textContent = "Settled.";
    body.push(el("p", "sub", "The vault paid out. Reading what came back…"));
  } else if (p.status === "filled" && Number(p.expiry) > now) {
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
    head.textContent = "Checking the price.";
    body.push(el("p", "sub", `The fixing at ${at} decides it, and the payout goes to your Arkade wallet. Nothing for you to do.`));
    const settle = settleButton(p);
    if (settle) {
      const acts = el("div", "acts");
      acts.append(settle);
      body.push(acts);
    }
  } else if (p.status === "expired") {
    head.textContent = p.refundable ? "The desk didn’t take it in time." : "Time ran out before your BTC arrived.";
    body.push(el("p", "sub", p.refundable ? `Your ₿${fmtBtc(stake)} is still yours. Take it back.` : "Nothing was bet."));
    if (p.refundable) {
      const acts = el("div", "acts");
      acts.append(action("btn sm", "Take it back", (event) => {
        void refund(p, event.currentTarget);
      }));
      body.push(acts);
    }
  } else if (p.status === "refunded") {
    head.textContent = "Your stake is back in your wallet.";
    body.push(el("p", "sub", "The desk didn’t take it, so nothing was bet."));
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
    const link = txLink(label, txid);
    if (link) txs.append(link);
  }
  if (txs.childNodes.length) host.append(txs);
  const more = el("details", "more");
  more.open = opened;
  const facts = el("dl", "kv");
  for (const [name, value] of [
    ["Vault", p.vaultAddress],
    ["Paid to", p.holderAddress || p.payoutAddress],
    ["Price check", `Deribit BTC index, ${utcTime(p.expiry)} on ${whenDay(p.expiry)}`],
    ["Multiplier", timesX(payoutMultiplierOf(p))],
  ]) {
    if (value) facts.append(el("dt", "", name), el("dd", "", value));
  }
  more.append(el("summary", "", "Details"), facts);
  host.append(more);
  const card = $("position-chart").parentElement;
  card.hidden = unlocked || p.status === "locking";
  if (card.hidden) return;
  const done = Boolean(outcome);
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

/** Payout steps: nothing at or past the line on the losing side, the whole payout on the winning side. */
function drawStep(host, { kind, line, stake, payout, now }) {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 190;
  const top = 34;
  const span = Math.max(300, Math.round(line * 0.004 / 50) * 50);
  const x0 = line - span;
  const x1 = line + span;
  const back = payout > 0n ? Number(won(payout)) : 0;
  const ymax = Math.max(back, Number(stake)) * 1.12 || 1;
  const X = (p) => 2 + ((p - x0) / (x1 - x0)) * (W - 4);
  const Y = (s) => top + (1 - s / ymax) * (H - top - 26);
  const yb = Y(0);
  const ys = Y(Number(stake));
  const yw = Y(back);
  const xl = X(line);
  const winLeft = kind === 3;
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `You get back ${int(back)} sats if BTC closes ${DIR[kind]} ${usd0(line)}, and nothing at or ${OTHER[kind]} it.`,
  });
  const winX = winLeft ? [2, xl] : [xl, W - 2];
  const loseX = winLeft ? [xl, W - 2] : [2, xl];
  const curve = winLeft
    ? `M2 ${yw}H${xl}V${yb}H${W - 2}`
    : `M2 ${yb}H${xl}V${yw}H${W - 2}`;
  svg.append(
    svgEl("rect", { x: winX[0], y: yw, width: winX[1] - winX[0], height: yb - yw, class: "area" }),
    svgEl("rect", { x: winX[0], y: yw, width: winX[1] - winX[0], height: Math.max(0, ys - yw), class: "more" }),
    svgEl("rect", { x: loseX[0], y: ys, width: loseX[1] - loseX[0], height: yb - ys, class: "less" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: ys, y2: ys, class: "lock" }),
    svgEl("path", { d: curve, class: "curve" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: yb, y2: yb, class: "base" }),
    svgEl("line", { x1: xl, x2: xl, y1: 4, y2: yb, class: "mark" }),
    svgEl("text", { x: winLeft ? xl - 7 : xl + 7, y: 14, "text-anchor": winLeft ? "end" : "start", class: "mark-label" }, `Your line${now ? " = now" : ""} · ${usd0(line)}`),
    svgEl("text", { x: winLeft ? 8 : W - 8, y: yw - 8, "text-anchor": winLeft ? "start" : "end", class: "paid" }, `${int(back)} back`),
    svgEl("text", { x: winLeft ? W - 8 : 8, y: ys - 7, "text-anchor": winLeft ? "end" : "start" }, `You put in ${int(stake)}`),
    svgEl("text", { x: winLeft ? W - 8 : 8, y: yb - 9, "text-anchor": winLeft ? "end" : "start", class: "nothing" }, "Nothing back"),
    svgEl("text", { x: 2, y: yb + 18, class: "tick" }, usd0(x0)),
    svgEl("text", { x: W - 2, y: yb + 18, "text-anchor": "end", class: "tick" }, usd0(x1)),
  );
  host.replaceChildren(svg);
}

/** BTC against the line over the window. The zone above or below the line is the bettor's. */
function drawRace(host, { kind, line, start, expiry, ticks, fixing, now }) {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 240;
  const top = 26;
  const points = ticks.filter(([t]) => t >= start - 5).map(([t, c]) => [t, c / 100]);
  const t0 = Math.min(start, points[0]?.[0] ?? start);
  const t1 = Math.max(expiry + 30, Math.min(now, expiry + 120));
  const prices = [line, ...points.map(([, p]) => p), ...(fixing != null ? [fixing] : [])];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.25, 25);
  lo -= pad;
  hi += pad;
  const X = (t) => 2 + ((t - t0) / (t1 - t0)) * (W - 4);
  const Y = (p) => top + (1 - (p - lo) / (hi - lo)) * (H - top - 26);
  const yl = Y(line);
  const yb = H - 26;
  const xe = X(expiry);
  const mine = kind === 2 ? [top, yl] : [yl, yb];
  const desk = kind === 2 ? [yl, yb] : [top, yl];
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": fixing != null
      ? `BTC against your ${usd0(line)} line. The fixing was ${usd2(fixing)}.`
      : `BTC against your ${usd0(line)} line until ${localTime(expiry)}.`,
  });
  svg.append(
    svgEl("rect", { x: 2, y: mine[0], width: W - 4, height: Math.max(0, mine[1] - mine[0]), class: "win" }),
    svgEl("rect", { x: 2, y: desk[0], width: W - 4, height: Math.max(0, desk[1] - desk[0]), class: "desk" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: yl, y2: yl, class: "lock" }),
    svgEl("text", { x: 8, y: kind === 2 ? yl - 7 : yl + 17, class: "halo" }, `Your line ${usd0(line)}`),
    svgEl("line", { x1: xe, x2: xe, y1: top - 14, y2: yb, class: "mark" }),
    svgEl("text", { x: xe - 6, y: top - 4, "text-anchor": "end", class: "mark-label" }, `Closes ${localTime(expiry)}`),
    svgEl("line", { x1: 2, x2: W - 2, y1: yb, y2: yb, class: "base" }),
    svgEl("text", { x: 2, y: yb + 18, class: "tick" }, localTime(t0)),
    svgEl("text", { x: W - 2, y: yb + 18, "text-anchor": "end", class: "tick" }, localTime(t1)),
  );
  if (points.length > 1) {
    const path = points.map(([t, p], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(p).toFixed(1)}`).join("");
    svg.append(svgEl("path", { d: path, class: "price" }));
  }
  const last = points.at(-1);
  if (last && fixing == null) {
    svg.append(
      svgEl("circle", { cx: X(last[0]), cy: Y(last[1]), r: 5, class: "dot" }),
      svgEl("text", { x: Math.min(W - 8, X(last[0]) + 9), y: Y(last[1]) - 8, "text-anchor": X(last[0]) > W - 90 ? "end" : "start", class: "today-label halo" }, usd0(last[1])),
    );
  }
  if (fixing != null) {
    svg.append(
      svgEl("circle", { cx: xe, cy: Y(fixing), r: 6, class: "dot fixing" }),
      svgEl("text", { x: xe - 10, y: Y(fixing) + (Y(fixing) < yl ? -10 : 20), "text-anchor": "end", class: "today-label halo" }, `Fixing ${usd2(fixing)}`),
    );
  }
  if (points.length < 2) {
    svg.append(svgEl("text", { x: W / 2, y: (top + yb) / 2, "text-anchor": "middle", class: "tick" }, "The price draws here while this page is open."));
  }
  host.replaceChildren(svg);
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
  $("spot-line").textContent = `BTC is $${usdFromCents(state.spotCents)} on the Deribit index.`;
  if (state.view === "predict" && !state.bet.open) renderPredict();
  else if (state.view === "predict") renderMarket();
  const shown = state.view === "home" && state.selected
    ? state.positions.find((p) => p.id === state.selected && isPredict(p.kind))
    : null;
  if (shown) renderPosition(shown);
  if (!livePredictions(now).length && state.view !== "predict") syncIndexPolling();
}

/** Once a second: the windows move, so the close and the drawer follow the clock. */
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
    if (p && p.status === "filled" && Math.abs(Number(p.expiry) - now) <= 1) renderPosition(p);
  }
}

// ----- the market panel: the price, its last minutes, the line and the close -----

const HISTORY_URL = "https://www.deribit.com/api/v2/public/get_index_chart_data?index_name=btc_usd&range=1h";
const MARKET_SPAN_S = 8 * 60;
let historyLoaded = false;

/** Six-second index prices for the last hour, so the chart has a past on first paint. */
async function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
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

/** Swap the figure's characters, rolling the ones that changed in the direction of the move. */
function setFigure(node, text) {
  const prev = node.dataset.text || "";
  if (prev === text) return;
  const value = (raw) => Number(raw.replace(/[^0-9.]/g, ""));
  const up = value(text) >= value(prev);
  const animate = prev.length === text.length;
  node.replaceChildren(...[...text].map((ch, i) => {
    const span = el("span", "digit", ch);
    if (animate && prev[i] !== ch && /\d/.test(ch)) span.classList.add(up ? "roll-up" : "roll-down");
    return span;
  }));
  node.dataset.text = text;
  node.setAttribute("aria-label", text);
}

function renderMarket() {
  if (state.view !== "predict") return;
  const now = Math.floor(Date.now() / 1000);
  const close = betClose();
  $("mkt-close").textContent = `Closes ${localTime(close)}`;
  marketClock(now);
  if (state.spotCents == null) return;
  const price = Number(state.spotCents) / 100;
  setFigure($("mkt-price"), usd2(price));
  const offer = state.bet.offer?.terms;
  const kind = offer ? offer.kind : state.bet.kind;
  const line = offer ? Number(offer.lineCents) / 100 : spotDollars() + state.bet.step;
  const gap = price - line;
  const sub = $("mkt-sub");
  const arrow = el("span", gap >= 0 ? "up" : "down");
  arrow.setAttribute("aria-hidden", "true");
  const ahead = kind === 2 ? gap > 0 : gap < 0;
  sub.replaceChildren(arrow, el("b", "", usd2(Math.abs(gap))), ` ${gap >= 0 ? "above" : "below"} your ${usd0(line)} line${Math.abs(gap) >= 0.01 ? ` · ${ahead ? "you’d win" : "the desk would win"} now` : ""}`);
  drawMarket($("mkt-chart"), { points: seen, line, kind, close, now });
}

function marketClock(now) {
  const node = $("mkt-count");
  if (!node || state.view !== "predict") return;
  const left = betClose() - now;
  node.textContent = left > 0 ? mmss(left) : "0:00";
}

function drawMarket(host, { points, line, kind, close, now }) {
  const W = Math.max(280, Math.floor(host.clientWidth));
  const H = W < 520 ? 128 : 212;
  const top = 14;
  const bottom = H - 24;
  const t0 = now - MARKET_SPAN_S;
  const t1 = Math.max(close + 20, now + 60);
  const pts = points.filter(([t]) => t >= t0 - 12).map(([t, c]) => [t, c / 100]);
  if (pts.length < 2) {
    const skel = el("div", "skel");
    skel.style.height = `${H}px`;
    host.replaceChildren(skel);
    return;
  }
  const prices = [line, ...pts.map(([, p]) => p)];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.2, 8);
  lo -= pad;
  hi += pad;
  const X = (t) => ((t - t0) / (t1 - t0)) * W;
  const Y = (p) => top + (1 - (p - lo) / (hi - lo)) * (bottom - top);
  const yl = Y(line);
  const xn = X(pts.at(-1)[0]);
  const xc = X(close);
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `BTC over the last ${MARKET_SPAN_S / 60} minutes against your ${usd0(line)} line, closing at ${localTime(close)}.`,
  });
  const defs = svgEl("defs", {});
  const fade = svgEl("linearGradient", { id: "mkt-fade", x1: 0, y1: 0, x2: 0, y2: 1 });
  fade.append(
    svgEl("stop", { offset: "0%", style: "stop-color: var(--ink); stop-opacity: .14" }),
    svgEl("stop", { offset: "100%", style: "stop-color: var(--ink); stop-opacity: 0" }),
  );
  defs.append(fade);
  const path = pts.map(([t, p], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(p).toFixed(1)}`).join("");
  const area = `${path}L${xn.toFixed(1)} ${bottom}L${X(pts[0][0]).toFixed(1)} ${bottom}Z`;
  const zone = kind === 2 ? [top - 14, yl] : [yl, bottom];
  const tagText = `Your line ${usd0(line)}`;
  const tagW = tagText.length * 7.2 + 14;
  // The tag sits in the time still to come, unless now is too close to the edge.
  const tagX = xn + 12 + tagW <= W - 10 ? W - tagW - 10 : 10;
  const tagY = Math.min(bottom - 22, Math.max(top - 6, yl - 11));
  const tag = svgEl("g", { class: "mkt-tag" });
  tag.append(svgEl("rect", { x: tagX, y: tagY, width: tagW, height: 22 }), svgEl("text", { x: tagX + 7, y: tagY + 15 }, tagText));
  svg.append(
    defs,
    svgEl("rect", { x: 0, y: zone[0], width: W, height: Math.max(0, zone[1] - zone[0]), class: "mkt-zone" }),
    svgEl("rect", { x: xn, y: top - 14, width: Math.max(0, W - xn), height: bottom - top + 14, class: "mkt-future" }),
    svgEl("line", { x1: xc, x2: xc, y1: top - 14, y2: bottom, class: "mkt-close" }),
    svgEl("path", { d: area, class: "mkt-area" }),
    svgEl("path", { d: path, class: "mkt-line" }),
    svgEl("line", { x1: 0, x2: W, y1: yl, y2: yl, class: "mkt-level" }),
    tag,
    svgEl("circle", { cx: xn, cy: Y(pts.at(-1)[1]), r: 4, class: "mkt-pulse" }),
    svgEl("circle", { cx: xn, cy: Y(pts.at(-1)[1]), r: 4, class: "mkt-now" }),
    svgEl("text", { x: 16, y: H - 6, class: "tick" }, localTime(t0)),
    svgEl("text", { x: Math.min(W - 16, xc), y: H - 6, "text-anchor": xc > W - 60 ? "end" : "middle", class: "tick" }, `close ${localTime(close)}`),
  );
  host.replaceChildren(svg);
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

/** The toggle shows where it goes: a moon in light, a sun in dark. */
function themeIcon(theme) {
  const svg = svgEl("svg", { viewBox: "0 0 20 20", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "square" });
  if (theme === "dark") {
    svg.append(svgEl("circle", { cx: 10, cy: 10, r: 3.5 }));
    for (const [x1, y1, x2, y2] of [[10, 1.5, 10, 3.5], [10, 16.5, 10, 18.5], [1.5, 10, 3.5, 10], [16.5, 10, 18.5, 10], [4, 4, 5.4, 5.4], [14.6, 14.6, 16, 16], [4, 16, 5.4, 14.6], [14.6, 5.4, 16, 4]]) {
      svg.append(svgEl("line", { x1, y1, x2, y2 }));
    }
  } else {
    svg.append(svgEl("path", { d: "M16.5 12.2A6.75 6.75 0 0 1 7.8 3.5a6.75 6.75 0 1 0 8.7 8.7z" }));
  }
  return svg;
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
  listen("top-connect", "click", () => show("connect"));
  listen("who", "click", () => show("connect"));
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "home") state.selected = null;
      show(btn.dataset.tab);
    });
  });
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => setKind(Number(btn.dataset.kind), state.view === "sell" ? "replace" : "push"));
  });
  document.querySelectorAll("[data-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.open = state.open === chip.dataset.chip ? "" : chip.dataset.chip;
      renderPop(true);
    });
  });
  listen("pop", "click", onPick);
  // A tap outside an open list only closes it, the way a sheet's backdrop does.
  document.addEventListener("click", (event) => {
    if (state.bet.open && !event.target.closest("#bet-pop, [data-bchip]")) {
      event.preventDefault();
      event.stopPropagation();
      state.bet.open = "";
      renderBetPop();
      return;
    }
    if (!state.open || event.target.closest("#pop, [data-chip]")) return;
    event.preventDefault();
    event.stopPropagation();
    state.open = "";
    renderPop();
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
    if (!state.open) {
      closeCheckout();
      return;
    }
    const chip = document.querySelector(`[data-chip="${state.open}"]`);
    state.open = "";
    renderPop();
    chip?.focus();
  });
  listen("see", "click", openCheckout);
  listen("checkout-change", "click", closeCheckout);
  listen("scrim", "click", () => {
    closeCheckout();
    closeBet();
  });
  bindBet();
  bindTheme();
  listen("agree", "change", () => {
    state.agree = $("agree").checked;
    if (state.agree) void askQuote();
    else dropQuote();
    renderFoot();
  });
  listen("confirm", "click", onConfirm);
  window.addEventListener("resize", () => {
    if (state.view === "home") renderBlotter();
    renderCheckout();
    renderBet();
    renderMarket();
  });
  document.querySelectorAll("[data-restore-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      restoreKind = Number(btn.dataset.restoreKind);
      document.querySelectorAll("[data-restore-kind]").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === btn));
      });
    });
  });
  listen("restore-form", "submit", (event) => {
    event.preventDefault();
    void submitRestore();
  });
}

function writerScriptOf(position) {
  if (position.writerScript) return position.writerScript;
  const address = position.writerAddress || position.payoutAddress;
  if (!address) return "";
  try {
    return pkScriptOf(address);
  } catch {
    return "";
  }
}

async function fillKept() {
  const rows = [...state.positions, ...state.restored];
  let localChanged = false;
  let any = false;
  await Promise.all(rows.map(async (position) => {
    if (position.keptChecked || position.writerKeep || !settlementKnown(position)) return;
    const script = writerScriptOf(position);
    if (!script) return;
    const split = await readKept(position.settleTxid, script, isPredict(position.kind) ? BigInt(position.expiry) : undefined);
    if (!split) return;
    position.keptChecked = true;
    position.writerKeep = split.writer.toString();
    position.deskTake = split.desk.toString();
    if (split.cents != null && !position.settleCents) position.settleCents = split.cents.toString();
    any = true;
    if (!position.restored) localChanged = true;
  }));
  if (localChanged) persist();
  if (any && state.view === "home") renderBlotter();
  if (any && state.view === "sell") renderSell();
  if (any && state.view === "predict") renderPredict();
}

async function submitRestore() {
  const button = $("restore-submit");
  const error = $("restore-error");
  if (error) error.textContent = "";
  if (button) {
    button.disabled = true;
    button.textContent = "Restoring";
  }
  try {
    const position = await restoreVault({
      outpoint: $("restore-outpoint").value,
      kind: restoreKind,
      strike: $("restore-strike").value,
      expiry: $("restore-expiry").value,
      collateral: $("restore-collateral").value,
      writerPk: $("restore-writer").value,
      holderPk: $("restore-holder").value,
      beaconTxid: $("restore-beacon").value,
      beaconGidx: $("restore-gidx").value,
      exit: $("restore-exit").value,
      readFee: $("restore-fee").value,
    });
    const index = state.restored.findIndex((item) => item.id === position.id);
    if (index >= 0) state.restored[index] = position;
    else state.restored.unshift(position);
    state.selected = position.id;
    show("home");
    await fillKept();
  } catch (err) {
    if (error) error.textContent = err instanceof Error ? err.message : "Could not restore that vault.";
  }
  if (button) {
    button.disabled = false;
    button.textContent = "Restore";
  }
}

async function loadSpot() {
  try {
    const cents = await btcUsdCents();
    if (cents != null && cents > 100_000n && cents < 1_000_000_000n) state.spotCents = cents;
  } catch {
    // A failed refresh keeps the last index price.
  }
}

/** Public Deribit reads only. The desk is asked nothing until the box is ticked. */
async function loadPrices() {
  const [, points] = await Promise.all([loadSpot(), fetchSurface().catch(() => null)]);
  state.points = points;
  state.loaded = true;
  $("spot-line").textContent = state.spotCents == null
    ? "Today’s BTC price isn’t loading."
    : `BTC is $${usdFromCents(state.spotCents)} on the Deribit index.`;
  renderSell();
  renderPredict();
  if (state.view === "home") renderBlotter();
}

function showFromHash(mode = "quiet") {
  const route = routeFromHash();
  if (route.view === "connect" && state.address) {
    show(lastCompose, "replace");
    return;
  }
  if (route.view === "sell") {
    setKind(route.kind, mode);
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
  void hydrateMissing();
}
