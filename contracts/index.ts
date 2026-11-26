import optionIntentArtifact from "./option_intent.artifact.json" with { type: "json" };
import predictVaultArtifact from "./predict_vault.artifact.json" with { type: "json" };

/**
 * Layer 0 contract artifacts (`coinflip/contracts`).
 * Strictly dependency-free: imports nothing from `protocol/`, services, or SDKs.
 * For contract binding, fixing digests, and settlement builders, import `coinflip/protocol`.
 */
export { optionIntentArtifact, predictVaultArtifact };

export const CONTRACT_ARTIFACTS = {
  PredictVault: predictVaultArtifact,
  OptionIntent: optionIntentArtifact,
} as const;
