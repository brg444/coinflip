import { el, svgEl } from "./dom.ts";
import { DIR, int, localTime, OTHER, usd0, usd2, usdLine } from "./format.ts";

/**
 * Pure SVG chart renderers for COINFLIP:
 *  - drawStep:   binary payoff step diagram in checkout
 *  - drawRace:   live / settled position price track against the line
 *  - drawMarket: rolling 8-minute BTC/USD chart beside the composer
 */

export const MARKET_SPAN_S = 8 * 60;

export type StepChartInput = {
  kind: 2 | 3;
  line: number;
  stake: bigint;
  payout: bigint;
  now: boolean;
};

/** Payout steps: nothing at or past the line on the losing side, the whole payout on the winning side. */
export function drawStep(host: HTMLElement, { kind, line, stake, payout, now }: StepChartInput): void {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 190;
  const top = 34;
  const span = Math.max(300, Math.round((line * 0.004) / 50) * 50);
  const x0 = line - span;
  const x1 = line + span;
  const back = payout > 0n ? Number(payout) : 0;
  const ymax = Math.max(back, Number(stake)) * 1.12 || 1;
  const X = (p: number) => 2 + ((p - x0) / (x1 - x0)) * (W - 4);
  const Y = (s: number) => top + (1 - s / ymax) * (H - top - 26);
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
    "aria-label": `You get back ${int(back)} sats if BTC closes ${DIR[kind]} ${usdLine(line)}, and nothing at or ${OTHER[kind]} it.`,
  });
  const winX: [number, number] = winLeft ? [2, xl] : [xl, W - 2];
  const loseX: [number, number] = winLeft ? [xl, W - 2] : [2, xl];
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
    svgEl("text", { x: winLeft ? xl - 7 : xl + 7, y: 14, "text-anchor": winLeft ? "end" : "start", class: "mark-label" }, `Your line${now ? " = now" : ""} · ${usdLine(line)}`),
    svgEl("text", { x: winLeft ? 8 : W - 8, y: yw - 8, "text-anchor": winLeft ? "start" : "end", class: "paid" }, `${int(back)} back`),
    svgEl("text", { x: winLeft ? W - 8 : 8, y: ys - 7, "text-anchor": winLeft ? "end" : "start" }, `You put in ${int(stake)}`),
    svgEl("text", { x: winLeft ? W - 8 : 8, y: yb - 9, "text-anchor": winLeft ? "end" : "start", class: "nothing" }, "Nothing back"),
    svgEl("text", { x: 2, y: yb + 18, class: "tick" }, usd0(x0)),
    svgEl("text", { x: W - 2, y: yb + 18, "text-anchor": "end", class: "tick" }, usd0(x1)),
  );
  host.replaceChildren(svg);
}

export type RaceChartInput = {
  kind: 2 | 3;
  line: number;
  start: number;
  expiry: number;
  ticks: [number, number][];
  fixing: number | null;
  now: number;
};

