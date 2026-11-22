import { Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

/**
 * The indexer returns virtual txs sorted by txid, not in the order requested.
 * Decode each PSBT and key by its lowercase txid, skipping unparseable entries.
 */
export function virtualTxsById(raws: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of raws) {
    if (!raw) continue;
    try {
      found.set(Transaction.fromPSBT(base64.decode(raw)).id.toLowerCase(), raw);
    } catch {
      // Skip malformed or non-PSBT entries.
    }
  }
  return found;
}
