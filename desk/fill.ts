import { arkade, DefaultVtxo, type ArkTxInput } from "@arkade-os/sdk";

import { DUST_SATS } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { classifyIntent, psbtView } from "../protocol/intent-state.ts";
import { intentProgram } from "../protocol/programs.ts";
import { virtualTxsById } from "../protocol/virtual-txs.ts";
import type { QuoteRow } from "./book.ts";
import { finalizeDeskSpends, pendingOutpoints, settleEmulatorTx, type PendingArk } from "./finalize.ts";
import { coinOutlives, minCoinExpiry } from "./guards.ts";

type Client = Awaited<ReturnType<typeof arkade.Arkade.connect>>;
export type Coin = { txid: string; vout: number; value: number; expiresAt?: Date };

function refreshSpent(client: Client) {
  const manager = client.contractManager;
  if (!manager) return undefined;
  return (outpoints: { txid: string; vout: number }[]) => manager.refreshOutpoints(outpoints);
}

function asInput(coin: Coin, script: DefaultVtxo.Script): ArkTxInput {
  return {
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapLeafScript: script.forfeit(),
    tapTree: script.encode(),
  };
}

export const DEFAULT_MAX_FLOAT_INPUTS = 20;

export function selectFloat(
  coins: Coin[],
  amount: bigint,
  minExpiryS?: number,
  opts?: { allowSmallChange?: boolean; maxInputs?: number },
): Coin[] | null {
  const eligible = (minExpiryS == null ? coins : coins.filter((coin) => coinOutlives(coin, minExpiryS)))
    .filter((coin) => coin.value > 0);
  const allowSmallChange = Boolean(opts?.allowSmallChange);
  const maxInputs = Math.max(1, opts?.maxInputs ?? DEFAULT_MAX_FLOAT_INPUTS);

  // Prefer the smallest single coin that covers `amount` cleanly (minimizes tx weight & input bloat).
  const asc = [...eligible].sort((a, b) => a.value - b.value);
  for (const coin of asc) {
    const change = BigInt(coin.value) - amount;
    if (change >= 0n && (allowSmallChange || change === 0n || change > DUST_SATS)) {
      return [coin];
    }
  }

  // Otherwise combine largest coins first, capped at `maxInputs` to stay well under tx weight limits.
  const desc = [...eligible].sort((a, b) => b.value - a.value);
  const picked: Coin[] = [];
  let sum = 0n;
  for (const coin of desc) {
    if (picked.length >= maxInputs) break;
    picked.push(coin);
    sum += BigInt(coin.value);
    const change = sum - amount;
    if (change >= 0n && (allowSmallChange || change === 0n || change > DUST_SATS)) {
      return picked;
    }
  }
  if (sum >= amount) return picked;
  return null;
}

export type FillResult = "waiting" | "filled" | "expired" | "short" | "declined";
export type PredictFillVerdict = "allow" | "decline" | "retry";

/**
 * Fill a funded Predict intent (`OptionIntent` side 1): the bettor's stake goes
 * to the desk (output 0) and the desk's float funds the full payout into
 * `PredictVault` (output 1).
 * No live coin: recover a prior finalize from spent history before expiring past the deadline.
 * A live coin past the wall-clock deadline expires; the bettor (or executord) cancels it.
 */
