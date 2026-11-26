import { DUST_SATS, type PredictKind } from "./constants.ts";

/**
 * Pure settlement payoff and dust-folding math matching `contracts/predict_vault.ark`.
 * Zero I/O, zero SDK dependencies.
 */

export const DUST = DUST_SATS;

/**
 * Branch order matches `contracts/predict_vault.ark`:
 * kind 2 = Higher (`settlement > strike`), kind 3 = Lower (`settlement < strike`).
 * An exact tie pays the writer (desk).
 */
export function holderPayoff(kind: PredictKind, settlement: bigint, strike: bigint, collateral: bigint): bigint {
  if (kind === 2) return settlement > strike ? collateral : 0n;
  if (kind === 3) return settlement < strike ? collateral : 0n;
  return 0n;
}

export function writerPayoff(kind: PredictKind, settlement: bigint, strike: bigint, collateral: bigint): bigint {
  return collateral - holderPayoff(kind, settlement, strike, collateral);
}

export function settlementOutputs(ph: bigint, locked: bigint): {
  mode: "split" | "writer" | "holder";
  holder: bigint;
  writer: bigint;
} {
  const phPay = ph > locked ? locked : ph;
  const writerAmt = locked - phPay;
  if (phPay > DUST && writerAmt > DUST) {
    return { mode: "split", holder: phPay, writer: writerAmt };
  }
  if (phPay <= DUST) return { mode: "writer", holder: 0n, writer: locked };
  return { mode: "holder", holder: locked, writer: 0n };
}

/** Payout outputs for a standalone PredictVaultV3 settlement. Amounts sum to `locked`. */
export function settlePayouts(input: {
  kind: PredictKind;
  price: bigint;
  strike: bigint;
  collateral: bigint;
  locked: bigint;
  holderScript: Uint8Array;
  writerScript: Uint8Array;
}): { payouts: { script: Uint8Array; amount: bigint }[] } | { error: string } {
  if (input.locked < input.collateral) return { error: "underfunded" };
  const ph = holderPayoff(input.kind, input.price, input.strike, input.collateral);
  if (ph > input.collateral) return { error: "holder overpaid" };
  const split = settlementOutputs(ph, input.locked);
  if (split.mode === "split") {
    return {
      payouts: [
        { script: input.holderScript, amount: split.holder },
        { script: input.writerScript, amount: split.writer },
      ],
    };
  }
  if (split.mode === "writer") return { payouts: [{ script: input.writerScript, amount: split.writer }] };
  return { payouts: [{ script: input.holderScript, amount: split.holder }] };
}
