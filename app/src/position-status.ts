const TXID = /^[0-9a-f]{64}$/;

export function settlementTxid(coin: { arkTxId?: string; spentBy?: string }): string {
  for (const raw of [coin.arkTxId, coin.spentBy]) {
    const id = (raw ?? "").trim().toLowerCase();
    if (TXID.test(id)) return id;
  }
  return "";
}

export function settlementKnown(position: { settleTxid?: string; closeTxid?: string }): boolean {
  const id = (position.settleTxid ?? "").trim().toLowerCase();
  const close = (position.closeTxid ?? "").trim().toLowerCase();
  return TXID.test(id) && id !== close;
}

/**
 * Payouts after the beacon continuation (if any). At least one party script
 * (user or desk) must match so an unrelated transaction is not misread as a settlement.
 */
export function splitPayouts(
  outputs: { amount: bigint; script: string }[],
  writerScript: string,
  deskScript?: string,
): { writer: bigint; desk: bigint } | null {
  const want = writerScript.toLowerCase();
  const wantDesk = (deskScript ?? "").toLowerCase();
  let writer = 0n;
  let desk = 0n;
  let matched = false;
  // Legacy beacon settle puts the beacon continuation at output 0; standalone PredictV3 settle, refund, and close pay parties starting at output 0.
  const firstScript = outputs[0]?.script.toLowerCase() ?? "";
  const startIndex = firstScript === want || (wantDesk !== "" && firstScript === wantDesk) ? 0 : 1;
  outputs.forEach((output, index) => {
    if (index < startIndex || output.amount <= 0n) return;
    const script = output.script.toLowerCase();
    if (script === "51024e73" || script.startsWith("6a")) return;
    if (script === want) {
      writer += output.amount;
      matched = true;
    } else if (wantDesk && script === wantDesk) {
      desk += output.amount;
      matched = true;
    } else {
      desk += output.amount;
    }
  });
  if (!matched) return null;
  return { writer, desk };
}

export function usdFromCents(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
