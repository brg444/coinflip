import { reboardPredictVault, refundQuote, type RefundOutcome } from "../../settle/vault.ts";
import { openContract, type FundRequest } from "./fund.ts";

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
