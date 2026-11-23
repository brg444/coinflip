import { BEACON_READ_FEE } from "../../protocol/constants.ts";
import { btcAmount } from "./fund.ts";

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
 * Payouts after the beacon continuation. Output 0 is the beacon plus the read
 * fee, so it is not a party. At least one party script (user or desk) must
 * match so an unrelated transaction is not misread as a settlement.
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
  outputs.forEach((output, index) => {
    if (index === 0 || output.amount <= 0n) return;
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

function settledSummary(position: {
  writerKeep?: string;
  deskTake?: string;
  settleCents?: string;
}): string {
  const hasWriter = position.writerKeep != null && position.writerKeep !== "";
  const hasDesk = position.deskTake != null && position.deskTake !== "";
  const fee = ` The read fee took ${BEACON_READ_FEE} sats.`;
  if (!hasWriter && !hasDesk) return `The collateral left the vault.${fee}`;
  const you = hasWriter ? BigInt(position.writerKeep as string) : 0n;
  const desk = hasDesk ? BigInt(position.deskTake as string) : 0n;
  const price = position.settleCents ? ` Price $${usdFromCents(BigInt(position.settleCents))}.` : "";
  if (you > 0n && desk > 0n) {
    return `The collateral left the vault. You kept ${btcAmount(you)} BTC. The desk kept ${btcAmount(desk)} BTC.${fee}${price}`;
  }
  if (you > 0n) return `The collateral left the vault. You kept ${btcAmount(you)} BTC.${fee}${price}`;
  if (desk > 0n) return `The collateral left the vault. The desk kept ${btcAmount(desk)} BTC.${fee}${price}`;
  return `The collateral left the vault.${fee}`;
}

export function positionOutcome(
  position: {
    status: string;
    expiry?: bigint | number;
    settleTxid?: string;
    closeTxid?: string;
    writerKeep?: string;
    deskTake?: string;
    settleCents?: string;
  },
  now = Math.floor(Date.now() / 1000),
): string {
  if (position.status === "settled" || settlementKnown(position)) return settledSummary(position);
  const expiry = Number(position.expiry) || 0;
  const fee = ` The read fee takes ${BEACON_READ_FEE} sats of the collateral.`;
  if (position.status === "filled" && expiry && expiry <= now) {
    return `Expired. The collateral is still in the vault, so no one has won it yet.${fee}`;
  }
  if (position.status === "filled") return `Premium paid. The collateral stays in the vault until expiry.${fee}`;
  if (position.status === "refunded") return "The deposit came back to you. The trade did not fill.";
  return "";
}
