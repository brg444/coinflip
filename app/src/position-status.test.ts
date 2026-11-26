import assert from "node:assert/strict";
import test from "node:test";

import { settlementKnown, splitPayouts, usdFromCents } from "./position-status.ts";

const FILL = "4b46f8dafd536990a134a60e909293d0cc164dfd64e377ae0f361526c9536768";
const SETTLEMENT = "eb287e814b7d8e2b8435faf93c0c66d2a43bdfb9b917f4829156f331832b55b0";
const BETTOR = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";
const DESK = "51201111111111111111111111111111111111111111111111111111111111111111";
const OTHER = "51202222222222222222222222222222222222222222222222222222222222222222";

test("settlementKnown and usdFromCents classify settled transactions and format cents", () => {
  assert.equal(settlementKnown({ settleTxid: SETTLEMENT, closeTxid: FILL }), true);
  assert.equal(settlementKnown({ settleTxid: FILL, closeTxid: FILL }), false);
  assert.equal(settlementKnown({ settleTxid: "", closeTxid: FILL }), false);
  assert.equal(usdFromCents(8_277_570n), "82,775.70");
  assert.equal(usdFromCents(5n), "0.05");
});

test("splitPayouts parses standalone PredictVaultV3 win, loss, void refund, and rejects unrelated spends", () => {
  const won = splitPayouts([
    { amount: 95_000n, script: BETTOR },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], BETTOR, DESK);
  assert.deepEqual(won, { writer: 95_000n, desk: 0n });

  const lost = splitPayouts([
    { amount: 95_000n, script: DESK },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], BETTOR, DESK);
  assert.deepEqual(lost, { writer: 0n, desk: 95_000n });

  const voided = splitPayouts([
    { amount: 50_000n, script: BETTOR },
    { amount: 45_000n, script: DESK },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], BETTOR, DESK);
  assert.deepEqual(voided, { writer: 50_000n, desk: 45_000n });

  const unrelated = splitPayouts([
    { amount: 95_000n, script: OTHER },
  ], BETTOR, DESK);
  assert.equal(unrelated, null);
});
