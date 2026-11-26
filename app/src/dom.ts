import { clipDetail } from "./format.ts";

/**
 * Shared DOM, SVG icon, status-line, and clipboard helpers for the COINFLIP page.
 */

export function svgEl(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function action(
  className: string,
  text: string,
  fn: (event: MouseEvent) => void,
): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}

export function markStep(item: HTMLElement, kind: string, busy = false): void {
  item.className = kind;
  if (!busy) return;
  const spin = el("span", "spin");
  spin.setAttribute("aria-hidden", "true");
  item.append(spin);
}

export function renderStatus(node: HTMLElement | null, sentence: string, detail?: string): void {
  if (!node) return;
  node.replaceChildren();
  if (sentence) node.append(document.createTextNode(sentence));
  const shown = detail && detail !== sentence ? clipDetail(detail) : "";
  if (shown) node.append(el("code", "fault", shown));
}

export function txLink(label: string, txid: string | undefined, explorerTxUrl: string): HTMLParagraphElement | null {
  if (!/^[0-9a-f]{64}$/.test(txid || "")) return null;
  const row = el("p", "tx-link");
  const link = el("a", "", `${txid!.slice(0, 8)}…${txid!.slice(-4)}`);
  link.href = `${explorerTxUrl}${txid}`;
  link.target = "_blank";
  link.rel = "noopener";
  row.append(el("span", "", label), link);
  return row;
}

let copiedUntil = 0;

export async function copyToClipboard(button: HTMLElement, text: string): Promise<void> {
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

export function closeGlyph(): SVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 14 14", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M2.5 2.5l9 9M11.5 2.5l-9 9" }));
  return svg;
}

export function betIcon(kind: number): SVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  svg.append(
    svgEl("path", { d: kind === 2 ? "M2.5 15.5l4.5-4.5 3 2.5 6-8" : "M2.5 4.5l4.5 4.5 3-2.5 6 8" }),
    svgEl("path", { d: kind === 2 ? "M13 5.5h3.5V9" : "M13 14.5h3.5V11" }),
  );
  return svg;
}

/** The toggle shows where it goes: a moon in light, a sun in dark. */
export function themeIcon(theme: "light" | "dark"): SVGElement {
  const svg = svgEl("svg", {
    viewBox: "0 0 20 20",
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "square",
  });
  if (theme === "dark") {
    svg.append(svgEl("circle", { cx: 10, cy: 10, r: 3.5 }));
    for (const [x1, y1, x2, y2] of [
      [10, 1.5, 10, 3.5], [10, 16.5, 10, 18.5], [1.5, 10, 3.5, 10], [16.5, 10, 18.5, 10],
      [4, 4, 5.4, 5.4], [14.6, 14.6, 16, 16], [4, 16, 5.4, 14.6], [14.6, 5.4, 16, 4],
    ] as const) {
      svg.append(svgEl("line", { x1, y1, x2, y2 }));
    }
  } else {
    svg.append(svgEl("path", { d: "M16.5 12.2A6.75 6.75 0 0 1 7.8 3.5a6.75 6.75 0 1 0 8.7 8.7z" }));
  }
  return svg;
}

/** Swap the figure's characters, rolling the ones that changed in the direction of the move. */
export function setFigure(node: HTMLElement, text: string): void {
  const prev = node.dataset.text || "";
  if (prev === text) return;
  const value = (raw: string) => Number(raw.replace(/[^0-9.]/g, ""));
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
