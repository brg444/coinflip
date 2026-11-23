import attestationBeaconArtifact from "./attestation_beacon.artifact.json" with { type: "json" };
import optionVaultArtifact from "./option_vault.artifact.json" with { type: "json" };
import predictVaultArtifact from "./predict_vault.artifact.json" with { type: "json" };

export { attestationBeaconArtifact, optionVaultArtifact, predictVaultArtifact };

export { beaconProgram, predictVaultProgram, vaultProgram } from "../protocol/programs.ts";

export { bindContracts, type Bound as OptionBound, type Terms } from "../protocol/contracts.ts";

export {
  beaconIdOf,
  bindBeacon,
  type BeaconArgs,
  type BeaconId,
  type Bound as BeaconBound,
} from "../protocol/beacon.ts";

export { buildSettle, submit } from "../protocol/cospend.ts";

export { settlePayouts, slotFixing, slotPrice } from "../settle/vault.ts";
