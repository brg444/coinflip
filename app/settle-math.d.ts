export function holderPayoff(kind: number, settlement: bigint, strike: bigint, collateral: bigint): bigint;
export function writerPayoff(kind: number, settlement: bigint, strike: bigint, collateral: bigint): bigint;
export function settlementOutputs(ph: bigint, locked: bigint, readFee?: bigint): {
  mode: "split" | "writer" | "holder";
  holder: bigint;
  writer: bigint;
};
