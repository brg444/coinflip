import assert from "node:assert/strict";

import { arkade } from "@arkade-os/sdk";

import {
  artifactLine,
  beaconProgram,
  intentProgram,
  predictVaultProgram,
  rawBeaconProgram,
  rawPredictVaultProgram,
  rawIntentProgram,
  rawSwapProgram,
  rawVaultProgram,
  swapProgram,
  vaultProgram,
} from "../../protocol/programs.ts";

function onlySecondsDiffers(raw: ReturnType<typeof rawVaultProgram>, spent: ReturnType<typeof vaultProgram>) {
  const csv = raw.functions.unilateral?.tapscript?.csv;
  if (csv?.type !== "blocks" || csv.value !== "$exit") {
    throw new Error("compiler artifact unilateral CSV is not a block older(exit)");
  }
  const spentCsv = spent.functions.unilateral?.tapscript?.csv;
  if (spentCsv?.type !== "seconds" || spentCsv.value !== "$exit") {
    throw new Error("spent program did not switch that CSV to seconds");
  }
  const back = {
    ...spent,
    functions: {
      ...spent.functions,
      unilateral: {
        ...spent.functions.unilateral,
        tapscript: {
          ...spent.functions.unilateral.tapscript,
          csv: { type: "blocks" as const, value: "$exit" },
        },
      },
    },
  };
  assert.deepEqual(back, raw);
}

onlySecondsDiffers(rawVaultProgram(), vaultProgram());
onlySecondsDiffers(rawPredictVaultProgram(), predictVaultProgram());
onlySecondsDiffers(rawIntentProgram(), intentProgram());
onlySecondsDiffers(rawSwapProgram(), swapProgram());
onlySecondsDiffers(rawBeaconProgram(), beaconProgram());

const key = (fill: number) => new Uint8Array(32).fill(fill);
const emulatorKey = new Uint8Array(33);
emulatorKey[0] = 0x02;
emulatorKey.set(key(9), 1);

const vault = vaultProgram();
const compiledVault = new arkade.ArkadeProgramScript(
  vault,
  {
    kind: 0n,
    writerPk: key(1),
    holderPk: key(2),
    writerScript: key(3),
    holderScript: key(4),
    strike: 10_000_000n,
    collateral: 10_000_000n,
    expiry: 1_800_000_000n,
    beaconTxid: key(2),
    beaconGidx: 0n,
    readFee: 1_000n,
    exit: 512n,
    server: key(7),
  },
  { serverKey: key(7), emulatorKey },
);

const vaultNames = compiledVault.compiled.map((fn) => fn.name);
if (vaultNames.join() !== "settle,close,unilateral") {
  throw new Error(`unexpected vault functions ${vaultNames.join()}`);
}
const settleAsm = vault.functions.settle?.arkadeScript?.asm ?? [];
const count = (name: string) => settleAsm.filter((token) => token === name).length;
for (const [name, n] of [
  ["CHECKSIGFROMSTACK", 0],
  ["MUL", 2],
  ["DIV", 2],
  ["CHECKTIME", 1],
  ["INSPECTINASSETLOOKUP", 1],
  ["INSPECTINPUTPACKET", 1],
] as const) {
  if (count(name) !== n) throw new Error(`settle has ${count(name)} ${name}, expected ${n}`);
}

const intent = intentProgram();
const compiledIntent = new arkade.ArkadeProgramScript(
  intent,
  {
    userPk: key(1),
    userScript: key(3),
    solverScript: key(4),
    optionScript: key(5),
    side: 0n,
    collateral: 10_000_000n,
    premium: 50_000n,
    deadline: 1_700_000_000n,
    exit: 512n,
    server: key(7),
  },
  { serverKey: key(7), emulatorKey },
);
const intentNames = compiledIntent.compiled.map((fn) => fn.name);
if (intentNames.join() !== "finalize,cancel,unilateral") {
  throw new Error(`unexpected intent functions ${intentNames.join()}`);
}
const cancelAsm = intent.functions.cancel?.arkadeScript?.asm ?? [];
const finalizeAsm = intent.functions.finalize?.arkadeScript?.asm ?? [];
if (!cancelAsm.includes("CHECKTIME")) throw new Error("cancel is missing CHECKTIME");
if (!finalizeAsm.includes("CHECKTIME")) throw new Error("finalize is missing CHECKTIME");

const swap = swapProgram();
const compiledSwap = new arkade.ArkadeProgramScript(
  swap,
  {
    makerPk: key(1),
    offerAssetIdTxid: key(2),
    offerAssetIdGidx: 0n,
    offerAmount: 1_000n,
    wantAssetIdTxid: key(3),
    wantAssetIdGidx: 0n,
    wantAmount: 2_000n,
    expirationTime: 1_800_000_000n,
    exit: 512n,
    server: key(7),
    vtxo_SingleSig_makerPk_exit: key(6),
  },
  { serverKey: key(7), emulatorKey },
);
const swapNames = compiledSwap.compiled.map((fn) => fn.name);
if (swapNames.join() !== "swap,cancel,unilateral") {
  throw new Error(`unexpected swap functions ${swapNames.join()}`);
}
const swapAsm = swap.functions.swap?.arkadeScript?.asm ?? [];
if (swapAsm.filter((token) => token === "INSPECTOUTASSETLOOKUP").length !== 2) {
  throw new Error("swap does not read both asset outputs");
}
if (!swapAsm.includes("$vtxo_SingleSig_makerPk_exit")) {
  throw new Error("swap does not compare output 0 against the maker SingleSig");
}
if (!(swap.functions.cancel?.arkadeScript?.asm ?? []).includes("INSPECTLOCKTIME")) {
  throw new Error("swap cancel is missing INSPECTLOCKTIME");
}

const line = artifactLine();
if (!line.includes("no oracle signatures") || !line.includes("CHECKTIME(deadline)")) {
  throw new Error(line);
}

const predictAsm = predictVaultProgram().functions.settle?.arkadeScript?.asm ?? [];
if (!predictAsm.includes("INSPECTINASSETLOOKUP") || !predictAsm.includes("INSPECTINPUTPACKET")) {
  throw new Error("PredictVault settle is missing the beacon read");
}

console.log("option, predict, swap, and beacon programs load through programFromArtifact");
