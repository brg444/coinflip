import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyIntent, psbtOutputs, psbtView } from "./intent-state.ts";

const writer = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";
const intent = "5120b81cbe74a0c932b6bf2424d28f867cab9fe09cc6eae887050be13dbd1b63d292";

test("a live intent coin after the deadline is refundable, not paid", () => {
  const seen = classifyIntent({
    coins: [{ value: 20_000n, spent: false, spentBy: "" }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.deepEqual(seen, { phase: "expired", refundable: true, fundingTxid: "", closeTxid: "" });
});

test("a live intent coin inside the window is waiting for payout", () => {
  const seen = classifyIntent({
    coins: [{ value: 20_000n, spent: false, spentBy: "" }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
  });
  assert.equal(seen.phase, "funded");
  assert.equal(seen.refundable, false);
});

test("premium on the writer script is paid out, and the full coin back is a refund", () => {
  const paid = classifyIntent({
    coins: [{ value: 20_000n, spent: true, spentBy: "aa" }],
    spends: { aa: [{ amount: 383n, script: writer }, { amount: 20_000n, script: "5120" + "ab".repeat(32) }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.equal(paid.phase, "filled");
  const refunded = classifyIntent({
    coins: [{ value: 20_000n, spent: true, spentBy: "bb" }],
    spends: { bb: [{ amount: 20_000n, script: writer }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.equal(refunded.phase, "refunded");
});

test("a fill with no intent coin still pays the writer", () => {
  const spent = "51205327a5c6693c7f8f932418d934b5517509f3d01cc5a3a8f9e509503c15bcf5bd";
  const view = psbtView(readFileSync(fileURLToPath(new URL("./testdata/fill.b64", import.meta.url)), "utf8"));
  const input = view.inputs.find((item) => item.script === spent);
  assert.ok(input);
  assert.equal(input.amount, 20_000n);
  assert.equal(view.outputs[0]?.amount, 414n);
  assert.equal(view.outputs[0]?.script, writer);
  const seen = classifyIntent({
    coins: [{ value: input.amount, spent: true, spentBy: "fill" }],
    spends: { fill: view.outputs },
    collateral: 20_000n,
    premium: 414n,
    writerScript: writer,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
  });
  assert.deepEqual(seen, { phase: "filled", refundable: false, fundingTxid: "", closeTxid: "" });
});

test("the collateral coin names its funding transaction and the spend that closed it", () => {
  const funding = "11".repeat(32);
  const close = "22".repeat(32);
  const refunded = classifyIntent({
    coins: [{ value: 20_000n, spent: true, spentBy: close, txid: funding }],
    spends: { [close]: [{ amount: 20_000n, script: writer }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.equal(refunded.phase, "refunded");
  assert.equal(refunded.fundingTxid, funding);
  assert.equal(refunded.closeTxid, close);
  const waiting = classifyIntent({
    coins: [{ value: 20_000n, spent: false, spentBy: "", txid: funding }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
  });
  assert.equal(waiting.fundingTxid, funding);
  assert.equal(waiting.closeTxid, "");
});

test("the deposit transaction pays the intent, not the writer", () => {
  const outputs = psbtOutputs("cHNidP8BAJYDAAAAASvbZaMpCvgryeO0CYwtsKTnI7xx4reCIs1RKMnNb9pQAAAAAAD/////AyBOAAAAAAAAIlEguBy+dKDJMra/JCTSj4Z8q5/gnMbq6IcFC+E9vRtj0pKsFgEAAAAAACJRIIBt4BDU8muDp9KwzCmXOn/8OxfRY2Ub/E3lWuxMyNRLAAAAAAAAAAAEUQJOcwAAAAAAAQErzGQBAAAAAAAiUSDo2O2v+0SQZj35FALDvPA1w3SED3TuSSRKNVQocKHQx0EU+7mvX5PiQjSBNbwc7tq9HvaunJqq1AzepanFFd1I6sivE6Y4c9EukYOeJEtIRGdY0EfEgUKxpQA5jYk+vd7gVEB1hkURCtBVH/DExnmHKc4vfC6bQ08LcJn9MizhzAqUrkWtHxmfq9ROyRioAJeLmdumpPlNq8Uk67SVvcrqGZtBQRQwEHiAjk97wNrf4p40sd+OrwEI7waxciJ0B168EHoSeq8Tpjhz0S6Rg54kS0hEZ1jQR8SBQrGlADmNiT693uBUQCdSreMKuLPJQ/+Q69t/EbqYgRQzZDxzN7wK3j9Ax583mq9vqDTTe8YbfCnicl8nnEXMPLnIPYCRydO7ct3cD6tCFcFQkpt0waBJVLeLS2A16XpeB4paDyjsltVHv+6azoA6wBD7N2PgKGU9Lbx0z8XVHNlk3GjWVtIdRhhQ0XnDqLKvRSD7ua9fk+JCNIE1vBzu2r0e9q6cmqrUDN6lqcUV3UjqyK0gMBB4gI5Pe8Da3+KeNLHfjq8BCO8GsXIidAdevBB6EnqswAjedGFwdHJlZXIBwCgDCABAsnUg38rsVYx+eM8+OLiYuopDz7Vycma64yxcWzrrMsVYqgusAcBEIPu5r1+T4kI0gTW8HO7avR72rpyaqtQM3qWpxRXdSOrIrSAwEHiAjk97wNrf4p40sd+OrwEI7waxciJ0B168EHoSeqwAAAAA");
  assert.equal(outputs[0]?.amount, 20_000n);
  assert.equal(outputs[0]?.script, intent);
  assert.equal(outputs[1]?.amount, 71_340n);
  assert.equal(outputs[1]?.script, writer);
});

test("an underfunded live coin above dust is refundable after the deadline and transitions to refunded once cancelled", () => {
  const funding = "33".repeat(32);
  const close = "44".repeat(32);
  const before = classifyIntent({
    coins: [{ value: 5_000n, spent: false, spentBy: "", txid: funding }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
  });
  assert.deepEqual(before, { phase: "open", refundable: false, fundingTxid: "", closeTxid: "" });

  const after = classifyIntent({
    coins: [{ value: 5_000n, spent: false, spentBy: "", txid: funding }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 1_500,
    deadline: 1_000,
  });
  assert.deepEqual(after, { phase: "expired", refundable: true, fundingTxid: funding, closeTxid: "" });

  const dust = classifyIntent({
    coins: [{ value: 330n, spent: false, spentBy: "", txid: funding }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 1_500,
    deadline: 1_000,
  });
  assert.deepEqual(dust, { phase: "expired", refundable: false, fundingTxid: "", closeTxid: "" });

  const refunded = classifyIntent({
    coins: [{ value: 5_000n, spent: true, spentBy: close, txid: funding }],
    spends: { [close]: [{ amount: 5_000n, script: writer }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 1_500,
    deadline: 1_000,
  });
  assert.deepEqual(refunded, { phase: "refunded", refundable: false, fundingTxid: funding, closeTxid: close });
});

test("double payment reports filled while flagging the leftover coin refundable after deadline", () => {
  const fillFunding = "55".repeat(32);
  const extraFunding = "66".repeat(32);
  const fillTx = "77".repeat(32);
  const refundTx = "88".repeat(32);
  const vault = "5120" + "ab".repeat(32);
  const desk = "5120" + "cd".repeat(32);
  const spends = {
    [fillTx]: [{ amount: 50_000n, script: desk }, { amount: 95_000n, script: vault }],
    [refundTx]: [{ amount: 50_000n, script: writer }],
  };
  const beforeDeadline = classifyIntent({
    coins: [
      { value: 50_000n, spent: false, spentBy: "", txid: extraFunding },
      { value: 50_000n, spent: true, spentBy: fillTx, txid: fillFunding },
    ],
    spends,
    collateral: 95_000n,
    premium: 50_000n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
    side: 1,
    vaultScript: vault,
  });
  assert.deepEqual(beforeDeadline, { phase: "filled", refundable: false, fundingTxid: fillFunding, closeTxid: fillTx });

  const afterDeadline = classifyIntent({
    coins: [
      { value: 50_000n, spent: false, spentBy: "", txid: extraFunding },
      { value: 50_000n, spent: true, spentBy: fillTx, txid: fillFunding },
    ],
    spends,
    collateral: 95_000n,
    premium: 50_000n,
    writerScript: writer,
    now: 1_500,
    deadline: 1_000,
    side: 1,
    vaultScript: vault,
  });
  assert.deepEqual(afterDeadline, { phase: "filled", refundable: true, fundingTxid: fillFunding, closeTxid: fillTx });

  const afterRefund = classifyIntent({
    coins: [
      { value: 50_000n, spent: true, spentBy: refundTx, txid: extraFunding },
      { value: 50_000n, spent: true, spentBy: fillTx, txid: fillFunding },
    ],
    spends,
    collateral: 95_000n,
    premium: 50_000n,
    writerScript: writer,
    now: 1_500,
    deadline: 1_000,
    side: 1,
    vaultScript: vault,
  });
  assert.deepEqual(afterRefund, { phase: "filled", refundable: false, fundingTxid: fillFunding, closeTxid: fillTx });

  const shortVault = classifyIntent({
    coins: [{ value: 50_000n, spent: true, spentBy: fillTx, txid: fillFunding }],
    spends: { [fillTx]: [{ amount: 50_000n, script: desk }, { amount: 94_999n, script: vault }] },
    collateral: 95_000n,
    premium: 50_000n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
    side: 1,
    vaultScript: vault,
  });
  assert.equal(shortVault.phase, "open");
});
