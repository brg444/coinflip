/**
 * Pure formatting, parsing, and error-copy helpers for the COINFLIP browser UI.
 * Zero DOM or network dependencies so every helper can be unit-tested directly in Node.
 */

export const DIR: Readonly<Record<2 | 3, string>> = { 2: "above", 3: "below" };
export const OTHER: Readonly<Record<2 | 3, string>> = { 2: "below", 3: "above" };

export function btcAmount(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function fmtBtc(sats: bigint): string {
  const neg = sats < 0n;
  const body = btcAmount(neg ? -sats : sats);
  return neg ? `-${body}` : body;
}

export function int(n: bigint | number | string): string {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function usd0(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}

export function usd2(x: number): string {
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A line in whole dollars, or to the cent when it has cents, as a window's opening price usually does. */
export function usdLine(x: number): string {
  return Math.round(x * 100) % 100 === 0 ? usd0(x) : usd2(x);
}

/** Dollars, with cents under $100 so a small payout still reads. */
export function usdFig(x: number): string {
  return x >= 100 ? usd0(x) : `$${x.toFixed(2)}`;
}

export function usdStake(x: number): string {
  return Number.isInteger(x) ? `$${x.toLocaleString("en-US")}` : `$${x.toFixed(2)}`;
}

export function worth(sats: bigint | number, usd: number): number {
  return (Number(sats) * usd) / 1e8;
}

export function capital(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

export function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function hhmm(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function whenDay(unix: number | bigint): string {
  return new Date(Number(unix) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

export function localTime(unix: number | bigint): string {
  return new Date(Number(unix) * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function utcTime(unix: number | bigint): string {
  return `${hhmm(new Date(Number(unix) * 1000))} UTC`;
}

export function shortAddress(address: string): string {
  if (!address || address.length < 20) return address || "";
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}

/** Shorten an address for the demo setup panel; the copy button copies it whole. */
export function shortAddress12(address: string): string {
  return address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address;
}

export function clipDetail(text: unknown): string {
  const line = String(text ?? "").split("\n").map((row) => row.trim()).find(Boolean) ?? "";
  return line
    .replace(/\b(authorization(?:\s*[:=]\s*bearer)?|bearer|token|secret|password)\s*[:=]?\s*\S+/gi, "$1 …")
    .slice(0, 240);
}

export function timesX(m: number): string {
  return `${m.toFixed(2)}×`;
}

export function amount(sats: bigint): string {
  return sats < 100_000n ? `${int(sats)} sats` : `₿${fmtBtc(sats)}`;
}

export function lineNote(step: number): string {
  if (step === 0) return "Current price";
  return `$${Math.abs(step)} ${step > 0 ? "above" : "under"} current price`;
}

export function lineTag(step: number): string {
  if (step === 0) return "now";
  return `${step > 0 ? "+" : "−"}$${Math.abs(step)}`;
}

/** "25" or "12.50" → dollars. Two decimals at most. */
export function parseUsd(raw: unknown): number | null {
  const text = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d*\.?\d{0,2}$/.test(text) || !/\d/.test(text)) return null;
  const usd = Number(text);
  return usd > 0 ? usd : null;
}

/** "0.0005" → 50,000 sats. Eight decimals at most. */
export function parseStake(raw: unknown): bigint | null {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!/^\d*\.?\d{0,8}$/.test(text) || !/\d/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole || "0") * 100_000_000n + BigInt(frac.padEnd(8, "0"));
}

export function betFault(note: string, stakeMin: bigint, stakeMax: bigint): [string, string] {
  const detail = clipDetail(note);
  if (note.includes("float short")) return ["The desk can’t cover this payout right now. Stake less, or try again later.", detail];
  if (/refused: (spot|deribit) unavailable/.test(note)) return ["We can’t get a fair price right now. Try again in a moment.", detail];
  if (note.includes("refused: expiry")) return ["That window is closing too soon. Pick a later close.", detail];
  if (note.includes("refused: window line")) return ["The window’s opening price has moved on. Review the prediction again.", detail];
  if (note.includes("refused: line")) return ["The desk doesn’t quote this line right now. Pick one nearer the current price.", detail];
  if (note.includes("refused: payout")) return ["This payout doesn’t beat your stake. Stake more or pick a further line.", detail];
  if (note.includes("refused: stake")) return [`Stake between ${fmtBtc(stakeMin)} and ${fmtBtc(stakeMax)} BTC.`, detail];
  if (note.includes("exposure")) return ["The desk has taken all it can for now. Try a smaller stake or a later close.", detail];
  if (note.includes("did not answer")) return ["The desk didn’t answer. Try again in a moment.", detail];
  return ["Try again in a moment.", detail];
}
