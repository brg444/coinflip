import { arkade } from "@arkade-os/sdk";

import intentArtifact from "../contracts/option_intent.artifact.json" with { type: "json" };
import predictArtifact from "../contracts/predict_vault.artifact.json" with { type: "json" };

// BIP68 time-based relative locktime: bit 22 set, value in 512-second units.
export function exitSequence(seconds: bigint): bigint {
  if (seconds <= 0n || seconds % 512n !== 0n) {
    throw new Error(`exit must be a positive multiple of 512 seconds, got ${seconds}`);
  }
  const units = seconds / 512n;
  if (units > 0xffffn) throw new Error(`exit ${seconds} exceeds BIP68 seconds range`);
  return (1n << 22n) | units;
}

function loadArtifact(artifact: arkade.ContractArtifact): ReturnType<typeof arkade.programFromArtifact> {
  return arkade.programFromArtifact(artifact);
}

export function predictVaultProgram() {
  return loadArtifact(predictArtifact as arkade.ContractArtifact);
}

export function intentProgram() {
  return loadArtifact(intentArtifact as arkade.ContractArtifact);
}
