import { arkade } from "@arkade-os/sdk";

import beaconArtifact from "../contracts/attestation_beacon.artifact.json" with { type: "json" };
import intentArtifact from "../contracts/option_intent.artifact.json" with { type: "json" };
import vaultArtifact from "../contracts/option_vault.artifact.json" with { type: "json" };
import predictArtifact from "../contracts/predict_vault.artifact.json" with { type: "json" };
import { isPredict } from "./constants.ts";

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

export function vaultProgram() {
  return loadArtifact(vaultArtifact as arkade.ContractArtifact);
}

export function predictVaultProgram() {
  return loadArtifact(predictArtifact as arkade.ContractArtifact);
}

export function vaultProgramFor(kind: number) {
  return isPredict(kind) ? predictVaultProgram() : vaultProgram();
}

export function intentProgram() {
  return loadArtifact(intentArtifact as arkade.ContractArtifact);
}

export function beaconProgram() {
  return loadArtifact(beaconArtifact as arkade.ContractArtifact);
}
