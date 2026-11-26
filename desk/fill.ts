import { arkade, DefaultVtxo, type ArkTxInput } from "@arkade-os/sdk";

import { DUST_SATS, isPredict } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { classifyIntent, psbtView } from "../protocol/intent-state.ts";
import { intentProgram } from "../protocol/programs.ts";
import { virtualTxsById } from "../protocol/virtual-txs.ts";
import type { QuoteRow } from "./book.ts";
import { finalizeDeskSpends, pendingOutpoints, settleEmulatorTx, type PendingArk } from "./finalize.ts";
import { beaconExpiryRefusal, coinOutlives, minCoinExpiry, minFillCoinExpiry } from "./guards.ts";

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
 * Happy path. Options: collateral on the intent is finalized, premium to the
 * writer, collateral to the vault. Predict: the stake on the intent goes to the
 * desk and the desk's float funds the payout into the vault.
 * No live coin: recover a prior finalize from spent history before expiring past the deadline.
 * A live coin past the wall-clock deadline expires; the user cancels that coin.
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
   * submits; without finalizeTx the premium and the desk change never become vtxos.
   */
  ark?: PendingArk;
  beaconExpiry?: number | null;
  ratchetMargin?: number;
  checkPredict?: (row: QuoteRow, now: number) => Promise<PredictFillVerdict>;
}): Promise<{ result: FillResult; reason?: string; txid?: string; spent?: Coin[] }> {
  const bound = bindContracts(opts.termsFor(opts.row));
  const intent = opts.client.contract(intentProgram(), bound.intent);
  const coins = await intent.getUtxos();
  const collateral = BigInt(opts.row.collateral);
  const premium = BigInt(opts.row.premium);
  const predict = isPredict(opts.row.kind);
  // The user's coin: the collateral they lock, or the stake they bet.
  const locks = predict ? premium : collateral;
  // PredictVaultV3 settles standalone with direct signatures (no shared beacon coin), so it only
  // needs inputs that outlive settlement margin — never anchored to a beacon coin's expiry.
  const minExpiry = predict
    ? minCoinExpiry(opts.row.expiry)
    : minFillCoinExpiry(opts.row.expiry, opts.beaconExpiry ?? null, undefined, opts.ratchetMargin);
  const funding = coins.filter((item) => BigInt(item.value) >= locks);
  const coin = funding.find((item) => coinOutlives(item, minExpiry));
  if (!coin) {
    const intentScript = bytesToHex(intent.pkScript);
    const recovered = await recoverFilled(opts.client, bound.userPkScript, intentScript, {
      collateral,
      premium,
      now: opts.now,
      deadline: opts.row.deadline,
      ...(predict ? { side: 1 as const, vaultScript: bytesToHex(bound.vaultPkScript) } : {}),
    });
    if (recovered) return { result: "filled", txid: recovered };
    if (funding.length > 0) return opts.now >= opts.row.deadline ? { result: "expired" } : { result: "declined", reason: "coin_expiry" };
    // Spent, but the payout vtxo is not in the indexer yet. Expiring here drops the retry.
    if (await collateralSpent(opts.client, intentScript, locks)) return { result: "waiting" };
    return { result: opts.now >= opts.row.deadline ? "expired" : "waiting" };
  }
  if (opts.now >= opts.row.deadline) return { result: "expired" };
  if (!predict && "beaconExpiry" in opts && beaconExpiryRefusal(opts.row.expiry, opts.beaconExpiry ?? null)) {
    return { result: "declined", reason: "beacon_expiry" };
  }
  if (predict && opts.checkPredict) {
    const verdict = await opts.checkPredict(opts.row, opts.now);
    if (verdict === "decline") return { result: "declined", reason: "price_moved" };
    if (verdict === "retry") return { result: "waiting" };
  }

  // The desk pays the premium for an option, and the whole payout for a prediction.
  const outlay = predict ? collateral : premium;
  const float = opts.float ?? await deskFloat(opts.client, opts.deskScript);
  const picked = selectFloat(float, outlay, minExpiry, { allowSmallChange: predict });
  if (!picked) return { result: "short" };

  const locked = BigInt(coin.value);
  const deskSum = picked.reduce((sum, item) => sum + BigInt(item.value), 0n);
  const funded = intent.functions.finalize().from(coin).fund(picked.map((item) => asInput(item, opts.deskScript)));
  let spend;
  if (predict) {
    // OptionIntent side 1: output 0 pays the stake to the desk, output 1 funds
    // the vault, output 2 returns change above dust to the bettor. The desk's
    // own surplus rides on output 0, its own script.
    const change = locked - premium;
    const back = change > DUST_SATS ? change : 0n;
    const deskAmount = premium + (change - back) + (deskSum - collateral);
    spend = funded.to([
      { script: bound.solverPkScript, amount: deskAmount },
      { script: bound.vaultPkScript, amount: collateral },
      ...(back > 0n ? [{ script: bound.userPkScript, amount: back }] : []),
    ]);
  } else {
    let writerAmount = premium + (locked - collateral);
    let surplus = deskSum - premium;
    if (surplus > 0n && surplus <= DUST_SATS) {
      writerAmount += surplus;
      surplus = 0n;
    }
    spend = funded.to([
      { script: bound.writerPkScript, amount: writerAmount },
      { script: bound.vaultPkScript, amount: collateral },
    ]);
    if (surplus > 0n) spend.change(opts.deskScript.pkScript);
  }
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
 * `writerPkScript` is the user's script: the writer for options, the bettor for predict.
 */
export async function recoverFilled(
  client: Client,
  writerPkScript: Uint8Array,
  intentScriptHex: string,
  terms: { collateral: bigint; premium: bigint; now: number; deadline: number; side?: 0 | 1; vaultScript?: string },
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
    writerScript: bytesToHex(writerPkScript),
    now: terms.now,
    deadline: terms.deadline,
    side: terms.side,
    vaultScript: terms.vaultScript,
  });
  if (seen.phase !== "filled") return undefined;
  const txid = seen.closeTxid || coins.find((coin) => spends[coin.spentBy])?.spentBy;
  if (!txid) return undefined;
  // The virtual tx can exist before arkd finalizes it. The fill landed only once
  // its output is a vtxo: the writer's premium, or for predict the vault.
  const landing = terms.side === 1 && terms.vaultScript ? terms.vaultScript : bytesToHex(writerPkScript);
  const writer = landing.toLowerCase();
  const payouts = await client.indexer.getVtxos({ scripts: [writer] });
  const landed = (payouts.vtxos ?? []).some((coin) => (coin.txid || "").toLowerCase() === txid.toLowerCase());
  return landed ? txid : undefined;
}

/** The user's coin on the intent was spent. `locks` is the collateral, or the stake for predict. */
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
