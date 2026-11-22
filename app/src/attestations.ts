import { DIA_RPC, intentDigest, intentRegisteredFilter } from "../../protocol/dia.ts";
import { bytesToHex } from "../../protocol/hex.ts";

export type Fixing = { expiry: number; price: string; time: number; raw: string; nonce: string; intentExpiry: number; sig: string; txid: string };

/** The `intentHash` DIA indexes in IntentRegistered. It is the same EIP-712 digest `attest` checks. */
export function intentHashOf(fixing: Fixing): string {
  const digest = intentDigest({ price: BigInt(fixing.raw), time: fixing.time, nonce: BigInt(fixing.nonce), intentExpiry: fixing.intentExpiry });
  return `0x${bytesToHex(digest)}`;
}

/** The Lasernet tx that registered this intent and the signer it logged. Null when the registry has no such intent. */
export async function findIntentTx(hash: string, signal?: AbortSignal): Promise<{ tx: string; signer: string } | null> {
  const filter = intentRegisteredFilter();
  const res = await fetch(DIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ address: filter.address, fromBlock: "0x0", toBlock: "latest", topics: [filter.topics[0], hash] }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`dia ${res.status}`);
  const body = await res.json() as { result?: { transactionHash?: string; data?: string }[]; error?: { message?: string } };
  if (!Array.isArray(body.result)) throw new Error(body.error?.message ?? "dia logs");
  const log = body.result[0];
  if (!log?.transactionHash || !log.data) return null;
  // Non-indexed fields are timestamp, then signer.
  return { tx: log.transactionHash, signer: `0x${log.data.replace(/^0x/, "").slice(64 + 24, 128)}` };
}
