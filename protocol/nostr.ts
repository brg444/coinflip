import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

import { POSITION_KIND, POSITION_TAG, RFQ_KIND } from "./constants.ts";
import { parsePosition, parseWire, type OptionPosition, type Wire } from "./messages.ts";
import type { RfqMessage, RfqTransport } from "./ports.ts";

const ARKADE_RELAY = "wss://nostr.arkade.sh";

type Sealed = {
  id: string;
  pubkey: string;
  content: string;
  kind: number;
  tags: string[][];
  created_at: number;
  sig: string;
};

export function nostrPubkey(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

/** Quotes use nostr.arkade.sh. Any other relay in the list is ignored when it is present. */
export function quoteRelay(relays: readonly string[]): string {
  const arkade = relays.find((url) => url.replace(/\/$/, "") === ARKADE_RELAY);
  if (arkade) return ARKADE_RELAY;
  const first = relays.find((url) => url.startsWith("wss://"));
  if (!first) throw new Error("no relays");
  return first.replace(/\/$/, "");
}

export function seal(secretKey: Uint8Array, recipientPubkey: string, payload: Wire, now = Math.floor(Date.now() / 1000)): Sealed {
  const conversationKey = getConversationKey(secretKey, recipientPubkey);
  return finalizeEvent({
    kind: RFQ_KIND,
    created_at: now,
    tags: [["p", recipientPubkey]],
    content: encrypt(JSON.stringify(payload), conversationKey),
  }, secretKey);
}

export function openSealed(secretKey: Uint8Array, event: { pubkey: string; content: string }): Wire | null {
  try {
    const conversationKey = getConversationKey(secretKey, event.pubkey);
    const text = decrypt(event.content, conversationKey);
    return parseWire(JSON.parse(text));
  } catch {
    return null;
  }
}

export type Incoming = RfqMessage;

export type Transport = RfqTransport;

/** Signed NIP-78 event. `d` is the rfq id, so a later publish replaces this one. */
export function positionEvent(secretKey: Uint8Array, position: OptionPosition, now = Math.floor(Date.now() / 1000)): Sealed {
  return finalizeEvent({
    kind: POSITION_KIND,
    created_at: now,
    tags: [["d", position.rfq_id], ["t", POSITION_TAG]],
    content: JSON.stringify(position),
  }, secretKey);
}

/** A verified public vault. The signer is either party (holder or writer). Sealed RFQs do not pass. */
export function readPosition(event: Sealed): OptionPosition | null {
  if (event.kind !== POSITION_KIND) return null;
  if (!event.tags.some((tag) => tag[0] === "t" && tag[1] === POSITION_TAG)) return null;
  if (!event.tags.some((tag) => tag[0] === "d" && tag[1])) return null;
  try {
    if (!verifyEvent(event)) return null;
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  const position = parsePosition(body);
  if (!position) return null;
  if (position.holder_pubkey !== event.pubkey && position.writer_pubkey !== event.pubkey) return null;
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (id !== position.rfq_id) return null;
  return position;
}

function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return null;
}

function parseFrame(data: unknown): unknown[] | null {
  const text = frameText(data);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendFrame(ws: WebSocket, frame: unknown) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("nostr.arkade.sh is not connected");
  }
  ws.send(JSON.stringify(frame));
}

function connectSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error("nostr.arkade.sh did not connect"));
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    }, 8_000);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => fail(new Error("nostr.arkade.sh did not connect")));
  });
}

function isEvent(value: unknown): value is Sealed {
  if (!value || typeof value !== "object") return false;
  const event = value as Sealed;
  return typeof event.id === "string" && typeof event.pubkey === "string" && typeof event.content === "string";
}

const MAX_SEEN_EVENTS = 10_000;

function subscribeRelay(
  url: string,
  subId: string,
  filter: Record<string, unknown>,
  onEvent: (event: Sealed) => void,
) {
  const seen = new Set<string>();
  let socket: WebSocket | undefined;
  let opening: Promise<WebSocket> | undefined;
  let stopped = false;

  const ensure = (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    opening = connectSocket(url).then((ws) => {
      opening = undefined;
      if (stopped) {
        ws.close();
        throw new Error("nostr.arkade.sh is not connected");
      }
      socket = ws;
      ws.addEventListener("message", (ev) => {
        const frame = parseFrame(ev.data);
        if (!frame || frame[0] !== "EVENT" || !isEvent(frame[2]) || seen.has(frame[2].id)) return;
        if (seen.size >= MAX_SEEN_EVENTS) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        seen.add(frame[2].id);
        onEvent(frame[2]);
      });
      ws.addEventListener("close", () => {
        if (socket === ws) socket = undefined;
        if (!stopped) {
          setTimeout(() => {
            if (!stopped && !socket && !opening) void ensure().catch(() => undefined);
          }, 2_000);
        }
      });
      sendFrame(ws, ["REQ", subId, filter]);
      return ws;
    }).catch((err) => {
      opening = undefined;
      if (!stopped) {
        setTimeout(() => {
          if (!stopped && !opening) void ensure().catch(() => undefined);
        }, 2_000);
      }
      throw err;
    });
    return opening;
  };

  void ensure().catch(() => undefined);

  return {
    send: async (event: Sealed) => sendFrame(await ensure(), ["EVENT", event]),
    close() {
      stopped = true;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
      socket = undefined;
    },
  };
}

