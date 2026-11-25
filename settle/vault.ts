import { arkade, asset, Transaction, type CSVMultisigTapscript, type EmulatorProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, bin2num, bindBeacon, decodeState, statePacketOf, type BeaconState } from "../protocol/beacon.ts";
import { isPredict, PREDICT_VOID_AFTER, PRICE_MAX, type Kind } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { buildPredictSettle, buildRefund, buildSettle, refundOutputs, submit } from "../protocol/cospend.ts";
import { centsOf, DIA_PUBKEY, intentSigned, type DiaIntent } from "../protocol/dia.ts";
import { bytesToHex } from "../protocol/hex.ts";
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
  | { result: "rejected" }
  | {
    result: "settled";
    txid: string;
    fee?: { txid: string; vout: number };
    /** Present when this call built the payout. Absent when the vault was already spent. */
    price?: bigint;
    holder?: bigint;
    writer?: bigint;
  };

/** Price and sample time from the newest slot for this expiry. The time must sit in the vault's `[expiry, expiry + 60]` window. */
export function slotFixing(state: Uint8Array, expiry: bigint): { price: bigint; time: bigint } | null {
  let decoded;
  try {
    decoded = decodeState(state);
  } catch {
    return null;
  }
  if (decoded.version !== 1) return null;
  const slot = decoded.slots.find((item) => item.expiry === expiry);
  if (!slot || slot.value.length < 16) return null;
  const price = bin2num(slot.value.subarray(0, 8));
  const time = bin2num(slot.value.subarray(8, 16));
  if (price <= 0n || price > PRICE_MAX || time < expiry || time > expiry + 60n) return null;
  return { price, time };
}

