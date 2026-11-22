import assert from "node:assert/strict";
import test from "node:test";

import { intentSigned } from "../../protocol/dia.ts";
import { hexToBytes } from "../../protocol/hex.ts";
import { intentHashOf } from "./attestations.ts";
import { LIVE_BEACON_STATUS } from "./beacon-status.ts";

test("the copied fixing hashes to the intent DIA registered on Lasernet", () => {
  // IntentRegistered topic 1 in Lasernet tx 0x834139eb58a0cf52a69c0f96159b406490132005bbd7f7da61c1ad6df0a5a180.
  assert.equal(intentHashOf(LIVE_BEACON_STATUS.fixings[0]!), "0xc490f30582d75ef0901b8aac4fdae8aa78648e6f86cd90d753637f6188b7ae25");
});

test("every copied fixing carries the pinned DIA signature", () => {
  for (const fixing of LIVE_BEACON_STATUS.fixings) {
    const intent = { price: BigInt(fixing.raw), time: fixing.time, nonce: BigInt(fixing.nonce), intentExpiry: fixing.intentExpiry, sig: hexToBytes(fixing.sig) };
    assert.equal(intentSigned(intent), true, String(fixing.expiry));
  }
});
