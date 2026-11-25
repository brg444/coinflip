import { isPredict } from "../../protocol/constants.ts";
import { DIA_PUBKEY, findWindowIntent, type DiaIntent } from "../../protocol/dia.ts";
import { fetchSignedOraclePrices, parseOracleBeacon } from "../../settle/oracle.ts";
import { reboardPredictVault, refundQuote, settlePredictQuote, settleQuote, type RefundOutcome, type SettleOutcome } from "../../settle/vault.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { openContract, type FundRequest } from "./fund.ts";

async function findPredictFixing(expiry: number, oraclePk: Uint8Array): Promise<DiaIntent | null> {
  const lag = 60;
  try {
    if (typeof location !== "undefined" && location.origin.startsWith("http")) {
      const samples = await fetchSignedOraclePrices(`${location.origin}/oracle`, expiry, expiry + lag, oraclePk, AbortSignal.timeout(8_000));
      const inWindow = samples
        .filter((s) => s.time >= expiry && s.time <= expiry + lag)
        .sort((a, b) => a.time - b.time);
      if (inWindow[0]) return inWindow[0].intent;
    }
  } catch {
    // Fall through to Lasernet RPC below.
  }
  try {
    return await findWindowIntent(expiry, lag, oraclePk, AbortSignal.timeout(12_000));
  } catch {
    return null;
  }
}

/** Settle a filled vault from the page. Predict settles directly from DIA; Options read the beacon. */
export async function settleFromPage(req: FundRequest & { fillTxid?: string }): Promise<SettleOutcome> {
  const { client, terms } = await openContract(req);
  if (isPredict(req.kind)) {
    const dia = await findPredictFixing(Number(terms.expiry), terms.oraclePk ?? DIA_PUBKEY);
    if (!dia) return { result: "unfixed" };
    return settlePredictQuote({
      chain: client.indexer!,
      serverKey: client.serverKey,
      emulatorKey: client.emulatorKey!,
      emulator: client.emulator!,
      checkpoint: client.checkpoint,
      fillTxid: req.fillTxid,
      terms,
      dia,
      now: Math.floor(Date.now() / 1000),
    });
  }
  if (!req.beaconTxidHex) throw new Error("This position has no beacon.");
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

/** Reboard an unrolled or expiring PredictVault back offchain unchanged via its `reboard` leaf. */
export async function reboardVaultFromPage(req: FundRequest & { fillTxid?: string }): Promise<{ result: "reboarded"; commitmentTxid: string; intentId: string } | { result: "missing" }> {
  const { client, terms } = await openContract(req);
  return reboardPredictVault({
    client,
    terms,
    fillTxid: req.fillTxid,
  });
}
