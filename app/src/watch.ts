import { ArkAddress, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { statePacketOf } from "../../protocol/beacon.ts";
import { ARK_URL } from "../../protocol/constants.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtView, type CoinView, type IntentPhase, type TxOutput } from "../../protocol/intent-state.ts";
import { slotPrice } from "../../settle/vault.ts";
import { intentCoins, onContractEvent } from "./fund.ts";
import { splitPayouts } from "./position-status.ts";
import { settlementTxid } from "./restore.ts";

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
};

const indexer = new RestIndexerProvider(ARK_URL);
const vtxoReads = new Map<string, Promise<{ txid: string; value: number; spentBy: string; createdAt: Date }[]>>();

export function pkScriptOf(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript);
}

/**
 * The user's and the desk's sats on a settlement transaction, and the fixing it
 * read. Output 0 is the beacon. `writerScript` is the user's script.
 */
export async function readKept(
  settleTxid: string,
  writerScript: string,
  expiry?: bigint,
): Promise<{ writer: bigint; desk: bigint; cents?: bigint } | null> {
  try {
    const page = await indexer.getVirtualTxs([settleTxid]);
    const raw = page.txs?.[0];
    if (!raw) return null;
    const split = splitPayouts(psbtView(raw).outputs, writerScript);
    if (!split) return null;
    const cents = expiry == null ? null : fixingOf(raw, expiry);
    return cents == null ? split : { ...split, cents };
  } catch {
    return null;
  }
}

/** The settlement carries the beacon's state packet. The fixing for `expiry` is the price the vault read. */
function fixingOf(raw: string, expiry: bigint): bigint | null {
  try {
    return slotPrice(statePacketOf(Transaction.fromPSBT(base64.decode(raw))), expiry);
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
    raws.push(...page.txs);
  }
  const found: CoinView[] = [];
  const spends: Record<string, TxOutput[]> = {};
  raws.forEach((raw, index) => {
    if (!raw) return;
    let view;
    try {
      view = psbtView(raw);
    } catch {
      return;
    }
    const input = view.inputs.find((item) => item.script.toLowerCase() === intentScript);
    if (!input) return;
    const id = ids[index] || "";
    if (!id) return;
    found.push({ value: input.amount, spent: true, spentBy: id });
    spends[id] = view.outputs;
  });
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
    ids.forEach((id, index) => {
      const raw = page.txs[index];
      if (!raw) return;
      try {
        spends[id] = psbtView(raw).outputs;
      } catch {
        // A checkpoint id is not the payout. The writer coins below still count.
      }
    });
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
  if (outcome.phase === "filled") {
    try {
      settleTxid = await vaultSpend(row.vaultAddress);
    } catch {
      settleTxid = "";
    }
  }
  return { ...outcome, settleTxid };
}

async function payoutLanded(writerScript: string, txid: string): Promise<boolean> {
  try {
    const page = await indexer.getVtxos({ scripts: [writerScript] });
    return (page.vtxos ?? []).some((coin) => (coin.txid || "").toLowerCase() === txid.toLowerCase());
  } catch {
    return false;
  }
}

async function vaultSpend(address: string | undefined): Promise<string> {
  if (!address) return "";
  const spent = await indexer.getVtxos({ scripts: [pkScriptOf(address)], spentOnly: true });
  for (const coin of spent.vtxos ?? []) {
    const id = settlementTxid(coin);
    if (id) return id;
  }
  return "";
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
