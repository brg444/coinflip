import { isPredict } from "../../protocol/constants.ts";
import { fetchOracleFixing, parseOracleBeacon } from "../../settle/oracle.ts";
import { reboardPredictVault, refundQuote, settlePredictQuote, settleQuote, type RefundOutcome, type SettleOutcome } from "../../settle/vault.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { ACTIVE_PROFILE, openContract, type FundRequest } from "./fund.ts";

/** Settle a filled vault from the page: direct signed fixing for Predict, beacon read for Options. */
export async function settleFromPage(req: FundRequest & { fillTxid?: string; fixingUrl?: string }): Promise<SettleOutcome> {
  if (isPredict(req.kind)) {
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
  if (!req.beaconTxidHex) throw new Error("This position has no beacon.");
  const parsed = parseOracleBeacon(LIVE_BEACON_STATUS, req.beaconTxidHex, req.beaconGidx ?? 0, ACTIVE_PROFILE.hrp);
  if (!parsed.ok) throw new Error(parsed.error);
  const { client, terms } = await openContract(req);
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

/** Reboard an unrolled or expiring PredictVault back offchain unchanged via its `reboard` leaf. */
export async function reboardVaultFromPage(req: FundRequest & { fillTxid?: string }): Promise<{ result: "reboarded"; commitmentTxid: string; intentId: string } | { result: "missing" }> {
  const { client, terms } = await openContract(req);
  return reboardPredictVault({
    client,
    terms,
    fillTxid: req.fillTxid,
  });
}
