import type { SurfacePoint } from "./deribit.ts";
import type { OptionPosition, Wire } from "./messages.ts";
import type { OracleFixing, OracleSample } from "./oracle-client.ts";

/**
 * Narrow, pluggable port interfaces decoupling business logic (desk, settler, page)
 * from concrete transports (Nostr vs in-memory) and market feeds (DIA / exchanges / Deribit).
 */

export type RfqMessage = {
  from: string;
  message: Wire;
};

/** Desk-side RFQ transport (sealed point-to-point messages + public filled-vault feed). */
export type RfqTransport = {
  publish(recipientPubkey: string, payload: Wire): Promise<void>;
  /** Public, stored record of a filled vault so any permissionless settler can read it. */
  publishPosition(position: OptionPosition): Promise<void>;
  close(): void;
};

/** Client-side RFQ requester (browser or test harness). */
export type RfqClient = {
  request(opts: {
    recipients: string[];
    payload: Wire;
    timeoutMs: number;
    accept?: (incoming: RfqMessage) => boolean;
    done?: (incoming: RfqMessage) => boolean;
  }): Promise<RfqMessage[]>;
};

/** Public filled-vault subscription for permissionless settlers. */
export type PositionFeed = {
  watchPositions(onPosition: (position: OptionPosition) => void): { close(): void };
};

/** Read-only oracle client port for desk, settler, and browser. */
export type OracleFeedPort = {
  fetchStatus(signal?: AbortSignal): Promise<unknown>;
  fetchPrices(from: number, to: number, signal?: AbortSignal): Promise<OracleSample[]>;
  fetchFixing(
    expiry: number,
    expectedOraclePkHex?: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; fixing: OracleFixing | null; error?: string }>;
};

export type SpotTick = {
  cents: bigint;
  sources: string[];
  at: number;
};

/** Live spot-price feed port (e.g. multi-exchange median or deterministic test feed). */
export type SpotFeedPort = {
  spotCents(now?: number, opts?: { fresh?: boolean }): Promise<SpotTick>;
};

/** Options implied-volatility surface port (e.g. Deribit or fixed vol). */
export type VolSurfacePort = {
  fetchSurface(): Promise<SurfacePoint[]>;
};

/**
 * Deterministic in-memory RFQ & position bus implementing `RfqTransport`, `RfqClient`,
 * and `PositionFeed`. Enables millisecond end-to-end integration tests with zero sockets
 * or Nostr relay dependencies.
 */
export class InMemoryRfqBus implements PositionFeed {
  private readonly handlers = new Map<string, Set<(incoming: RfqMessage) => void>>();
  private readonly positionListeners = new Set<(position: OptionPosition) => void>();
  private readonly positions: OptionPosition[] = [];

  private deliver(recipientPubkey: string, incoming: RfqMessage) {
    const subs = this.handlers.get(recipientPubkey);
    if (!subs) return;
    for (const fn of [...subs]) fn(incoming);
  }

  connectDesk(deskPubkey: string, onMessage: (incoming: RfqMessage) => void): RfqTransport {
    let subs = this.handlers.get(deskPubkey);
    if (!subs) {
      subs = new Set();
      this.handlers.set(deskPubkey, subs);
    }
    subs.add(onMessage);
    return {
      publish: async (recipientPubkey, payload) => {
        this.deliver(recipientPubkey, { from: deskPubkey, message: payload });
      },
      publishPosition: async (position) => {
        const idx = this.positions.findIndex((p) => p.rfq_id === position.rfq_id);
        if (idx >= 0) this.positions[idx] = position;
        else this.positions.push(position);
        for (const fn of [...this.positionListeners]) fn(position);
      },
      close: () => {
        this.handlers.get(deskPubkey)?.delete(onMessage);
      },
    };
  }

  client(clientPubkey: string): RfqClient {
    return {
      request: async (opts) => {
        const found: RfqMessage[] = [];
        return await new Promise<RfqMessage[]>((resolve) => {
          let settled = false;
          let subs = this.handlers.get(clientPubkey);
          if (!subs) {
            subs = new Set();
            this.handlers.set(clientPubkey, subs);
          }
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            subs!.delete(onReply);
            resolve(found);
          };
          const onReply = (incoming: RfqMessage) => {
            if (opts.accept && !opts.accept(incoming)) return;
            found.push(incoming);
            if (!opts.done || opts.done(incoming)) finish();
          };
          subs.add(onReply);
          const timer = setTimeout(finish, opts.timeoutMs);
          for (const recipient of opts.recipients) {
            queueMicrotask(() => {
              this.deliver(recipient, { from: clientPubkey, message: opts.payload });
            });
          }
        });
      },
    };
  }

  watchPositions(onPosition: (position: OptionPosition) => void): { close(): void } {
    this.positionListeners.add(onPosition);
    for (const position of this.positions) onPosition(position);
    return {
      close: () => {
        this.positionListeners.delete(onPosition);
      },
    };
  }
}