/**
 * One live subscription on nostr.arkade.sh. Sends only while that socket is open.
 */
export function connectTransport(opts: {
  relays: string[];
  secretKey: Uint8Array;
  onMessage: (incoming: Incoming) => void;
}): Transport {
  const pubkey = nostrPubkey(opts.secretKey);
  const sub = subscribeRelay(
    quoteRelay(opts.relays),
    "desk",
    { kinds: [RFQ_KIND], "#p": [pubkey] },
    (event) => {
      const message = openSealed(opts.secretKey, event);
      if (message) opts.onMessage({ from: event.pubkey, message });
    },
  );
  return {
    publish: (recipientPubkey, payload) => sub.send(seal(opts.secretKey, recipientPubkey, payload)),
    publishPosition: (position) => sub.send(positionEvent(opts.secretKey, position)),
    close: () => sub.close(),
  };
}

/**
 * Open nostr.arkade.sh, subscribe, then publish. Kind 24859 is ephemeral, so the
 * subscription is up before the request is sent. A closed socket is not written to.
 */
export async function collectReplies(opts: {
  relays: string[];
  secretKey: Uint8Array;
  recipients: string[];
  payload: Wire;
  timeoutMs: number;
  /** Keep this reply in the result. */
  accept?: (incoming: Incoming) => boolean;
  /** Stop waiting early when this reply arrives. Defaults to any accepted reply. */
  done?: (incoming: Incoming) => boolean;
}): Promise<Incoming[]> {
  const url = quoteRelay(opts.relays);
  const ws = await connectSocket(url);
  const pubkey = nostrPubkey(opts.secretKey);
  const found: Incoming[] = [];
  const seen = new Set<string>();
  const subId = `q${Math.random().toString(16).slice(2)}`;
  let published = false;
  let rejection = "";

  const consider = (event: Sealed) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const message = openSealed(opts.secretKey, event);
    if (!message) return;
    const incoming = { from: event.pubkey, message };
    if (opts.accept && !opts.accept(incoming)) return;
    found.push(incoming);
  };

  const publish = () => {
    if (published) return;
    published = true;
    for (const recipient of opts.recipients) {
      sendFrame(ws, ["EVENT", seal(opts.secretKey, recipient, opts.payload)]);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(early);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        if (!published) finish(new Error("nostr.arkade.sh did not accept the request"));
        else finish();
      }, opts.timeoutMs);
      const early = setTimeout(() => {
        try {
          publish();
        } catch (err) {
          finish(err instanceof Error ? err : new Error("nostr.arkade.sh is not connected"));
        }
      }, 500);
      const take = (event: Sealed) => {
        const before = found.length;
        consider(event);
        if (found.length === before) return;
        const last = found[found.length - 1]!;
        if (!opts.done || opts.done(last)) finish();
      };
      ws.addEventListener("message", (ev) => {
        const frame = parseFrame(ev.data);
        if (!frame) return;
        if (frame[0] === "EVENT" && frame[1] === subId && isEvent(frame[2])) take(frame[2]);
        if (frame[0] === "EOSE" && frame[1] === subId) {
          clearTimeout(early);
          try {
            publish();
          } catch (err) {
            finish(err instanceof Error ? err : new Error("nostr.arkade.sh is not connected"));
          }
        }
        if (frame[0] === "OK" && frame[2] === false && found.length === 0) {
          rejection = String(frame[3] ?? "rejected");
          finish(new Error(rejection));
        }
      });
      ws.addEventListener("close", () => {
        if (!published) finish(new Error("nostr.arkade.sh closed"));
      });
      try {
        sendFrame(ws, ["REQ", subId, { kinds: [RFQ_KIND], "#p": [pubkey] }]);
      } catch (err) {
        finish(err instanceof Error ? err : new Error("nostr.arkade.sh is not connected"));
      }
    });
    if (found.length === 0 && rejection) throw new Error(rejection);
    return found;
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
}

/**
 * Stored filled vaults on nostr.arkade.sh. The subscription replays what the
 * relay still has, then stays open for new ones.
 */
export function watchPositions(opts: {
  relays: string[];
  onPosition: (position: OptionPosition) => void;
}): { close(): void } {
  const sub = subscribeRelay(
    quoteRelay(opts.relays),
    "positions",
    { kinds: [POSITION_KIND], "#t": [POSITION_TAG] },
    (event) => {
      const position = readPosition(event);
      if (position) opts.onPosition(position);
    },
  );
  return { close: () => sub.close() };
}
