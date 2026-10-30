import { arkade, asset, Transaction, type CSVMultisigTapscript, type EmulatorProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, bin2num, bindBeacon, decodeState, statePacketOf, type BeaconState } from "../protocol/beacon.ts";
import { PRICE_MAX } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { buildSettle, submit } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import type { Kind } from "../protocol/constants.ts";
import { vaultProgramFor } from "../protocol/programs.ts";
import type { BeaconSpec } from "./oracle.ts";

export type ChainCoin = {
  txid: string;
  vout: number;
  value: number | bigint;
  isSpent?: boolean;
  isUnrolled?: boolean;
  spentBy?: string;
  arkTxId?: string;
  settledBy?: string;
  assets?: readonly { assetId: string; amount: bigint | number }[];
};

export type Chain = {
  getVtxos(opts: { scripts: string[]; spendableOnly?: boolean; spentOnly?: boolean }): Promise<{ vtxos: ChainCoin[] }>;
  getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
};

export type SettleOutcome =
  | { result: "waiting"; reason: "early" | "vault" | "beacon" }
  | { result: "unfixed" }
  | { result: "mismatch" }
  | {
    result: "settled";
    txid: string;
    fee?: { txid: string; vout: number };
    /** Present when this call built the payout. Absent when the vault was already spent. */
    price?: bigint;
    holder?: bigint;
    writer?: bigint;
  };

/** The price the vault reads: the first 8 bytes of the newest slot whose key is `expiry`. */
export function slotPrice(state: Uint8Array, expiry: bigint): bigint | null {
  let decoded;
  try {
    decoded = decodeState(state);
  } catch {
    return null;
  }
  if (decoded.version !== 1) return null;
  const slot = decoded.slots.find((item) => item.key === expiry);
  if (!slot) return null;
  const price = bin2num(slot.value.subarray(0, 8));
  if (price <= 0n || price > PRICE_MAX) return null;
  return price;
}

