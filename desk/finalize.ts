import { Intent, Transaction, type DefaultVtxo, type Identity, type IndexerProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { bytesToHex } from "../protocol/hex.ts";

type Script = DefaultVtxo.Script;

export type PendingArk = {
  getPendingTxs(intent: {
    proof: string;
    message: { type: "get-pending-tx"; expire_at: number };
  }): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }[]>;
  finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
  /** Present on RestArkProvider. Used when arkd has dropped the offchain row. */
  submitTx?(signedArkTx: string, checkpointTxs: string[]): Promise<{
    arkTxid: string;
    signedCheckpointTxs: string[];
  }>;
};

type Indexer = Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;

type Coin = { txid: string; vout: number; value: number; arkTxId?: string };

function sameScript(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return !!left && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Add the desk signature to a checkpoint that spends the desk script. Other checkpoints pass through. */
export async function cosignCheckpoint(identity: Identity, deskScript: Uint8Array, raw: string): Promise<string> {
  const tx = Transaction.fromPSBT(base64.decode(raw));
  if (!sameScript(tx.getInput(0).witnessUtxo?.script, deskScript)) return raw;
  try {
    const signed = await identity.sign(tx, [0]);
    return base64.encode(signed.toPSBT());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The checkpoint was already signed with this key before submit.
    if (/same key/i.test(message)) return raw;
    throw err;
  }
}

async function ownershipProof(identity: Identity, desk: Script, coins: Coin[]) {
  const message = { type: "get-pending-tx" as const, expire_at: 0 };
  const proof = Intent.create(message, coins.map((coin) => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: desk.encode(),
    intentTapLeafScript: desk.forfeit(),
    forfeitTapLeafScript: desk.forfeit(),
  })) as Parameters<typeof Intent.create>[1], []);
  const signed = await identity.sign(proof);
  return { proof: base64.encode(signed.toPSBT()), message };
}

function prevTxid(tx: Transaction, index: number): string {
  const raw = tx.getInput(index).txid;
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error("ark input missing txid");
  return bytesToHex(raw);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notFound(err: unknown): boolean {
  return /not found/i.test(messageOf(err));
}

function alreadySpent(err: unknown): boolean {
  return /already spent/i.test(messageOf(err));
}

// The regtest emulator finalizes inside submitTx. A second finalizeTx is rejected
// because the package is already done, and the outputs are spendable vtxos.
function alreadyFinalized(err: unknown): boolean {
  return /not in a valid stage to finalize/i.test(messageOf(err));
}

// Arkd spent these inputs and then lost the offchain row. Submit and finalize both refuse.
const stuckArkTxs = new Set<string>();
// Those outpoints are not pending work anymore. The indexer can keep listing them.
const clearedOutpoints = new Set<string>();

type Outpoint = { txid: string; vout: number };
type ReconcileSpent = (outpoints: Outpoint[]) => Promise<void>;

function outpointId(coin: Outpoint): string {
  return `${coin.txid}:${coin.vout}`;
}

/** Arkd has no offchain tx left. Refresh the wallet row and stop treating the coin as pending. */
async function dropAlreadySpent(
  coins: Outpoint[],
  arkTxid: string | undefined,
  reconcile?: ReconcileSpent,
): Promise<void> {
  if (arkTxid) stuckArkTxs.add(arkTxid);
  if (!coins.length) return;
  const outpoints = coins.map((coin) => ({ txid: coin.txid, vout: coin.vout }));
  for (const coin of outpoints) clearedOutpoints.add(outpointId(coin));
  if (!reconcile) return;
  try {
    await reconcile(outpoints);
  } catch (err) {
    console.error("finalize refresh", messageOf(err));
  }
}

/** The indexer returns virtual txs sorted by txid, not in the order we asked. */
function virtualTxsById(raws: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const raw of raws) {
    if (!raw) continue;
    found.set(Transaction.fromPSBT(base64.decode(raw)).id, raw);
  }
  return found;
}

async function cosignedCheckpoints(identity: Identity, deskScript: Uint8Array, raws: string[]): Promise<string[]> {
  return Promise.all(raws.map((raw) => cosignCheckpoint(identity, deskScript, raw)));
}

async function finalizeOrSubmit(
  opts: { ark: PendingArk; identity: Identity; deskScript: Script },
  txid: string,
  rawArkTx: string,
  checkpoints: string[],
  logLabel: string,
): Promise<void> {
  const script = opts.deskScript.pkScript;
  const signed = await cosignedCheckpoints(opts.identity, script, checkpoints);
  try {
    await opts.ark.finalizeTx(txid, signed);
  } catch (err) {
    if (!notFound(err) || !opts.ark.submitTx) throw err;
    console.error(logLabel, txid);
    const submitted = await opts.ark.submitTx(rawArkTx, checkpoints);
    const cosigned = await cosignedCheckpoints(opts.identity, script, submitted.signedCheckpointTxs);
    await opts.ark.finalizeTx(submitted.arkTxid, cosigned);
  }
}

