/**
 * Startup pass over the SDK wallet.
 *
 * `Wallet.finalizePendingTxs` finishes a submit that never reached finalize.
 * It no-ops unless the wallet state says a send was interrupted, so the caller
 * marks that flag first. `refreshCoins` is a full indexer read (`after: 0`):
 * the cursor-derived sync never revisits a swept coin created before the cursor.
 * `recoverVtxos` settles swept or expired coins back to the wallet address.
 * `renewVtxos` settles spendable coins inside the renewal threshold.
 * An empty set is the SDK's "nothing to do" error, not a failed startup.
 */
export type DeskWalletMaintenance = {
  markPending(): Promise<void>;
  finalizePendingTxs(): Promise<{ finalized: string[]; pending: string[] }>;
  refreshCoins(): Promise<void>;
  recoverVtxos(): Promise<string>;
  renewVtxos(): Promise<string>;
};

export type MaintainedCoins = {
  finalized: string[];
  pending: string[];
  recovered: string | null;
  renewed: string | null;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nothingToSettle(err: unknown): boolean {
  const message = messageOf(err);
  return /no recoverable vtxos/i.test(message)
    || /no vtxos available to renew/i.test(message)
    || /below (the )?dust/i.test(message)
    || /renewal already in progress/i.test(message);
}

async function settle(run: () => Promise<string>): Promise<string | null> {
  try {
    return await run();
  } catch (err) {
    if (nothingToSettle(err)) return null;
    console.error("wallet", messageOf(err));
    return null;
  }
}

export async function maintainDeskCoins(wallet: DeskWalletMaintenance): Promise<MaintainedCoins> {
  await wallet.markPending();
  let finalized: string[] = [];
  let pending: string[] = [];
  try {
    ({ finalized, pending } = await wallet.finalizePendingTxs());
  } catch (err) {
    console.error("wallet finalize", messageOf(err));
  }
  try {
    await wallet.refreshCoins();
  } catch (err) {
    console.error("wallet refresh", messageOf(err));
  }
  const recovered = await settle(() => wallet.recoverVtxos());
  const renewed = await settle(() => wallet.renewVtxos());
  return { finalized, pending, recovered, renewed };
}