/** BTC against the line over the window. The zone above or below the line is the bettor's. */
export function drawRace(host: HTMLElement, { kind, line, start, expiry, ticks, fixing, now }: RaceChartInput): void {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 240;
  const top = 26;
  const points: [number, number][] = ticks.filter(([t]) => t >= start - 5).map(([t, c]) => [t, c / 100]);
  const t0 = Math.min(start, points[0]?.[0] ?? start);
  const t1 = Math.max(expiry + 30, Math.min(now, expiry + 120));
  const prices = [line, ...points.map(([, p]) => p), ...(fixing != null ? [fixing] : [])];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.25, 25);
  lo -= pad;
  hi += pad;
  const X = (t: number) => 2 + ((t - t0) / (t1 - t0)) * (W - 4);
  const Y = (p: number) => top + (1 - (p - lo) / (hi - lo)) * (H - top - 26);
  const yl = Y(line);
  const yb = H - 26;
  const xe = X(expiry);
  const mine: [number, number] = kind === 2 ? [top, yl] : [yl, yb];
  const desk: [number, number] = kind === 2 ? [yl, yb] : [top, yl];
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": fixing != null
      ? `BTC against your ${usdLine(line)} line. The fixing was ${usd2(fixing)}.`
      : `BTC against your ${usdLine(line)} line until ${localTime(expiry)}.`,
  });
  svg.append(
    svgEl("rect", { x: 2, y: mine[0], width: W - 4, height: Math.max(0, mine[1] - mine[0]), class: "win" }),
    svgEl("rect", { x: 2, y: desk[0], width: W - 4, height: Math.max(0, desk[1] - desk[0]), class: "desk" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: yl, y2: yl, class: "lock" }),
    svgEl("text", { x: 8, y: kind === 2 ? yl - 7 : yl + 17, class: "halo" }, `Your line ${usdLine(line)}`),
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

let marketFit = { key: "", height: 0 };

/**
 * Chart height for the space the card has. Beside the bet it grows until the
 * card ends level with the bet column, as long as the sticky card still fits
 * on screen. Above the bet it takes a share of the width and of the screen.
 * Phones keep a short chart so the bet and its button fit.
 */
function chartHeight(host: HTMLElement, W: number, readyForFit: boolean): number {
  if (W < 520 && host.closest(".market")) {
    const view = document.documentElement;
    const key = `${view.clientWidth}x${view.clientHeight}|${document.fonts?.status ?? "loaded"}`;
    if (marketFit.key === key) return marketFit.height;
    const predict = document.getElementById("predict");
    const page = document.getElementById("main");
    const nav = document.querySelector(".nav");
    const floor = nav && getComputedStyle(nav).position === "fixed" ? nav.getBoundingClientRect().top + window.scrollY : view.clientHeight;
    const padding = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
    const end = predict && !predict.hidden ? predict.getBoundingClientRect().bottom + window.scrollY + padding : floor;
    const spare = Math.min(view.clientHeight, floor) - end - 4;
    const base = host.offsetHeight > 0 ? host.offsetHeight : 120;
    const height = Math.round(Math.min(W < 420 ? 260 : 280, Math.max(120, base + spare)));
    if (readyForFit) marketFit = { key, height };
    return height;
  }
  if (W < 420) return 104;
  if (W < 520) return 128;
  const card = host.closest(".market") as HTMLElement | null;
  const rest = card ? card.offsetHeight - host.offsetHeight : 170;
  const screen = window.innerHeight;
  if (window.matchMedia("(min-width: 1101px)").matches) {
    const compose = card?.parentElement?.querySelector(".compose") as HTMLElement | null;
    const level = compose ? compose.offsetHeight - rest : 212;
    const onScreen = screen - 96 - 24 - rest;
    return Math.round(Math.max(212, Math.min(level, onScreen, W * 0.75)));
  }
  return Math.round(Math.max(160, Math.min(W * 0.3, screen * 0.28, 280)));
}

export type MarketChartInput = {
  points: [number, number][];
  line: number | null;
  kind: 2 | 3;
  close: number;
  now: number;
  showLine?: boolean;
  windowed?: boolean;
  readyForFit?: boolean;
};

export function drawMarket(
  host: HTMLElement,
  { points, line, kind, close, now, showLine = true, windowed = false, readyForFit = false }: MarketChartInput,
): void {
  const W = Math.max(280, Math.floor(host.clientWidth));
  const H = chartHeight(host, W, readyForFit);
  const top = 14;
  const bottom = H - 24;
  const t0 = now - MARKET_SPAN_S;
  const t1 = Math.max(close + 20, now + 60);
  const pts: [number, number][] = points.filter(([t]) => t >= t0 - 12).map(([t, c]) => [t, c / 100]);
  if (pts.length < 2) {
    const skel = el("div", "skel");
    skel.style.height = `${H}px`;
    host.replaceChildren(skel);
    return;
  }
  const hasLine = showLine && line != null;
  const lineVal = line ?? 0;
  const prices = hasLine ? [lineVal, ...pts.map(([, p]) => p)] : pts.map(([, p]) => p);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.2, 8);
  lo -= pad;
  hi += pad;
  const X = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const Y = (p: number) => top + (1 - (p - lo) / (hi - lo)) * (bottom - top);
  const yl = hasLine ? Y(lineVal) : 0;
  const last = pts.at(-1)!;
  const xn = X(last[0]);
  const xc = X(close);
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": hasLine
      ? `BTC over the last ${MARKET_SPAN_S / 60} minutes against your ${usdLine(lineVal)} line, closing at ${localTime(close)}.`
      : `BTC over the last ${MARKET_SPAN_S / 60} minutes, closing at ${localTime(close)}.`,
  });
  const defs = svgEl("defs", {});
  const fade = svgEl("linearGradient", { id: "mkt-fade", x1: 0, y1: 0, x2: 0, y2: 1 });
  fade.append(
    svgEl("stop", { offset: "0%", style: "stop-color: var(--ink); stop-opacity: .14" }),
    svgEl("stop", { offset: "100%", style: "stop-color: var(--ink); stop-opacity: 0" }),
  );
  defs.append(fade);
  const path = pts.map(([t, p], i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(p).toFixed(1)}`).join("");
  const area = `${path}L${xn.toFixed(1)} ${bottom}L${X(pts[0]![0]).toFixed(1)} ${bottom}Z`;
  const zone: [number, number] = kind === 2 ? [top - 14, yl] : [yl, bottom];
  const tagText = W < 520 ? usdLine(lineVal) : `${windowed ? "Opening price" : "Your line"} ${usdLine(lineVal)}`;
  const tagW = tagText.length * 7.2 + 14;
  const tagX = xn + 12 + tagW <= W - 10 ? W - tagW - 10 : 10;
  const tagY = Math.min(bottom - 22, Math.max(top - 6, yl - 11));
  const tag = svgEl("g", { class: "mkt-tag" });
  tag.append(svgEl("rect", { x: tagX, y: tagY, width: tagW, height: 22 }), svgEl("text", { x: tagX + 7, y: tagY + 15 }, tagText));
  svg.append(
    defs,
    ...(hasLine ? [svgEl("rect", { x: 0, y: zone[0], width: W, height: Math.max(0, zone[1] - zone[0]), class: "mkt-zone" })] : []),
    svgEl("rect", { x: xn, y: top - 14, width: Math.max(0, W - xn), height: bottom - top + 14, class: "mkt-future" }),
    svgEl("line", { x1: xc, x2: xc, y1: top - 14, y2: bottom, class: "mkt-close" }),
    svgEl("path", { d: area, class: "mkt-area" }),
    svgEl("path", { d: path, class: "mkt-line" }),
    ...(hasLine ? [svgEl("line", { x1: 0, x2: W, y1: yl, y2: yl, class: "mkt-level" }), tag] : []),
    svgEl("circle", { cx: xn, cy: Y(last[1]), r: 4, class: "mkt-pulse" }),
    svgEl("circle", { cx: xn, cy: Y(last[1]), r: 4, class: "mkt-now" }),
    svgEl("text", { x: 16, y: H - 6, class: "tick" }, localTime(t0)),
    svgEl("text", { x: Math.min(W - 16, xc), y: H - 6, "text-anchor": xc > W - 60 ? "end" : "middle", class: "tick" }, `close ${localTime(close)}`),
  );
  host.replaceChildren(svg);
}
