import { ArkAddress, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { predictSettlePriceCents } from "../../protocol/cospend.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtView, type IntentPhase, type TxOutput } from "../../protocol/intent-state.ts";
import { virtualTxsById } from "../../protocol/virtual-txs.ts";
import { ACTIVE_ARK_URL, intentCoins, onContractEvent } from "./fund.ts";
import { settlementTxid, splitPayouts } from "./position-status.ts";

export type WatchRow = {
  address: string;
  /** The bettor's address. */
  writerAddress?: string;
  vaultAddress?: string;
  collateral: bigint;
  premium: bigint;
  deadline: number;
  since?: number;
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

export function pkScriptOf(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript);
}

/** Spendable sats at an Arkade address, as the indexer sees them. The wallet itself may also hold coins elsewhere. */
export async function addressBalance(address: string): Promise<bigint> {
  const page = await indexer.getVtxos({ scripts: [pkScriptOf(address)], spendableOnly: true });
  return (page.vtxos ?? []).reduce((sum, coin) => (coin.isSpent || coin.spentBy ? sum : sum + BigInt(coin.value)), 0n);
}

/**
 * The bettor's and the desk's sats on a settlement/refund transaction, plus the
 * fixing price carried in the standalone PredictVaultV3 emulator witness.
 */
export async function readKept(
  settleTxid: string,
  userScript: string,
  expiry?: bigint,
  deskScript?: string,
): Promise<{ writer: bigint; desk: bigint; cents?: bigint } | null> {
  try {
    const page = await indexer.getVirtualTxs([settleTxid]);
    const raw = virtualTxsById(page.txs ?? []).get(settleTxid.toLowerCase());
    if (!raw) return null;
    const split = splitPayouts(psbtView(raw).outputs, userScript, deskScript);
    if (!split) return null;
    const cents = expiry == null ? null : fixingOf(raw);
    return cents == null ? split : { ...split, cents };
  } catch {
    return null;
  }
}

function fixingOf(raw: string): bigint | null {
  try {
    return predictSettlePriceCents(Transaction.fromPSBT(base64.decode(raw)));
  } catch {
    return null;
  }
}

export async function readIntent(row: WatchRow, now = Math.floor(Date.now() / 1000)): Promise<Omit<PhaseUpdate, "address">> {
  const intentScript = pkScriptOf(row.address).toLowerCase();
  const writerScript = row.writerAddress ? pkScriptOf(row.writerAddress) : "";
  const vaultScript = row.vaultAddress ? pkScriptOf(row.vaultAddress) : "";
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
        // Checkpoint ids are not payouts.
      }
    }
  }
  let outcome = classifyIntent({
    coins,
    spends,
    collateral: row.collateral,
    premium: row.premium,
    writerScript,
    now,
    deadline: row.deadline,
    side: 1,
    vaultScript,
  });
  // A fill counts once its vault output is a vtxo.
  if (outcome.phase === "filled" && vaultScript && outcome.closeTxid) {
    const landed = await payoutLanded(vaultScript, outcome.closeTxid);
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

async function payoutLanded(script: string, txid: string): Promise<boolean> {
  try {
    const page = await indexer.getVtxos({ scripts: [script] });
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
