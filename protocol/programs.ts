import { arkade } from "@arkade-os/sdk";

import beaconArtifact from "../contracts/attestation_beacon.artifact.json" with { type: "json" };
import swapArtifact from "../contracts/non_interactive_swap.artifact.json" with { type: "json" };
import intentArtifact from "../contracts/option_intent.artifact.json" with { type: "json" };
import vaultArtifact from "../contracts/option_vault.artifact.json" with { type: "json" };
import predictArtifact from "../contracts/predict_vault.artifact.json" with { type: "json" };
import { isPredict } from "./constants.ts";

// CHECKTIME (0xdc) is in the SDK. The vault's slot loop still compiles to OP_PUT
// (0xbb), which that table does not list, so the spent program cannot load
// without this entry.
const ops = arkade.ARKADE_OPS as Record<string, number>;
const op = arkade.ARKADE_OP as Record<string, number>;
if (!Object.hasOwn(ops, "PUT")) {
  ops.PUT = 0xbb;
  op.PUT = 0xbb;
}

/**
 * The programs the desk spends.
 *
 * `contracts/*.artifact.json` are the arkadec output. Callers load them with
 * `arkade.programFromArtifact`. Nothing compiles the `.ark` sources at runtime.
 *
 * `older(exit)` is emitted as a block CSV. Public arkd rejects that on an exit
 * leaf, so the spent program sets the BIP68 seconds bit on the same `$exit`
 * integer. Nothing else in the artifact is edited.
 */
function secondsExit(artifact: arkade.ContractArtifact): ReturnType<typeof arkade.programFromArtifact> {
  const program = arkade.programFromArtifact(artifact);
  const unilateral = program.functions.unilateral;
  const csv = unilateral?.tapscript?.csv;
  if (!unilateral?.tapscript || csv?.type !== "blocks" || csv.value !== "$exit") {
    throw new Error(`${program.name} unilateral leaf is not the block CSV arkadec emits for older(exit)`);
  }
  return {
    ...program,
    functions: {
      ...program.functions,
      unilateral: {
        ...unilateral,
        tapscript: {
          ...unilateral.tapscript,
          csv: { type: "seconds", value: csv.value },
        },
      },
    },
  };
}

export function vaultProgram() {
  return secondsExit(vaultArtifact as arkade.ContractArtifact);
}

/** OptionVault with an all-or-nothing payoff. Kinds 2 (higher) and 3 (lower). */
export function predictVaultProgram() {
  return secondsExit(predictArtifact as arkade.ContractArtifact);
}

/** The vault a kind settles through. */
export function vaultProgramFor(kind: number) {
  return isPredict(kind) ? predictVaultProgram() : vaultProgram();
}

export function intentProgram() {
  return secondsExit(intentArtifact as arkade.ContractArtifact);
}

/**
 * The compiler's NonInteractiveSwap, the pattern OptionIntent copies. Its
 * `swap` path compares output 0 against `new SingleSig(makerPk, exit)`, which
 * arkadec emits as the `vtxo_SingleSig_makerPk_exit` parameter: the 32-byte
 * witness program of that SingleSig, built by the caller.
 */
export function swapProgram() {
  return secondsExit(swapArtifact as arkade.ContractArtifact);
}

/** The committee registry the beacon vault reads. See contracts/beacon.md. */
export function beaconProgram() {
  return secondsExit(beaconArtifact as arkade.ContractArtifact);
}

export function rawVaultProgram() {
  return arkade.programFromArtifact(vaultArtifact as arkade.ContractArtifact);
}

export function rawPredictVaultProgram() {
  return arkade.programFromArtifact(predictArtifact as arkade.ContractArtifact);
}

export function rawBeaconProgram() {
  return arkade.programFromArtifact(beaconArtifact as arkade.ContractArtifact);
}

export function rawIntentProgram() {
  return arkade.programFromArtifact(intentArtifact as arkade.ContractArtifact);
}

export function rawSwapProgram() {
  return arkade.programFromArtifact(swapArtifact as arkade.ContractArtifact);
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