export async function fillQuote(opts: {
  client: Client;
  termsFor: (row: QuoteRow) => Terms;
  deskScript: DefaultVtxo.Script;
  row: QuoteRow;
  now: number;
  /** Desk float already reported by the contract manager. Omit it and the indexer is asked once. */
  float?: Coin[];
  /**
   * Ark server that can finish a covenant spend. `send()` stops after the emulator
   * submits; without finalizeTx the stake and desk change never become vtxos.
   */
  ark?: PendingArk;
  checkPredict?: (row: QuoteRow, now: number) => Promise<PredictFillVerdict>;
}): Promise<{ result: FillResult; reason?: string; txid?: string; spent?: Coin[] }> {
  const bound = bindContracts(opts.termsFor(opts.row));
  const intent = opts.client.contract(intentProgram(), bound.intent);
  const coins = await intent.getUtxos();
  const collateral = BigInt(opts.row.collateral);
  const stake = BigInt(opts.row.premium);
  const minExpiry = minCoinExpiry(opts.row.expiry);
  const funding = coins.filter((item) => BigInt(item.value) >= stake);
  const coin = funding.find((item) => coinOutlives(item, minExpiry));
  if (!coin) {
    const intentScript = bytesToHex(intent.pkScript);
    const recovered = await recoverFilled(opts.client, bound.userPkScript, intentScript, {
      collateral,
      premium: stake,
      now: opts.now,
      deadline: opts.row.deadline,
      vaultScript: bytesToHex(bound.vaultPkScript),
    });
    if (recovered) return { result: "filled", txid: recovered };
    if (funding.length > 0) return opts.now >= opts.row.deadline ? { result: "expired" } : { result: "declined", reason: "coin_expiry" };
    // Spent, but the vault vtxo is not in the indexer yet. Expiring here drops the retry.
    if (await collateralSpent(opts.client, intentScript, stake)) return { result: "waiting" };
    return { result: opts.now >= opts.row.deadline ? "expired" : "waiting" };
  }
  if (opts.now >= opts.row.deadline) return { result: "expired" };
  if (opts.checkPredict) {
    const verdict = await opts.checkPredict(opts.row, opts.now);
    if (verdict === "decline") return { result: "declined", reason: "price_moved" };
    if (verdict === "retry") return { result: "waiting" };
  }

  const float = opts.float ?? await deskFloat(opts.client, opts.deskScript);
  const picked = selectFloat(float, collateral, minExpiry, { allowSmallChange: true });
  if (!picked) return { result: "short" };

  const locked = BigInt(coin.value);
  const deskSum = picked.reduce((sum, item) => sum + BigInt(item.value), 0n);
  const funded = intent.functions.finalize().from(coin).fund(picked.map((item) => asInput(item, opts.deskScript)));
  // OptionIntent side 1: output 0 pays the stake (+ desk surplus + any user dust) to the desk,
  // output 1 funds PredictVault with collateral, output 2 returns user change above dust.
  const change = locked - stake;
  const back = change > DUST_SATS ? change : 0n;
  const deskAmount = stake + (change - back) + (deskSum - collateral);
  const spend = funded.to([
    { script: bound.solverPkScript, amount: deskAmount },
    { script: bound.vaultPkScript, amount: collateral },
    ...(back > 0n ? [{ script: bound.userPkScript, amount: back }] : []),
  ]);

  // Covenant send() posts to the emulator and returns. The emulator submits to arkd
  // only when it is the last signer, and it may do that submit and then fail its own
  // finalize. The thrown error still leaves the inputs spent, so a failed send has to
  // go through the same finalize path as a successful one.
  let sent: { txid: string; signedArkTx: string; signedCheckpointTxs: string[] } | undefined;
  try {
    sent = await spend.send();
  } catch (err) {
    console.error("fill send", opts.row.rfqId, err instanceof Error ? err.message : err);
  }
  const identity = opts.client.identity;
  const settled = sent && opts.ark && identity
    ? await settleEmulatorTx({
      ark: opts.ark,
      identity,
      deskScript: opts.deskScript,
      txid: sent.txid,
      signedArkTx: sent.signedArkTx,
      signedCheckpointTxs: sent.signedCheckpointTxs,
      inputs: picked,
      reconcileSpent: refreshSpent(opts.client),
    })
    : false;
  let recovered: string[] = [];
  if (!settled) {
    recovered = await finishSpend(opts, picked);
    if (await floatStillLocked(opts.client, opts.deskScript, picked)) return { result: "waiting" };
    if (!sent && !recovered.length) return { result: "waiting" };
  }
  return { result: "filled", txid: sent?.txid || recovered[0] || "", spent: picked };
}

/**
 * The emulator submits the virtual tx and returns. Arkd still holds the server-signed
 * checkpoints until the desk signs them and calls finalizeTx. Retry while the spent
 * float is still pending; a slow indexer is not a second fill.
 */
