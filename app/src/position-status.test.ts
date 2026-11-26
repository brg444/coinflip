import assert from "node:assert/strict";
import test from "node:test";

import { settlementKnown, splitPayouts } from "./position-status.ts";

const FILL = "4b46f8dafd536990a134a60e909293d0cc164dfd64e377ae0f361526c9536768";
const SETTLEMENT = "eb287e814b7d8e2b8435faf93c0c66d2a43bdfb9b917f4829156f331832b55b0";
const WRITER = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";

test("splitPayouts handles standalone V3 payouts, legacy beacon settlements, and settlementKnown", () => {
  const DESK = "51201111111111111111111111111111111111111111111111111111111111111111";
  const OTHER = "51202222222222222222222222222222222222222222222222222222222222222222";
  const beacon = "5120d4b6184f166070f100567c938dbd61c7d12fe24a360002286fc56072dd0cd395";

  assert.equal(settlementKnown({ settleTxid: SETTLEMENT, closeTxid: FILL }), true);
  assert.equal(settlementKnown({ settleTxid: FILL, closeTxid: FILL }), false);
  assert.equal(settlementKnown({ settleTxid: "", closeTxid: FILL }), false);

  // Standalone PredictVaultV3 win and loss (party output at index 0, zero read fee).
  assert.deepEqual(splitPayouts([{ amount: 95_000n, script: WRITER }], WRITER, DESK), { writer: 95_000n, desk: 0n });
  assert.deepEqual(splitPayouts([{ amount: 95_000n, script: DESK }], WRITER, DESK), { writer: 0n, desk: 95_000n });

  const split = splitPayouts([
    { amount: 1330n, script: beacon },
    { amount: 99000n, script: WRITER },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], WRITER);
  assert.deepEqual(split, { writer: 99000n, desk: 0n });

  const lost = splitPayouts([
    { amount: 1330n, script: beacon },
    { amount: 94000n, script: DESK },
    { amount: 0n, script: "6a00" },
  ], WRITER, DESK);
  assert.deepEqual(lost, { writer: 0n, desk: 94000n });

  const unrelated = splitPayouts([
    { amount: 1330n, script: beacon },
    { amount: 94000n, script: OTHER },
  ], WRITER, DESK);
  assert.equal(unrelated, null);

  const partial = splitPayouts([
    { amount: 1330n, script: beacon },
    { amount: 30000n, script: DESK },
    { amount: 69000n, script: WRITER },
  ], WRITER, DESK);
  assert.deepEqual(partial, { writer: 69000n, desk: 30000n });

  const voided = splitPayouts([
    { amount: 20000n, script: WRITER },
    { amount: 18000n, script: DESK },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], WRITER, DESK);
  assert.deepEqual(voided, { writer: 20000n, desk: 18000n });
});
