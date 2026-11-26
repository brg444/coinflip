export const DUST = 330n;
export const PRICE_MAX = 1_000_000_000n;
export const Q_MAX = 1_000_000_000n;

// Branch order matches contracts/predict_vault.ark: kind 2 = Higher (ST > strike), kind 3 = Lower (ST < strike).
// Exact strike pays the writer (desk).
export function holderPayoff(kind, settlement, strike, collateral) {
  if (kind === 2) return settlement > strike ? collateral : 0n;
  if (kind === 3) return settlement < strike ? collateral : 0n;
  return 0n;
}

export function writerPayoff(kind, settlement, strike, collateral) {
  return collateral - holderPayoff(kind, settlement, strike, collateral);
}

export function settlementOutputs(ph, locked) {
  const phPay = ph > locked ? locked : ph;
  const writerAmt = locked - phPay;
  if (phPay > DUST && writerAmt > DUST) {
    return { mode: "split", holder: phPay, writer: writerAmt };
  }
  if (phPay <= DUST) return { mode: "writer", holder: 0n, writer: locked };
  return { mode: "holder", holder: locked, writer: 0n };
}
