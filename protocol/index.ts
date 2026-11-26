/**
 * Layer 1 protocol SDK (`coinflip/protocol`).
 * Depends strictly downward on Layer 0 (`coinflip/contracts`); zero imports from services or UI.
 */
export { optionIntentArtifact, predictVaultArtifact, exitSequence, intentProgram, predictVaultProgram } from "./programs.ts";
export {
  addressOf,
  assertServerExit,
  bindContracts,
  directPayout,
  directPayoutKey,
  payoutVtxo,
  scriptArg,
  type Bound as PredictBound,
  type Terms,
} from "./contracts.ts";
export { FIX_DOMAIN, FIX_EXPIRY_LAG, FIX_GRID_S, bin2num, num2bin, predictFixDigest } from "./fixing.ts";
export { DUST, holderPayoff, settlePayouts, settlementOutputs, writerPayoff } from "./payoff.ts";
export { payoutMultiplier, predictMultiplier, predictPayout, probAbove } from "./pricing.ts";
export { buildPredictSettle, buildRefund, predictSettlePriceCents, refundOutputs, submit } from "./cospend.ts";
export {
  createHttpOracleClient,
  fetchOracleFixing,
  fetchOraclePrices,
  fetchOracleStatus,
  parseOracleFixing,
  parseOracleKey,
  parseOracleLatest,
  serviceOrigin,
  type OracleFixing,
  type OracleKeyInfo,
  type OracleLatest,
  type OracleSample,
} from "./oracle-client.ts";
export {
  duePositions,
  manualPositions,
  positionFromAnnouncement,
  settlementPositions,
  termsFor,
  type WatchPosition,
} from "./positions.ts";
export {
  reboardPredictVault,
  refundQuote,
  settlePredictQuote,
  type Chain,
  type ChainCoin,
  type RefundOutcome,
  type SettleOutcome,
} from "./vault-ops.ts";
export {
  InMemoryRfqBus,
  type OracleFeedPort,
  type PositionFeed,
  type RfqClient,
  type RfqMessage,
  type RfqTransport,
  type SpotFeedPort,
  type SpotTick,
  type VolSurfacePort,
} from "./ports.ts";
