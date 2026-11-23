export const DUST = 330n;
export const PRICE_MAX = 1_000_000_000n;
export const Q_MAX = 1_000_000_000n;
export const Q_MIN = 10_000n;

// Branch order and truncating division match option_vault.ark and predict_vault.ark.
export function holderPayoff(kind, settlement, strike, collateral) {
  if (kind === 2) return settlement > strike ? collateral : 0n;
  if (kind === 3) return settlement < strike ? collateral : 0n;
  let ph = 0n;
  if (kind === 0 && settlement > strike) {
    ph = (collateral * (settlement - strike)) / settlement;
  }
  if (kind === 1 && settlement < strike) {
    ph = (collateral * (strike - settlement)) / settlement;
    if (ph > collateral) ph = collateral;
  }
  return ph;
}

export function writerPayoff(kind, settlement, strike, collateral) {
  return collateral - holderPayoff(kind, settlement, strike, collateral);
}

export function settlementOutputs(ph, locked, readFee = 0n) {
  const pot = locked - readFee;
  const phPay = ph > pot ? pot : ph;
  const writerAmt = pot - phPay;
  if (phPay > DUST && writerAmt > DUST) {
    return { mode: "split", holder: phPay, writer: writerAmt };
  }
  if (phPay <= DUST) return { mode: "writer", holder: 0n, writer: pot };
  return { mode: "holder", holder: pot, writer: 0n };
}