/** Payout outputs after the beacon continuation. Amounts sum to the locked coin. */
export function settlePayouts(input: {
  kind: Kind;
  price: bigint;
  strike: bigint;
  collateral: bigint;
  locked: bigint;
  readFee?: bigint;
  holderScript: Uint8Array;
  writerScript: Uint8Array;
}): { payouts: { script: Uint8Array; amount: bigint }[] } | { error: string } {
  if (input.locked < input.collateral) return { error: "underfunded" };
  const readFee = input.readFee ?? 0n;
  if (input.locked < readFee) return { error: "fee" };
  const ph = holderPayoff(input.kind, input.price, input.strike, input.collateral);
  if (ph > input.collateral) return { error: "holder overpaid" };
  const split = settlementOutputs(ph, input.locked, readFee);
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

function spent(coin: ChainCoin): boolean {
  return Boolean(coin.isSpent) || Boolean(coin.spentBy) || Boolean(coin.isUnrolled);
}

function spendTxid(coin: ChainCoin | undefined): string {
  if (!coin) return "";
  return coin.arkTxId || coin.spentBy || (coin.isUnrolled ? coin.settledBy || "unrolled" : "");
}

function holdsUnit(coin: ChainCoin, assetId: string): boolean {
  const want = assetId.toLowerCase();
  return (coin.assets ?? []).some((item) => item.assetId.toLowerCase() === want && BigInt(item.amount) === 1n);
}

function txOf(raw: string | undefined, id: string): Transaction | undefined {
  if (!raw) return undefined;
  try {
    const tx = Transaction.fromPSBT(base64.decode(raw));
    return tx.id === id ? tx : undefined;
  } catch {
    return undefined;
  }
}

function txById(raws: readonly string[], id: string): Transaction | undefined {
  for (const raw of raws) {
    const found = txOf(raw, id);
    if (found) return found;
  }
  return undefined;
}

/** The live beacon is the spendable unit with the highest round. An older coin is not the price. */
function liveBeacon(coins: readonly ChainCoin[], txs: readonly string[]): { coin: ChainCoin; prev: Transaction; state: Uint8Array } | null {
  let best: { coin: ChainCoin; prev: Transaction; state: Uint8Array; round: bigint } | null = null;
  for (const coin of coins) {
    const prev = txById(txs, coin.txid);
    if (!prev) continue;
    let state: Uint8Array;
    let decoded: BeaconState;
    try {
      state = statePacketOf(prev);
      decoded = decodeState(state);
    } catch {
      continue;
    }
    if (!best || decoded.round > best.round) best = { coin, prev, state, round: decoded.round };
  }
  return best ? { coin: best.coin, prev: best.prev, state: best.state } : null;
}

/**
 * Settle one vault. The price is the fixing in the beacon coin's state packet,
 * which is what `OptionVault.settle` and `PredictVault.settle` read. One beacon coin means one settle
 * at a time; the caller refetches the coin for the next vault.
 */
export async function settleQuote(env: {
  chain: Chain;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  emulator: Pick<EmulatorProvider, "submitTx">;
  checkpoint: CSVMultisigTapscript.Type;
  /** Creating tx of the vault, when the watcher knows which fill paid it. */
  fillTxid?: string;
  terms: Terms;
  beacon: BeaconSpec;
  now: number;
}): Promise<SettleOutcome> {
  if (env.now < Number(env.terms.expiry)) return { result: "waiting", reason: "early" };
  const id = asset.AssetId.fromString(env.beacon.assetId);
  const beaconId = beaconIdOf(id);
  if (bytesToHex(beaconId.txid) !== bytesToHex(env.terms.beacon.txid) || beaconId.gidx !== env.terms.beacon.gidx) {
    return { result: "mismatch" };
  }

  const bound = bindContracts(env.terms);
  const vaultScript = bytesToHex(bound.vaultPkScript);
  const live = await env.chain.getVtxos({ scripts: [vaultScript], spendableOnly: true });
  const page = live.vtxos ?? [];
  const vaults = page.filter((coin) => !spent(coin) && BigInt(coin.value) >= env.terms.collateral);
  if (!vaults.length) {
    const unrolled = spendTxid(page.find((coin) => coin.isUnrolled));
    if (unrolled) return { result: "settled", txid: unrolled };
    const history = await env.chain.getVtxos({ scripts: [vaultScript], spentOnly: true });
    const prior = history.vtxos ?? [];
    const gone = spendTxid(prior.find((coin) => coin.txid === env.fillTxid) ?? prior.find((coin) => spent(coin)));
    if (gone) return { result: "settled", txid: gone };
    return { result: "waiting", reason: "vault" };
  }
  const vaultCoin = vaults.find((coin) => coin.txid === env.fillTxid) ?? vaults[0]!;

  const beaconBound = bindBeacon({
    id: beaconId,
    signers: env.beacon.signers,
    threshold: env.beacon.threshold,
    domain: env.beacon.domain,
    keyLag: env.beacon.keyLag,
    readFee: env.beacon.readFee,
    adminPk: env.beacon.adminPk,
    exit: env.beacon.exit,
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  if (beaconBound.address !== env.beacon.address) return { result: "mismatch" };

  const found = await env.chain.getVtxos({ scripts: [bytesToHex(beaconBound.pkScript)], spendableOnly: true });
  const holders = (found.vtxos ?? []).filter((coin) => !spent(coin) && holdsUnit(coin, env.beacon.assetId));
  if (!holders.length) return { result: "waiting", reason: "beacon" };

  const ids = [...new Set([vaultCoin.txid, ...holders.map((coin) => coin.txid)])];
  const raws = await env.chain.getVirtualTxs(ids);
  const txs = raws.txs ?? [];
  // The indexer does not promise the request order.
  const vaultPrev = txById(txs, vaultCoin.txid);
  if (!vaultPrev) return { result: "waiting", reason: "vault" };
  const chosen = liveBeacon(holders, txs);
  if (!chosen) return { result: "waiting", reason: "beacon" };
  const { coin: beaconCoin, prev: beaconPrev, state } = chosen;
  const price = slotPrice(state, env.terms.expiry);
  if (price == null) return { result: "unfixed" };

  const locked = BigInt(vaultCoin.value);
  const payout = settlePayouts({
    kind: env.terms.kind,
    price,
    strike: env.terms.strike,
    collateral: env.terms.collateral,
    locked,
    readFee: env.beacon.readFee,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  });
  if ("error" in payout) throw new Error(payout.error);

  const script = new arkade.ArkadeProgramScript(vaultProgramFor(env.terms.kind), bound.vault, {
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  const built = buildSettle({
    vault: {
      script,
      coin: { txid: vaultCoin.txid, vout: vaultCoin.vout, value: vaultCoin.value, prevTx: vaultPrev.toBytes(true, true) },
    },
    beacon: {
      script: beaconBound.script,
      coin: { txid: beaconCoin.txid, vout: beaconCoin.vout, value: beaconCoin.value, prevTx: beaconPrev.toBytes(true, true) },
      state,
      id,
    },
    readFee: env.beacon.readFee,
    payouts: payout.payouts,
    checkpoint: env.checkpoint,
  });
  const submitted = await submit(built, env.emulator as EmulatorProvider);
  const holderScript = bytesToHex(bound.holderPkScript);
  const writerScript = bytesToHex(bound.writerPkScript);
  let holder = 0n;
  let writer = 0n;
  for (const output of payout.payouts) {
    const script = bytesToHex(output.script);
    if (script === holderScript) holder = output.amount;
    if (script === writerScript) writer = output.amount;
  }
  return {
    result: "settled",
    txid: submitted.txid,
    price,
    holder,
    writer,
  };
}
