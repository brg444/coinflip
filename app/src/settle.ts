import { parseOracleBeacon } from "../../settle/oracle.ts";
import { refundQuote, settleQuote, type RefundOutcome, type SettleOutcome } from "../../settle/vault.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { openContract, type FundRequest } from "./fund.ts";

/** Settle a filled vault from the page. The position already has the option terms. */
export async function settleFromPage(req: FundRequest & { fillTxid?: string }): Promise<SettleOutcome> {
  if (!req.beaconTxidHex) throw new Error("This position has no beacon.");
  const { client, terms } = await openContract(req);
  const parsed = parseOracleBeacon(LIVE_BEACON_STATUS, req.beaconTxidHex, req.beaconGidx ?? 0);
  if (!parsed.ok) throw new Error(parsed.error);
  return settleQuote({
    chain: client.indexer!,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
    emulator: client.emulator!,
    checkpoint: client.checkpoint,
    fillTxid: req.fillTxid,
    terms,
    beacon: parsed.beacon,
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
