/** Maps raw Arkade/emulator/network errors into short user-facing sentences. */
export function explainError(action: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const has = (...parts: string[]) => parts.some((part) => message.includes(part));
  if (has("No coin on this address")) return "Nothing has arrived at this address yet.";
  if (has("signature verification failed")) return "This key is not allowed to do that.";
  if (has("ALREADY_SPENT", "already spent", "double spend")) {
    return "That coin was already used by another transaction. Refreshing.";
  }
  if (has("VTXO_ALREADY_UNROLLED")) {
    return "This vault was unrolled on Bitcoin. Attempting to bring it back offchain.";
  }
  if (has("failed to execute arkade script")) {
    if (action === "settle") return "This prediction cannot settle at that fixing yet.";
    if (action === "refund") return "Too early to void this vault. Try again after the void window.";
    if (action === "cancel") return "The deadline hasn’t passed yet. Try again in a moment.";
    if (action === "reboard") return "Couldn’t reboard this vault right now.";
    return "The contract refused this transaction.";
  }
  if (has("Failed to fetch", "fetch failed", "ECONNREFUSED", "NetworkError")) {
    return "Cannot reach the server. Check your connection and try again.";
  }
  return message ? `${message.charAt(0).toUpperCase()}${message.slice(1)}` : "Something went wrong. Try again.";
}
