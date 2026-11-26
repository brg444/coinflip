import { ArkAddress, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { statePacketOf } from "../../protocol/beacon.ts";
import { predictSettlePriceCents } from "../../protocol/cospend.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtView, type CoinView, type IntentPhase, type TxOutput } from "../../protocol/intent-state.ts";
import { virtualTxsById } from "../../protocol/virtual-txs.ts";
import { slotPrice } from "../../settle/vault.ts";
import { ACTIVE_ARK_URL, intentCoins, onContractEvent } from "./fund.ts";
import { settlementTxid, splitPayouts } from "./position-status.ts";

export type WatchRow = {
  address: string;
  /** The user's address: the writer's for options, the bettor's for predict. */
  writerAddress?: string;
  vaultAddress?: string;
  collateral: bigint;
  premium: bigint;
  deadline: number;
  since?: number;
  /** 1 for predict: the user's coin is the stake and a fill funds the vault. */
  side?: 0 | 1;
  /** Register this intent with the contract manager. Returns its pkScript. */
  register?: () => Promise<string>;
};

export type PhaseUpdate = {
  address: string;
  phase: IntentPhase;
  refundable: boolean;
  fundingTxid: string;
  closeTxid: string;
  settleTxid: string;
  unrolled?: boolean;
};

const indexer = new RestIndexerProvider(ACTIVE_ARK_URL);
const vtxoReads = new Map<string, Promise<{ txid: string; value: number; spentBy: string; createdAt: Date }[]>>();

export function pkScriptOf(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript);
}

/** Spendable sats at an Arkade address, as the indexer sees them. The wallet itself may also hold coins elsewhere. */
export async function addressBalance(address: string): Promise<bigint> {
  const page = await indexer.getVtxos({ scripts: [pkScriptOf(address)], spendableOnly: true });
  return (page.vtxos ?? []).reduce((sum, coin) => (coin.isSpent || coin.spentBy ? sum : sum + BigInt(coin.value)), 0n);
}

/**
 * The user's and the desk's sats on a settlement transaction, and the fixing it
 * read. Output 0 is the beacon. `writerScript` is the user's script.
 */
export async function readKept(
  settleTxid: string,
  writerScript: string,
  expiry?: bigint,
  deskScript?: string,
): Promise<{ writer: bigint; desk: bigint; cents?: bigint } | null> {
  try {
    const page = await indexer.getVirtualTxs([settleTxid]);
    const raw = virtualTxsById(page.txs ?? []).get(settleTxid.toLowerCase());
    if (!raw) return null;
    const split = splitPayouts(psbtView(raw).outputs, writerScript, deskScript);
    if (!split) return null;
    const cents = expiry == null ? null : fixingOf(raw, expiry);
    return cents == null ? split : { ...split, cents };
  } catch {
    return null;
  }
}

/** Extract the settlement price from either a standalone Predict witness or a beacon state packet. */
function fixingOf(raw: string, expiry: bigint): bigint | null {
  try {
    const tx = Transaction.fromPSBT(base64.decode(raw));
    const direct = predictSettlePriceCents(tx);
    if (direct != null) return direct;
    return slotPrice(statePacketOf(tx), expiry);
  } catch {
    return null;
  }
}

function writerCoins(script: string) {
  let job = vtxoReads.get(script);
  if (!job) {
    job = indexer.getVtxos({ scripts: [script] }).then((page) => page.vtxos.map((coin) => ({
      txid: coin.txid,
      value: coin.value,
      spentBy: coin.spentBy || "",
      createdAt: coin.createdAt,
    })));
    vtxoReads.set(script, job);
    void job.finally(() => vtxoReads.delete(script));
  }
  return job;
}

async function payoutEvidence(writerScript: string, intentScript: string, since: number): Promise<{ coins: CoinView[]; spends: Record<string, TxOutput[]> }> {
  const coins = await writerCoins(writerScript);
  const floor = since > 0 ? since - 30 : 0;
  const recent = coins.filter((coin) => {
    const created = coin.createdAt instanceof Date ? Math.floor(coin.createdAt.getTime() / 1000) : 0;
    if (floor > 0) return created >= floor;
    return !coin.spentBy;
  }).sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0));
  const ids = [...new Set(recent.map((coin) => coin.txid))].slice(0, 16);
  const raws: string[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const page = await indexer.getVirtualTxs(ids.slice(i, i + 8));
    raws.push(...(page.txs ?? []));
  }
  const byId = virtualTxsById(raws);
  const found: CoinView[] = [];
  const spends: Record<string, TxOutput[]> = {};
  for (const [id, raw] of byId) {
    let view;
    try {
      view = psbtView(raw);
    } catch {
      continue;
    }
    const input = view.inputs.find((item) => item.script.toLowerCase() === intentScript);
    if (!input) continue;
    found.push({ value: input.amount, spent: true, spentBy: id });
    spends[id] = view.outputs;
  }
  return { coins: found, spends };
}

