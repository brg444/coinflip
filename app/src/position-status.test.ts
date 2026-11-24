import assert from "node:assert/strict";
import test from "node:test";

import { positionOutcome, splitPayouts } from "./position-status.ts";

const FILL = "4b46f8dafd536990a134a60e909293d0cc164dfd64e377ae0f361526c9536768";
const SETTLEMENT = "eb287e814b7d8e2b8435faf93c0c66d2a43bdfb9b917f4829156f331832b55b0";
const WRITER = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";

test("a spent vault says the collateral left and the writer kept 99000 sats", () => {
  const split = splitPayouts([
    { amount: 1330n, script: "5120d4b6184f166070f100567c938dbd61c7d12fe24a360002286fc56072dd0cd395" },
    { amount: 99000n, script: WRITER },
    { amount: 0n, script: "6a00" },
    { amount: 0n, script: "51024e73" },
  ], WRITER);
  assert.deepEqual(split, { writer: 99000n, desk: 0n });

  const line = positionOutcome({
    status: "filled",
    expiry: 1n,
    settleTxid: SETTLEMENT,
    closeTxid: FILL,
    writerKeep: split?.writer.toString(),
    deskTake: split?.desk.toString(),
    settleCents: "8277570",
  }, 2_000_000_000);
  assert.equal(line, "The collateral left the vault. You kept 0.00099 BTC. The read fee took 1000 sats. Price $82,775.70.");
  assert.doesNotMatch(line, /still in the vault|no one has won/);

  const open = positionOutcome({
    status: "filled",
    expiry: 1n,
    settleTxid: "",
    closeTxid: FILL,
  }, 2_000_000_000);
  assert.match(open, /still in the vault/);
  assert.match(open, /The read fee takes 1000 sats of the collateral/);

  const paid = positionOutcome({
    status: "filled",
    expiry: 4_000_000_000n,
    closeTxid: FILL,
  }, 2_000_000_000);
  assert.equal(paid, "Premium paid. The collateral stays in the vault until expiry. The read fee takes 1000 sats of the collateral.");
});

test("splitPayouts recognizes a 0-user-payout settlement when deskScript matches and rejects unrelated outputs", () => {
  const DESK = "51201111111111111111111111111111111111111111111111111111111111111111";
  const OTHER = "51202222222222222222222222222222222222222222222222222222222222222222";
  const beacon = "5120d4b6184f166070f100567c938dbd61c7d12fe24a360002286fc56072dd0cd395";

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
