export const DUST: bigint;
export const PRICE_MAX: bigint;
export const Q_MAX: bigint;

export function holderPayoff(kind: 2 | 3, settlement: bigint, strike: bigint, collateral: bigint): bigint;
export function writerPayoff(kind: 2 | 3, settlement: bigint, strike: bigint, collateral: bigint): bigint;
export function settlementOutputs(ph: bigint, locked: bigint): {
  mode: "split" | "writer" | "holder";
  holder: bigint;
  writer: bigint;
};
