import { DIA_WS, fetchPinnedIntent, intentRegisteredFilter, type DiaIntent } from "../protocol/dia.ts";

/** Keep the newest BTC/USD OracleUpdate. The websocket wakes a read; a poll covers a dropped socket. */
export function startDiaFeed(
  everyMs: number,
  wsUrl = process.env.DIA_WS?.trim() || DIA_WS,
  onIntent?: (intent: DiaIntent) => void,
): { latest: () => Promise<DiaIntent | null>; stop: () => void } {
  let current: DiaIntent | null = null;
  let lastKey = "";
  let stopped = false;
  const pull = async () => {
    try {
      const fetched = await fetchPinnedIntent(AbortSignal.timeout(10_000));
      current = fetched;
      const key = `${fetched.time}:${fetched.price}:${fetched.nonce}`;
      if (key !== lastKey) {
        lastKey = key;
        onIntent?.(fetched);
      }
    } catch (err) {
      console.error("dia", err instanceof Error ? err.message : "read failed");
    }
    return current;
  };
  const timer = setInterval(() => {
    void pull();
  }, everyMs);
  let socket: WebSocket | undefined;
  let retryMs = 2_000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    ws.addEventListener("open", () => {
      retryMs = 2_000;
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["logs", intentRegisteredFilter()],
      }));
    });
    ws.addEventListener("message", () => {
      void pull();
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      const wait = retryMs;
      retryMs = Math.min(retryMs * 2, 60_000);
      retry = setTimeout(connect, wait);
    });
  };
  connect();
  void pull();
  return {
    latest: pull, // refetches; a failed read keeps the previous intent
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
