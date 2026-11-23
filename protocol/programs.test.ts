import assert from "node:assert/strict";
import test from "node:test";

import { arkade } from "@arkade-os/sdk";

import { scriptArg } from "./contracts.ts";
import { beaconProgram, exitSequence, intentProgram, predictVaultProgram, vaultProgram } from "./programs.ts";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const emulatorKey = new Uint8Array(33);
emulatorKey[0] = 0x02;
emulatorKey.set(key(9), 1);

test("active contract programs load and bind expected functions and opcodes", () => {
  assert.equal(exitSequence(2048n), 0x400004n);

  const vault = vaultProgram();
  const compiledVault = new arkade.ArkadeProgramScript(
    vault,
    {
      kind: 0n,
      writerPk: key(1),
      holderPk: key(2),
      ...scriptArg("writerScript", key(3)),
      ...scriptArg("holderScript", key(4)),
      strike: 10_000_000n,
      collateral: 10_000_000n,
      expiry: 1_800_000_000n,
      beaconTxid: key(2),
      beaconGidx: 0n,
      readFee: 1_000n,
      exit: exitSequence(512n),
      server: key(7),
    },
    { serverKey: key(7), emulatorKey },
  );
  assert.deepEqual(compiledVault.compiled.map((fn) => fn.name), ["settle", "close", "unilateral"]);

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
    assert.equal(count(name), n, `settle ${name}`);
  }

  const intent = intentProgram();
  const compiledIntent = new arkade.ArkadeProgramScript(
    intent,
    {
      userPk: key(1),
      ...scriptArg("userScript", key(3)),
      ...scriptArg("solverScript", key(4)),
      ...scriptArg("optionScript", key(5)),
      side: 0n,
      collateral: 10_000_000n,
      premium: 50_000n,
      deadline: 1_700_000_000n,
      exit: exitSequence(512n),
      server: key(7),
    },
    { serverKey: key(7), emulatorKey },
  );
  assert.deepEqual(compiledIntent.compiled.map((fn) => fn.name), ["finalize", "cancel", "unilateral"]);
  assert.ok((intent.functions.cancel?.arkadeScript?.asm ?? []).includes("CHECKTIME"));
  assert.ok((intent.functions.finalize?.arkadeScript?.asm ?? []).includes("CHECKTIME"));

  const predictAsm = predictVaultProgram().functions.settle?.arkadeScript?.asm ?? [];
  assert.ok(predictAsm.includes("INSPECTINASSETLOOKUP"));
  assert.ok(predictAsm.includes("INSPECTINPUTPACKET"));
  assert.deepEqual(Object.keys(beaconProgram().functions).sort(), ["attest", "migrate", "read", "unilateral"]);
});
