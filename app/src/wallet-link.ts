// Wallet app links (arkade-os/wallet #1033). URLSearchParams, because a BIP21
// and a callback both contain "?" and "&". The wallet redirects the window it
// was opened in; it does not postMessage. A popup callback carries `popup=1`
// so that window can hand the return to its opener and close.

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RETURN = ["address", "pubkey", "error", "status", "txid", "flow", "position", "popup", "relay"];
const OUTCOME = ["address", "pubkey", "error", "status", "txid"];

export const WALLET_HANDOFF_TYPE = "arkade-wallet-handoff";

export type WalletHandoff =
  | { kind: "none" }
  | { kind: "connect"; address: string; pubkey: string }
  | { kind: "connect-error"; error?: string; status?: string }
  | { kind: "send-error"; positionId: string; error?: string; status?: string }
  | { kind: "sent"; positionId: string; txid?: string };

/** https, or http on localhost. No username or password. */
export function callbackAllowed(callback: string): boolean {
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL.has(url.hostname);
}

/** Drop a previous wallet return, then keep the params this page still wants. */
export function pageCallback(href: string, params: Record<string, string>): string {
  const url = new URL(href);
  for (const key of RETURN) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function stripWalletParams(href: string): string {
  const url = new URL(pageCallback(href, {}));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function walletAppUrl(origin: string, action: "connect" | "send", callback: string, request?: string): string {
  if (!callbackAllowed(callback)) throw new Error("The wallet cannot return to this page.");
  const url = new URL(origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("action", action);
  if (request) url.searchParams.set("request", request);
  url.searchParams.set("callback", callback);
  return url.toString();
}

function hex64(value: string | null): string | undefined {
  const hex = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

export type WalletHandoffMessage = {
  type: typeof WALLET_HANDOFF_TYPE;
  handoff: WalletHandoff;
};

/** postMessage targetOrigin. A callback origin, with no path or userinfo. */
export function walletMessageTarget(origin: string): string | null {
  if (!callbackAllowed(origin)) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hasWalletOutcome(search: string): boolean {
  const params = new URLSearchParams(search);
  return OUTCOME.some((key) => {
    const value = params.get(key);
    return value != null && value !== "";
  });
}

function walletDetail(error?: string, status?: string): { error?: string; status?: string } {
  return {
    ...(error ? { error } : {}),
    ...(status ? { status } : {}),
  };
}

function messageHandoff(handoff: WalletHandoff): WalletHandoff {
  if (handoff.kind === "connect") {
    return { kind: "connect", address: handoff.address, pubkey: handoff.pubkey };
  }
  if (handoff.kind === "connect-error") return { kind: "connect-error", ...walletDetail(handoff.error, handoff.status) };
  if (handoff.kind === "send-error") {
    return { kind: "send-error", positionId: handoff.positionId, ...walletDetail(handoff.error, handoff.status) };
  }
  if (handoff.kind === "sent") {
    return handoff.txid
      ? { kind: "sent", positionId: handoff.positionId, txid: handoff.txid }
      : { kind: "sent", positionId: handoff.positionId };
  }
  return { kind: "none" };
}

/** The return the opener applies. Nothing to report is not a message. */
export function walletHandoffMessage(search: string): WalletHandoffMessage | null {
  const handoff = readWalletHandoff(search);
  if (handoff.kind === "none" && !hasWalletOutcome(search)) return null;
  return { type: WALLET_HANDOFF_TYPE, handoff: messageHandoff(handoff) };
}

/**
 * A wallet return loaded in the window this page opened. A full-page round
 * trip has no `popup=1`, so it stays on this page instead of posting.
 */
export function popupHandoffMessage(search: string, hasOpener: boolean): WalletHandoffMessage | null {
  if (!hasOpener || new URLSearchParams(search).get("popup") !== "1") return null;
  return walletHandoffMessage(search);
}

/** Accept only the handoff this page posts. Extra fields are dropped. */
export function readWalletHandoffMessage(data: unknown): WalletHandoff | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { type?: unknown; handoff?: unknown };
  if (record.type !== WALLET_HANDOFF_TYPE || !record.handoff || typeof record.handoff !== "object") return null;
  const handoff = record.handoff as Record<string, unknown>;
  if (handoff.kind === "none") return { kind: "none" };
  if (handoff.kind === "connect-error" || handoff.kind === "send-error") {
    const error = typeof handoff.error === "string" ? clipLine(handoff.error) : "";
    const status = typeof handoff.status === "string" ? clipLine(handoff.status) : "";
    const detail = walletDetail(error, status);
    if (handoff.kind === "send-error") {
      if (typeof handoff.positionId !== "string" || !handoff.positionId.trim()) return null;
      return { kind: "send-error", positionId: handoff.positionId.trim(), ...detail };
    }
    return { kind: "connect-error", ...detail };
  }
  if (handoff.kind === "connect") {
    const address = typeof handoff.address === "string" ? handoff.address.trim() : "";
    const pubkey = hex64(typeof handoff.pubkey === "string" ? handoff.pubkey : null);
    if (!address || !pubkey) return null;
    return { kind: "connect", address, pubkey };
  }
  if (handoff.kind === "sent") {
    if (typeof handoff.positionId !== "string") return null;
    const positionId = handoff.positionId.trim();
    if (handoff.txid == null) return { kind: "sent", positionId };
    const txid = hex64(typeof handoff.txid === "string" ? handoff.txid : null);
    if (!txid) return null;
    return { kind: "sent", positionId, txid };
  }
  return null;
}

function clipLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 180) ?? "";
}

/** An error wins, so a denial does not keep a prefilled address. */
export function readWalletHandoff(search: string): WalletHandoff {
  const params = new URLSearchParams(search);
  const flow = params.get("flow");
  const positionId = params.get("position")?.trim() ?? "";
  const error = clipLine(params.get("error") ?? "");
  const status = clipLine(params.get("status") ?? "");
  if (error) {
    const detail = walletDetail(error, status && status !== "sent" ? status : "");
    if (flow === "connect") return { kind: "connect-error", ...detail };
    if (flow === "send") return { kind: "send-error", positionId, ...detail };
    return { kind: "none" };
  }
  if (status && status !== "sent") {
    if (flow === "connect") return { kind: "connect-error", status };
    if (flow === "send") return { kind: "send-error", positionId, status };
  }
  if (flow === "send" && status === "sent") {
    return { kind: "sent", positionId, txid: hex64(params.get("txid")) };
  }
  if (flow === "connect") {
    const address = params.get("address")?.trim() ?? "";
    const pubkey = hex64(params.get("pubkey"));
    if (address && pubkey) return { kind: "connect", address, pubkey };
    return { kind: "connect-error" };
  }
  return { kind: "none" };
}