/** Arkd lists a pending spend only when the vtxo row carries ArkTxid. The indexer already has it. */
async function finalizeFromIndexer(opts: {
  ark: PendingArk;
  indexer: Indexer;
  identity: Identity;
  deskScript: Script;
  reconcileSpent?: ReconcileSpent;
}, coins: Coin[]): Promise<string[]> {
  const ids = [...new Set(coins.map((coin) => coin.arkTxId).filter((id): id is string => !!id))];
  if (!ids.length) {
    console.error("finalize indexer has no ark tx for", coins.length, "coins");
    return [];
  }
  const arkTxs = virtualTxsById((await opts.indexer.getVirtualTxs(ids)).txs);
  const finalized: string[] = [];
  for (const arkTxid of ids) {
    const raw = arkTxs.get(arkTxid);
    if (!raw) {
      console.error("finalize virtual tx missing", arkTxid);
      continue;
    }
    try {
      const arkTx = Transaction.fromPSBT(base64.decode(raw));
      const checkpointIds: string[] = [];
      for (let input = 0; input < arkTx.inputsLength; input += 1) checkpointIds.push(prevTxid(arkTx, input));
      const fetched = virtualTxsById((await opts.indexer.getVirtualTxs(checkpointIds)).txs);
      const ordered = checkpointIds.map((id) => {
        const checkpoint = fetched.get(id);
        if (!checkpoint) throw new Error(`checkpoint ${id} missing`);
        return checkpoint;
      });
      await finalizeOrSubmit(opts, arkTxid, raw, ordered, "finalize resubmit");
      finalized.push(arkTxid);
    } catch (err) {
      if (alreadySpent(err)) {
        const involved = coins.filter((coin) => coin.arkTxId === arkTxid);
        await dropAlreadySpent(involved.length ? involved : coins, arkTxid, opts.reconcileSpent);
        console.error(
          "finalize stuck",
          arkTxid,
          "arkd marked an input spent and has no offchain tx to finish:",
          messageOf(err),
        );
        continue;
      }
      console.error("finalize", arkTxid, messageOf(err));
    }
  }
  return finalized;
}

/**
 * Finish the package the emulator just returned.
 * Covenant send() stops there. When the emulator is not the last signer it has not
 * called arkd, so finalize is "not found" and we submit this package ourselves.
 */
export async function settleEmulatorTx(opts: {
  ark: PendingArk;
  identity: Identity;
  deskScript: Script;
  txid: string;
  signedArkTx: string;
  signedCheckpointTxs: string[];
  /** Inputs of this package. Dropped from the pending set when arkd says they are already spent. */
  inputs?: Outpoint[];
  reconcileSpent?: ReconcileSpent;
}): Promise<boolean> {
  if (!opts.signedArkTx || !opts.signedCheckpointTxs.length) return false;
  try {
    await finalizeOrSubmit(opts, opts.txid, opts.signedArkTx, opts.signedCheckpointTxs, "finalize submit");
    return true;
  } catch (err) {
    if (alreadySpent(err)) {
      await dropAlreadySpent(opts.inputs ?? [], opts.txid, opts.reconcileSpent);
      console.error("finalize stuck", opts.txid, messageOf(err));
      return false;
    }
    if (alreadyFinalized(err)) return true;
    console.error("finalize", opts.txid, messageOf(err));
    return false;
  }
}

/** Sign and finalize ark txs that already spent the desk script but never cleared finalizeTx. */
export async function finalizeDeskSpends(opts: {
  ark: PendingArk;
  indexer: Indexer;
  identity: Identity;
  deskScript: Script;
  /** Indexer refresh for a VTXO_ALREADY_SPENT outpoint. The SDK wallet does this so the cache can catch up. */
  reconcileSpent?: ReconcileSpent;
}): Promise<string[]> {
  const page = await opts.indexer.getVtxos({
    scripts: [bytesToHex(opts.deskScript.pkScript)],
    pendingOnly: true,
  });
  const coins = (page.vtxos ?? []).filter((coin) => (
    coin.txid && coin.isSpent !== false && !clearedOutpoints.has(`${coin.txid}:${coin.vout}`)
  ));
  if (!coins.length) return [];
  if (coins.every((coin) => coin.arkTxId && stuckArkTxs.has(coin.arkTxId))) {
    await dropAlreadySpent(coins, undefined, opts.reconcileSpent);
    return [];
  }
  const intent = await ownershipProof(opts.identity, opts.deskScript, coins);
  const pending = await opts.ark.getPendingTxs(intent);
  const finalized: string[] = [];
  for (const tx of pending ?? []) {
    if (!tx?.arkTxid || !tx.signedCheckpointTxs?.length) {
      console.error("finalize bad pending tx", tx ? Object.keys(tx).join(",") : "empty");
      continue;
    }
    try {
      const checkpoints = await Promise.all(tx.signedCheckpointTxs.map((raw) => (
        cosignCheckpoint(opts.identity, opts.deskScript.pkScript, raw)
      )));
      await opts.ark.finalizeTx(tx.arkTxid, checkpoints);
      finalized.push(tx.arkTxid);
    } catch (err) {
      if (alreadySpent(err)) {
        const involved = coins.filter((coin) => !coin.arkTxId || coin.arkTxId === tx.arkTxid);
        await dropAlreadySpent(involved, tx.arkTxid, opts.reconcileSpent);
        console.error("finalize stuck", tx.arkTxid, messageOf(err));
        continue;
      }
      console.error("finalize", tx.arkTxid, err instanceof Error ? err.message : err);
    }
  }
  if (finalized.length || pending?.length) return finalized;
  console.error("finalize no pending txs for", coins.length, "coins");
  return finalizeFromIndexer(opts, coins);
}

/** Outpoints of desk coins sitting in an unfinalized spend. */
export async function pendingOutpoints(indexer: Indexer, deskScript: Script): Promise<Set<string>> {
  const page = await indexer.getVtxos({
    scripts: [bytesToHex(deskScript.pkScript)],
    pendingOnly: true,
  });
  const ids = new Set<string>();
  for (const coin of page.vtxos ?? []) {
    const id = `${coin.txid}:${coin.vout}`;
    if (coin.isSpent === false || clearedOutpoints.has(id)) continue;
    ids.add(id);
  }
  return ids;
}
