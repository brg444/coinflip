import { arkade, Transaction, type CSVMultisigTapscript, type EmulatorProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { PREDICT_VOID_AFTER } from "./constants.ts";
import { bindContracts, type Terms } from "./contracts.ts";
import { buildPredictSettle, buildRefund, refundOutputs, submit } from "./cospend.ts";
import { FIX_EXPIRY_LAG } from "./fixing.ts";
import { bytesToHex, xOnly } from "./hex.ts";
import type { OracleFixing } from "./oracle-client.ts";
import { settlePayouts } from "./payoff.ts";
import { predictVaultProgram } from "./programs.ts";

export { settlePayouts };

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
  | { result: "waiting"; reason: "early" | "vault" }
  | { result: "unfixed" }
  | { result: "mismatch" }
  | {
    result: "settled";
    txid: string;
    /** Present when this call built the payout. Absent when the vault was already spent. */
    price?: bigint;
    holder?: bigint;
    writer?: bigint;
  };

function spent(coin: ChainCoin): boolean {
  return Boolean(coin.isSpent) || Boolean(coin.spentBy) || Boolean(coin.isUnrolled);
}

function spendTxid(coin: ChainCoin | undefined): string {
  if (!coin) return "";
  return coin.arkTxId || coin.spentBy || (coin.isUnrolled ? coin.settledBy || "unrolled" : "");
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

/**
 * Settle one standalone PredictVaultV3 using a signed fixing (DIA EIP-712 + oracle Schnorr).
 * Single-input off-chain spend: zero read fee, fully parallel across vaults.
 */
export async function settlePredictQuote(env: {
  chain: Chain;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  emulator: Pick<EmulatorProvider, "submitTx">;
  checkpoint: CSVMultisigTapscript.Type;
  fillTxid?: string;
  terms: Terms;
  fixing: OracleFixing;
  now: number;
}): Promise<SettleOutcome> {
  if (env.now < Number(env.terms.expiry + FIX_EXPIRY_LAG)) return { result: "waiting", reason: "early" };
  if (BigInt(env.fixing.expiry) !== env.terms.expiry) return { result: "mismatch" };
  if (env.fixing.oraclePkHex !== bytesToHex(xOnly(env.terms.oraclePk))) return { result: "mismatch" };

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

  const price = env.fixing.cents;
  const locked = BigInt(vaultCoin.value);
  const payout = settlePayouts({
    kind: env.terms.kind,
    price,
    strike: env.terms.strike,
    collateral: env.terms.collateral,
    locked,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  });
  if ("error" in payout) throw new Error(payout.error);

  const script = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, {
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  const built = buildPredictSettle({
    vault: {
      script,
      coin: { txid: vaultCoin.txid, vout: vaultCoin.vout, value: vaultCoin.value, prevTx: vaultPrev.toBytes(true, true) },
    },
    fixing: {
      price: env.fixing.price,
      time: BigInt(env.fixing.time),
      nonce: env.fixing.nonce,
      intentExpiry: BigInt(env.fixing.intentExpiry),
      sig: env.fixing.sig,
      oracleSig: env.fixing.oracleSig,
    },
    payouts: payout.payouts,
    checkpoint: env.checkpoint,
  });
  const submitted = await submit(built, env.emulator as EmulatorProvider);
  const holderScript = bytesToHex(bound.holderPkScript);
  const writerScript = bytesToHex(bound.writerPkScript);
  let holder = 0n;
  let writer = 0n;
  for (const output of payout.payouts) {
    const outScript = bytesToHex(output.script);
    if (outScript === holderScript) holder = output.amount;
    if (outScript === writerScript) writer = output.amount;
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

  const script = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, {
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

/** Reboard or renew a PredictVault into an offchain batch unchanged via its `reboard` leaf. */
export async function reboardPredictVault(env: {
  client: arkade.Arkade;
  terms: Terms;
  fillTxid?: string;
  signal?: AbortSignal;
}): Promise<{ result: "reboarded"; commitmentTxid: string; intentId: string } | { result: "missing" }> {
  const bound = bindContracts(env.terms);
  const contract = env.client.contract(predictVaultProgram(), bound.vault);
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
