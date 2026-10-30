// Integer settlement for OptionVault and PredictVault. Branch order matches
// option_vault.ark and predict_vault.ark.
// Prices are USD cents. Notional, premium, and payoffs are sats.
// Division truncates toward zero, same as the covenant's OP_DIV.

export const DUST = 330n;
export const PRICE_MAX = 1_000_000_000n;
export const Q_MAX = 1_000_000_000n;
export const Q_MIN = 10_000n;

const TICKER = [0x42, 0x54, 0x43, 0x55, 0x53, 0x44];

export function median3(a, b, c) {
  if (a <= b && b <= c) return b;
  if (a <= c && c <= b) return c;
  if (b <= a && a <= c) return a;
  if (b <= c && c <= a) return c;
  if (c <= a && a <= b) return a;
  return b;
}

export function max3(a, b, c) {
  if (a >= b && a >= c) return a;
  if (b >= a && b >= c) return b;
  return c;
}

export function min3(a, b, c) {
  if (a <= b && a <= c) return a;
  if (b <= a && b <= c) return b;
  return c;
}

export function sliceError(times, lo, hi) {
  const top = max3(times[0], times[1], times[2]);
  const bot = min3(times[0], times[1], times[2]);
  if (top - bot > 60n) return "oracle spread";
  if (top < lo) return "slice early";
  if (top > hi) return "slice late";
  return null;
}

export function windows(expiry) {
  return {
    open: [expiry - 1800n, expiry - 1740n],
    mid: [expiry - 960n, expiry - 900n],
    close: [expiry, expiry + 60n],
  };
}

export function distinct(ids) {
  return ids[0] !== ids[1] && ids[0] !== ids[2] && ids[1] !== ids[2];
}

export function twap(m0, m1, m2) {
  return (m0 * 900n + m1 * 900n + m2 * 60n) / 1860n;
}

export function holderPayoff(kind, settlement, strike, collateral) {
  // Predict is all or nothing. A close on the line pays the writer.
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

/** What the seller keeps of the locked collateral. The premium is paid separately. */
export function writerPayoff(kind, settlement, strike, collateral) {
  return collateral - holderPayoff(kind, settlement, strike, collateral);
}

// Mirrors the vault's output rules. readFee leaves the vault and is added to
// the beacon. A holder leg at or below dust pays the rest to the writer.
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

export function oraclePreimage(price, time) {
  const out = new Uint8Array(22);
  out.set(TICKER, 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(6, price, true);
  view.setBigUint64(14, time, true);
  return out;
}

/** TWAP of three slices, the number `attest` stores as `num2bin(twap, 32)`. */
export function fixing(expiry, slices) {
  if (expiry <= 1800n) return { error: "expiry" };
  const names = ["open", "mid", "close"];
  const bounds = windows(expiry);
  const medians = [];
  for (let i = 0; i < 3; i += 1) {
    const slice = slices[i];
    if (!distinct(slice.who)) return { error: "same oracle" };
    for (const who of slice.who) {
      if (who < 0n || who > 4n) return { error: "oracle index" };
    }
    for (const time of slice.time) {
      if (time <= 0n) return { error: "time" };
    }
    const bad = sliceError(slice.time, bounds[names[i]][0], bounds[names[i]][1]);
    if (bad) return { error: bad };
    for (const price of slice.price) {
      if (price <= 0n || price > PRICE_MAX) return { error: "price" };
    }
    medians.push(median3(slice.price[0], slice.price[1], slice.price[2]));
  }
  const settlement = twap(medians[0], medians[1], medians[2]);
  if (settlement <= 0n) return { error: "zero twap" };
  return { twap: settlement, medians };
}