async function finishSpend(opts: {
  client: Client;
  deskScript: DefaultVtxo.Script;
  ark?: PendingArk;
}, picked: Coin[]): Promise<string[]> {
  const indexer = opts.client.indexer;
  const identity = opts.client.identity;
  if (!opts.ark || !indexer || !identity) return [];
  const want = new Set(picked.map((coin) => `${coin.txid}:${coin.vout}`));
  const finalized: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const done = await finalizeDeskSpends({
        ark: opts.ark,
        indexer,
        identity,
        deskScript: opts.deskScript,
        reconcileSpent: refreshSpent(opts.client),
      });
      finalized.push(...done);
      if (done.length) console.log("finalized", done.join(","));
    } catch (err) {
      console.error("finalize", err instanceof Error ? err.message : err);
    }
    const pending = await pendingOutpoints(indexer, opts.deskScript);
    if (![...want].some((id) => pending.has(id))) return finalized;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("finalize still pending", [...want].join(","));
  return finalized;
}

/**
 * If finalize already landed but the book never saved, classify the spend as filled.
 * `userPkScript` is the bettor's script.
 */
export async function recoverFilled(
  client: Client,
  userPkScript: Uint8Array,
  intentScriptHex: string,
  terms: { collateral: bigint; premium: bigint; now: number; deadline: number; vaultScript: string },
): Promise<string | undefined> {
  if (!client.indexer) return undefined;
  const intentScript = intentScriptHex.toLowerCase();
  const spent = await client.indexer.getVtxos({ scripts: [intentScript], spentOnly: true });
  const coins = (spent.vtxos ?? []).map((coin) => ({
    value: BigInt(coin.value),
    spent: true,
    spentBy: coin.arkTxId || coin.spentBy || "",
  })).filter((coin) => coin.spentBy);
  const ids = [...new Set(coins.map((coin) => coin.spentBy))];
  if (!ids.length) return undefined;
  const page = await client.indexer.getVirtualTxs(ids);
  const byId = virtualTxsById(page.txs ?? []);
  const spends: Record<string, ReturnType<typeof psbtView>["outputs"]> = {};
  for (const id of ids) {
    const raw = byId.get(id.toLowerCase());
    if (!raw) continue;
    try {
      spends[id] = psbtView(raw).outputs;
    } catch {
      // Checkpoint ids are not payouts.
    }
  }
  const seen = classifyIntent({
    coins,
    spends,
    collateral: terms.collateral,
    premium: terms.premium,
    writerScript: bytesToHex(userPkScript),
    now: terms.now,
    deadline: terms.deadline,
    side: 1,
    vaultScript: terms.vaultScript,
  });
  if (seen.phase !== "filled") return undefined;
  const txid = seen.closeTxid || coins.find((coin) => spends[coin.spentBy])?.spentBy;
  if (!txid) return undefined;
  // The virtual tx can exist before arkd finalizes it. The fill landed only once the vault vtxo exists.
  const vault = terms.vaultScript.toLowerCase();
  const payouts = await client.indexer.getVtxos({ scripts: [vault] });
  const landed = (payouts.vtxos ?? []).some((coin) => (coin.txid || "").toLowerCase() === txid.toLowerCase());
  return landed ? txid : undefined;
}

/** The bettor's stake coin on the intent was spent. */
async function collateralSpent(client: Client, intentScript: string, locks: bigint): Promise<boolean> {
  if (!client.indexer) return false;
  const spent = await client.indexer.getVtxos({ scripts: [intentScript], spentOnly: true });
  return (spent.vtxos ?? []).some((coin) => BigInt(coin.value) >= locks);
}

/** True when a picked desk coin is still spendable or still waiting on finalize. */
async function floatStillLocked(client: Client, deskScript: DefaultVtxo.Script, picked: Coin[]): Promise<boolean> {
  if (!client.indexer) return true;
  const script = bytesToHex(deskScript.pkScript);
  const [pending, spendable] = await Promise.all([
    pendingOutpoints(client.indexer, deskScript),
    client.indexer.getVtxos({ scripts: [script], spendableOnly: true }),
  ]);
  const live = new Set((spendable.vtxos ?? []).map((coin) => `${coin.txid}:${coin.vout}`));
  return picked.some((coin) => {
    const id = `${coin.txid}:${coin.vout}`;
    return pending.has(id) || live.has(id);
  });
}

async function deskFloat(client: Client, deskScript: DefaultVtxo.Script): Promise<Coin[]> {
  if (!client.indexer) throw new Error("indexer missing");
  const desk = await client.indexer.getVtxos({
    scripts: [bytesToHex(deskScript.pkScript)],
    spendableOnly: true,
  });
  return desk.vtxos;
}