/** The price the vault reads: the first 8 bytes of the newest slot for this expiry. */
export function slotPrice(state: Uint8Array, expiry: bigint): bigint | null {
  return slotFixing(state, expiry)?.price ?? null;
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
 * A fresh publish is trusted because signing is deterministic, and the sample comparison runs only on 409.
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
  /**
   * Set when the beacon already had this expiry. Settle only if the slot is
   * this price and sample time. Omit it when this process just published.
   */
  expected?: { price: bigint; time: bigint };
}): Promise<SettleOutcome> {
  if (env.now < Number(env.terms.expiry)) return { result: "waiting", reason: "early" };
  if (!env.terms.beacon) return { result: "mismatch" };
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
    domain: env.beacon.domain,
    expiryLag: env.beacon.expiryLag,
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
  const fixing = slotFixing(state, env.terms.expiry);
  if (!fixing) return { result: "unfixed" };
  if (env.expected && (fixing.price !== env.expected.price || fixing.time !== env.expected.time)) {
    return { result: "rejected" };
  }
  const price = fixing.price;

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

export type RefundOutcome =
  | { result: "waiting"; reason: "early" | "vault" }
  | { result: "spent"; txid: string }
  | { result: "refunded"; txid: string; holder: bigint; writer: bigint };

export async function refundQuote(env: {
  chain: Chain;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  emulator: Pick<EmulatorProvider, "submitTx">;
  checkpoint: CSVMultisigTapscript.Type;
  terms: Terms;
  fillTxid?: string;
  now: number;
}): Promise<RefundOutcome> {
  if (!isPredict(env.terms.kind)) throw new Error("refund is only supported for PredictVault");
  const voidAfter = env.terms.voidAfter ?? PREDICT_VOID_AFTER;
  if (env.now < Number(env.terms.expiry + voidAfter)) return { result: "waiting", reason: "early" };
  const bound = bindContracts(env.terms);
  const vaultScriptHex = bytesToHex(bound.vaultPkScript);
  const live = await env.chain.getVtxos({ scripts: [vaultScriptHex], spendableOnly: true });
  const page = live.vtxos ?? [];
  const liveVault = page.filter((coin) => !spent(coin) && BigInt(coin.value) >= env.terms.premium);
  if (!liveVault.length) {
    const unrolled = spendTxid(page.find((coin) => coin.isUnrolled));
    if (unrolled) return { result: "spent", txid: unrolled };
    const history = await env.chain.getVtxos({ scripts: [vaultScriptHex], spentOnly: true });
    const gone = spendTxid((history.vtxos ?? []).find((coin) => coin.txid === env.fillTxid) ?? (history.vtxos ?? []).find((coin) => spent(coin)));
    if (gone) return { result: "spent", txid: gone };
    return { result: "waiting", reason: "vault" };
  }
  const vaultCoin = (env.fillTxid ? liveVault.find((coin) => coin.txid === env.fillTxid) : undefined) ?? liveVault[0]!;
  const raws = await env.chain.getVirtualTxs([vaultCoin.txid]);
  const vaultPrev = txById(raws.txs ?? [], vaultCoin.txid);
  if (!vaultPrev) return { result: "waiting", reason: "vault" };

  const script = new arkade.ArkadeProgramScript(vaultProgramFor(env.terms.kind), bound.vault, {
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  const outs = refundOutputs(BigInt(vaultCoin.value), env.terms.premium, bound.holderPkScript, bound.writerPkScript);
  const built = buildRefund({
    vault: {
      script,
      coin: { txid: vaultCoin.txid, vout: vaultCoin.vout, value: vaultCoin.value, prevTx: vaultPrev.toBytes(true, true) },
    },
    stake: env.terms.premium,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
    checkpoint: env.checkpoint,
  });
  const submitted = await submit(built, env.emulator as EmulatorProvider);
  const holderHex = bytesToHex(bound.holderPkScript);
  const writerHex = bytesToHex(bound.writerPkScript);
  let holder = 0n;
  let writer = 0n;
  for (const output of outs) {
    const hex = bytesToHex(output.script);
    if (hex === holderHex) holder = output.amount;
    if (hex === writerHex) writer = output.amount;
  }
  return { result: "refunded", txid: submitted.txid, holder, writer };
}

/** Settle a direct-DIA PredictVault without a beacon coin or read fee. */
export async function settlePredictQuote(env: {
  chain: Chain;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  emulator: Pick<EmulatorProvider, "submitTx">;
  checkpoint: CSVMultisigTapscript.Type;
  fillTxid?: string;
  terms: Terms;
  dia: DiaIntent;
  expiryLag?: number;
  now: number;
}): Promise<SettleOutcome> {
  if (!isPredict(env.terms.kind)) throw new Error("settlePredictQuote is only supported for PredictVault");
  if (env.now < Number(env.terms.expiry)) return { result: "waiting", reason: "early" };
  const lag = env.expiryLag ?? 60;
  const expiryN = Number(env.terms.expiry);
  if (env.dia.time < expiryN || env.dia.time > expiryN + lag) return { result: "unfixed" };
  const oraclePk = env.terms.oraclePk ?? DIA_PUBKEY;
  if (!intentSigned(env.dia, oraclePk)) return { result: "rejected" };

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
  const raws = await env.chain.getVirtualTxs([vaultCoin.txid]);
  const vaultPrev = txById(raws.txs ?? [], vaultCoin.txid);
  if (!vaultPrev) return { result: "waiting", reason: "vault" };

  const price = centsOf(env.dia.price);
  const locked = BigInt(vaultCoin.value);
  const ph = holderPayoff(env.terms.kind, price, env.terms.strike, env.terms.collateral);
  const holderWins = ph > 0n;
  const payout = holderWins
    ? { script: bound.holderPkScript, amount: locked }
    : { script: bound.writerPkScript, amount: locked };

  const script = new arkade.ArkadeProgramScript(vaultProgramFor(env.terms.kind), bound.vault, {
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  const built = buildPredictSettle({
    vault: {
      script,
      coin: { txid: vaultCoin.txid, vout: vaultCoin.vout, value: vaultCoin.value, prevTx: vaultPrev.toBytes(true, true) },
    },
    dia: env.dia,
    payout,
    checkpoint: env.checkpoint,
  });
  const submitted = await submit(built, env.emulator as EmulatorProvider);
  return {
    result: "settled",
    txid: submitted.txid,
    price,
    holder: holderWins ? locked : 0n,
    writer: holderWins ? 0n : locked,
  };
}

/** Reboard or renew a PredictVault into an offchain batch unchanged via its `reboard` leaf. */
export async function reboardPredictVault(env: {
  client: arkade.Arkade;
  terms: Terms;
  fillTxid?: string;
  signal?: AbortSignal;
}): Promise<{ result: "reboarded"; commitmentTxid: string; intentId: string } | { result: "missing" }> {
  if (!isPredict(env.terms.kind)) throw new Error("reboard is only supported for PredictVault");
  const bound = bindContracts(env.terms);
  const contract = env.client.contract(vaultProgramFor(env.terms.kind), bound.vault);
  const scriptHex = bytesToHex(bound.vaultPkScript);
  // ArkadeContract.getUtxos() filters out unrolled coins; query the indexer directly so unrolled vaults are included.
  const coins = env.client.indexer
    ? (await env.client.indexer.getVtxos({ scripts: [scriptHex] })).vtxos.filter((c) => !c.isSpent && !c.spentBy)
    : await contract.getUtxos();
  const target = (env.fillTxid ? coins.find((c) => c.txid === env.fillTxid) : undefined)
    ?? coins.find((c) => c.isUnrolled)
    ?? coins[0];
  if (!target) return { result: "missing" };
  const res = await arkade.renewProgramContractOutputs(
    env.client,
    [{ contract, coin: target, fn: "reboard" }],
    { signal: env.signal },
  );
  return { result: "reboarded", commitmentTxid: res.commitmentTxid, intentId: res.intentId };
}
