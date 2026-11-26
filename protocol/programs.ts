import { arkade } from "@arkade-os/sdk";

import { optionIntentArtifact, predictVaultArtifact } from "../contracts/index.ts";

export { optionIntentArtifact, predictVaultArtifact };

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
  return loadArtifact(predictVaultArtifact as arkade.ContractArtifact);
}

export function intentProgram() {
  return loadArtifact(intentArtifactCast(optionIntentArtifact));
}

function intentArtifactCast(artifact: unknown): arkade.ContractArtifact {
  return artifact as arkade.ContractArtifact;
}