export async function readIntent(row: WatchRow, now = Math.floor(Date.now() / 1000)): Promise<Omit<PhaseUpdate, "address">> {
  const intentScript = pkScriptOf(row.address).toLowerCase();
  const writerScript = row.writerAddress ? pkScriptOf(row.writerAddress) : "";
  const side = row.side ?? 0;
  const vaultScript = side === 1 && row.vaultAddress ? pkScriptOf(row.vaultAddress) : "";
  const coins = (await intentCoins(intentScript)) ?? [];
  const ids = [...new Set(coins.flatMap((coin) => coin.spent && coin.spentBy ? [coin.spentBy] : []))];
  const spends: Record<string, TxOutput[]> = {};
  if (ids.length && writerScript) {
    const page = await indexer.getVirtualTxs(ids);
    const byId = virtualTxsById(page.txs ?? []);
    for (const id of ids) {
      const raw = byId.get(id.toLowerCase());
      if (!raw) continue;
      try {
        spends[id] = psbtView(raw).outputs;
      } catch {
        // A checkpoint id is not the payout. The writer coins below still count.
      }
    }
  }
  const seen = classifyIntent({
    coins,
    spends,
    collateral: row.collateral,
    premium: row.premium,
    writerScript,
    now,
    deadline: row.deadline,
    side,
    vaultScript,
  });
  const settled = seen.phase === "filled" || seen.phase === "refunded" || seen.phase === "funded" || seen.refundable;
  // A prediction's fill pays the user nothing, so there is no payout to look for.
  const classified = settled || !writerScript || side === 1 ? seen : await (async () => {
    const extra = await payoutEvidence(writerScript, intentScript, row.since ?? 0);
    if (!extra.coins.length) return seen;
    return classifyIntent({
      coins: [...coins, ...extra.coins],
      spends: { ...spends, ...extra.spends },
      collateral: row.collateral,
      premium: row.premium,
      writerScript,
      now,
      deadline: row.deadline,
    });
  })();
  let outcome = classified;
  // A fill counts once its output is a vtxo: the premium, or for predict the vault.
  const landing = side === 1 ? vaultScript : writerScript;
  if (outcome.phase === "filled" && landing && outcome.closeTxid) {
    const landed = await payoutLanded(landing, outcome.closeTxid);
    if (!landed) {
      outcome = {
        phase: "funded",
        refundable: false,
        fundingTxid: outcome.fundingTxid,
        closeTxid: "",
      };
    }
  }
  let settleTxid = "";
  let unrolled = false;
  if (outcome.phase === "filled") {
    try {
      const vault = await vaultSpend(row.vaultAddress);
      settleTxid = vault.settleTxid;
      unrolled = vault.unrolled;
    } catch {
      settleTxid = "";
    }
  }
  return { ...outcome, settleTxid, unrolled };
}

async function payoutLanded(writerScript: string, txid: string): Promise<boolean> {
  try {
    const page = await indexer.getVtxos({ scripts: [writerScript] });
    return (page.vtxos ?? []).some((coin) => (coin.txid || "").toLowerCase() === txid.toLowerCase());
  } catch {
    return false;
  }
}

async function vaultSpend(address: string | undefined): Promise<{ settleTxid: string; unrolled: boolean }> {
  if (!address) return { settleTxid: "", unrolled: false };
  const script = pkScriptOf(address);
  const [live, spent] = await Promise.all([
    indexer.getVtxos({ scripts: [script], spendableOnly: true }),
    indexer.getVtxos({ scripts: [script], spentOnly: true }),
  ]);
  const unrolled = (live.vtxos ?? []).some((coin) => Boolean(coin.isUnrolled));
  for (const coin of spent.vtxos ?? []) {
    const id = settlementTxid(coin);
    if (id) return { settleTxid: id, unrolled };
  }
  return { settleTxid: "", unrolled };
}

function addRow(owners: Map<string, WatchRow[]>, script: string, row: WatchRow) {
  const list = owners.get(script) ?? [];
  if (!list.includes(row)) list.push(row);
  owners.set(script, list);
}

let generation = 0;
let hooking: Promise<void> | null = null;
let owners = new Map<string, WatchRow[]>();
let listener: ((update: PhaseUpdate) => void) | null = null;

async function publish(rows: WatchRow[], gen: number) {
  await Promise.all(rows.map(async (row) => {
    if (gen !== generation) return;
    try {
      const phase = await readIntent(row);
      if (gen === generation) listener?.({ address: row.address, ...phase });
    } catch {
      // The manager's subscription retries. This row stays as it was.
    }
  }));
}

function hook(): Promise<void> {
  if (!hooking) {
    hooking = onContractEvent((event) => {
      if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") return;
      const rows = owners.get(event.contractScript);
      if (rows?.length) void publish(rows, generation);
    }).then(() => undefined);
    hooking.catch(() => {
      hooking = null;
    });
  }
  return hooking;
}

export async function watchIntents(
  rows: WatchRow[],
  onUpdate: (update: PhaseUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!rows.length || signal.aborted) return;
  const gen = ++generation;
  listener = onUpdate;
  owners = new Map();
  for (const row of rows) addRow(owners, pkScriptOf(row.address), row);
  await hook();
  if (gen !== generation || signal.aborted) return;
  let failed = false;
  for (const row of rows) {
    if (!row.register) continue;
    try {
      const script = await row.register();
      if (gen !== generation || signal.aborted) return;
      if (script) addRow(owners, script, row);
    } catch (err) {
      failed = true;
      console.error(err);
    }
  }
  if (gen !== generation || signal.aborted) return;
  await publish(rows, gen);
  if (failed) throw new Error("contract register failed");
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
