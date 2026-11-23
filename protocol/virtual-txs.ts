import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

// Indexer returns virtual txs sorted by txid rather than request order.
export function virtualTxsById(raws: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of raws) {
    if (!raw) continue;
    try {
      found.set(Transaction.fromPSBT(base64.decode(raw)).id.toLowerCase(), raw);
    } catch {
      continue;
    }
  }
  return found;
}
