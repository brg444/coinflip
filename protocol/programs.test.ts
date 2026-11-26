import assert from "node:assert/strict";
import test from "node:test";

import { arkade, SingleKey } from "@arkade-os/sdk";

import { scriptArg } from "./contracts.ts";
import { exitSequence, intentProgram, predictVaultProgram } from "./programs.ts";

const pk = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

test("active contract programs load and bind expected functions and opcodes", async () => {
  const key = async (n: number) => pk(n).xOnlyPublicKey();
  const emulatorKey = await pk(9).compressedPublicKey();
  assert.equal(exitSequence(2048n), 0x400004n);
  assert.throws(() => exitSequence(0n), /512/);
  assert.throws(() => exitSequence(513n), /512/);

  const intent = intentProgram();
  const compiledIntent = new arkade.ArkadeProgramScript(
    intent,
    {
      userPk: await key(1),
      ...scriptArg("userScript", await key(3)),
      ...scriptArg("solverScript", await key(4)),
      ...scriptArg("optionScript", await key(5)),
      side: 1n,
      collateral: 95_000n,
      premium: 50_000n,
      deadline: 1_700_000_000n,
      exit: exitSequence(512n),
      server: await key(7),
    },
    { serverKey: await key(7), emulatorKey },
  );
  assert.deepEqual(compiledIntent.compiled.map((fn) => fn.name), ["finalize", "cancel", "cancelCltv", "unilateral"]);
  assert.ok((intent.functions.cancel?.arkadeScript?.asm ?? []).includes("CHECKTIME"));
  assert.ok((intent.functions.finalize?.arkadeScript?.asm ?? []).includes("CHECKTIME"));

  const predict = predictVaultProgram();
  const compiledVault = new arkade.ArkadeProgramScript(
    predict,
    {
      kind: 2n,
      writerPk: await key(1),
      holderPk: await key(2),
      ...scriptArg("writerScript", await key(3)),
      ...scriptArg("holderScript", await key(4)),
      strike: 9_700_000n,
      collateral: 95_000n,
      stake: 50_000n,
      expiry: 1_800_000_300n,
      oraclePk: await key(5),
      backupPk: await key(6),
      voidAfter: 86_400n,
      fallbackDelay: exitSequence(22_016n),
      finalExitDelay: exitSequence(108_032n),
      server: await key(7),
    },
    { serverKey: await key(7), emulatorKey },
  );
  assert.deepEqual(
    compiledVault.compiled.map((fn) => fn.name),
    ["settle", "refund", "refundBackup", "reboard", "close", "unilateral"],
  );

  const predictAsm = predict.functions.settle?.arkadeScript?.asm ?? [];
  assert.equal(predictAsm.filter((t) => t === "CHECKSIGFROMSTACK").length, 2);
  assert.equal(predictAsm.filter((t) => t === "DIGEST").length, 2);
  assert.equal(predictAsm.filter((t) => t === "INSPECTINASSETLOOKUP").length, 0);
  assert.equal(predictAsm.filter((t) => t === "INSPECTINPUTPACKET").length, 0);
  assert.ok(predictAsm.includes("CHECKTIME"));
  assert.ok((predict.functions.refund?.arkadeScript?.asm ?? []).includes("CHECKTIME"));
  assert.ok((predict.functions.reboard?.arkadeScript?.asm ?? []).includes("TUNNEL"));
  assert.ok((predict.functions.reboard?.arkadeScript?.asm ?? []).includes("INSPECTINTENTMESSAGE"));
  assert.deepEqual(
    Object.keys(predict.functions).sort(),
    ["close", "reboard", "refund", "refundBackup", "settle", "unilateral"],
  );
});
