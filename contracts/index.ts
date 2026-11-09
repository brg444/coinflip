/**
 * Import surface for a desk or a UI.
 *
 * The JSON files in this directory are the compiler artifacts. `vaultProgram`
 * and `beaconProgram` load them. The bind and settle helpers are the same
 * functions the services already call; this module only re-exports them.
 */
import attestationBeaconArtifact from "./attestation_beacon.artifact.json" with { type: "json" };
import optionVaultArtifact from "./option_vault.artifact.json" with { type: "json" };

export { attestationBeaconArtifact, optionVaultArtifact };

export { beaconProgram, standingLegProgram, standingVaultProgram, vaultProgram } from "../protocol/programs.ts";

export { bindContracts, type Bound as OptionBound, type Terms } from "../protocol/contracts.ts";

export {
  beaconIdOf,
  bindBeacon,
  type BeaconArgs,
  type BeaconId,
  type Bound as BeaconBound,
} from "../protocol/beacon.ts";

export { buildSettle, submit } from "../protocol/cospend.ts";

export {
  bindHolderLeg,
  bindStandingVault,
  bindWriterLeg,
  buildStandingMatch,
  STANDING_PARTY,
  type StandingTerms,
} from "../protocol/standing.ts";

export { settlePayouts, slotFixing, slotPrice } from "../settle/vault.ts";
