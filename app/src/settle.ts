import { fetchOracleFixing } from "../../settle/oracle.ts";
import { reboardPredictVault, refundQuote, settlePredictQuote, type RefundOutcome, type SettleOutcome } from "../../settle/vault.ts";
import { openContract, type FundRequest } from "./fund.ts";

/** Settle a filled standalone PredictVaultV3 directly from the page. */
export async function settleFromPage(req: FundRequest & { fillTxid?: string; fixingUrl?: string }): Promise<SettleOutcome> {
  if (!req.oraclePkHex) throw new Error("This position has no oracle key.");
  const { client, terms } = await openContract(req);
  const fetched = await fetchOracleFixing(req.fixingUrl ?? "/oracle/fixing", Number(req.expiry), req.oraclePkHex);
  if (!fetched.fixing) return { result: "unfixed" };
  return settlePredictQuote({
    chain: client.indexer!,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
    emulator: client.emulator!,
    checkpoint: client.checkpoint,
    fillTxid: req.fillTxid,
    terms,
    fixing: fetched.fixing,
    now: Math.floor(Date.now() / 1000),
  });
}

export async function refundVaultFromPage(req: FundRequest & { fillTxid?: string }): Promise<RefundOutcome> {
  const { client, terms } = await openContract(req);
  return refundQuote({
    chain: client.indexer!,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
    emulator: client.emulator!,
    checkpoint: client.checkpoint,
    fillTxid: req.fillTxid,
    terms,
    now: Math.floor(Date.now() / 1000),
  });
}

/** Reboard an unrolled or expiring PredictVault back offchain unchanged via its `reboard` leaf. */
export async function reboardVaultFromPage(req: FundRequest & { fillTxid?: string }): Promise<{ result: "reboarded"; commitmentTxid: string; intentId: string } | { result: "missing" }> {
  const { client, terms } = await openContract(req);
  return reboardPredictVault({
    client,
    terms,
    fillTxid: req.fillTxid,
  });
}
