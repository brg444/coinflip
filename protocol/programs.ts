import { arkade } from "@arkade-os/sdk";

import beaconArtifact from "../contracts/attestation_beacon.artifact.json" with { type: "json" };
import swapArtifact from "../contracts/non_interactive_swap.artifact.json" with { type: "json" };
import intentArtifact from "../contracts/option_intent.artifact.json" with { type: "json" };
import vaultArtifact from "../contracts/option_vault.artifact.json" with { type: "json" };
import standingLegArtifact from "../contracts/standing_leg.artifact.json" with { type: "json" };
import standingVaultArtifact from "../contracts/standing_vault.artifact.json" with { type: "json" };

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

export function intentProgram() {
  return loadArtifact(intentArtifact as arkade.ContractArtifact);
}

export function standingLegProgram() {
  return loadArtifact(standingLegArtifact as arkade.ContractArtifact);
}

export function standingVaultProgram() {
  return loadArtifact(standingVaultArtifact as arkade.ContractArtifact);
}

export function swapProgram() {
  return loadArtifact(swapArtifact as arkade.ContractArtifact);
}

export function beaconProgram() {
  return loadArtifact(beaconArtifact as arkade.ContractArtifact);
}

export function rawVaultProgram() {
  return loadArtifact(vaultArtifact as arkade.ContractArtifact);
}

export function rawBeaconProgram() {
  return loadArtifact(beaconArtifact as arkade.ContractArtifact);
}

export function rawIntentProgram() {
  return loadArtifact(intentArtifact as arkade.ContractArtifact);
}

export function rawStandingLegProgram() {
  return loadArtifact(standingLegArtifact as arkade.ContractArtifact);
}

export function rawStandingVaultProgram() {
  return loadArtifact(standingVaultArtifact as arkade.ContractArtifact);
}

export function rawSwapProgram() {
  return loadArtifact(swapArtifact as arkade.ContractArtifact);
}

function count(asm: readonly unknown[] | undefined, name: string) {
  return (asm ?? []).filter((token) => token === name).length;
}

/** One line for the page, taken from the loaded programs rather than the raw JSON. */
export function artifactLine() {
  const vault = vaultProgram();
  const intent = intentProgram();
  const settle = vault.functions.settle?.arkadeScript?.asm ?? [];
  const finalize = intent.functions.finalize?.arkadeScript?.asm ?? [];
  if (!finalize.includes("CHECKTIME")) throw new Error("OptionIntent finalize is missing CHECKTIME");
  if (!settle.includes("INSPECTINASSETLOOKUP") || !settle.includes("INSPECTINPUTPACKET")) {
    throw new Error("OptionVault settle is missing the beacon read");
  }
  return `OptionVault settle reads the beacon identity asset and its state packet. It checks ${count(settle, "MUL")} multiplies and ${count(settle, "DIV")} divides, and no oracle signatures. OptionIntent finalize gates the fill with CHECKTIME(deadline).`;
}
