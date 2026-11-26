import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { bin2num, FIX_DOMAIN, FIX_EXPIRY_LAG, FIX_GRID_S, num2bin, predictFixDigest } from "./fixing.ts";
import { bytesToHex } from "./hex.ts";

test("num2bin and bin2num round-trip Bitcoin script integers", () => {
  for (const value of [0n, 1n, 127n, 128n, 255n, 256n, 6_390_772n, 1_795_593_000n, 63_907_720_609_324_293_160_960n]) {
    if (value < (1n << 63n)) {
      const fixed8 = num2bin(value, 8);
      assert.equal(fixed8.length, 8);
      assert.equal(bin2num(fixed8), value);
    }
    const fixed32 = num2bin(value, 32);
    assert.equal(fixed32.length, 32);
    assert.equal(bin2num(fixed32), value);
  }
  assert.equal(bin2num(new Uint8Array()), 0n);
  assert.equal(bin2num(Uint8Array.from([0x80])), 0n);
  assert.equal(bin2num(Uint8Array.from([0x01, 0x80])), -1n);
  assert.throws(() => num2bin(-1n, 8), /negative/);
  assert.throws(() => num2bin(1n << 63n, 8), /does not fit/);
});

test("predictFixDigest matches SHA256(domain || 'fix' || expiry || cents || time)", () => {
  assert.equal(FIX_GRID_S, 300n);
  assert.equal(FIX_EXPIRY_LAG, 60n);
  const expiry = 1_795_593_000n;
  const cents = 5_872_826n;
  const time = 1_795_593_002n;

  const got = predictFixDigest({ expiry, cents, time });
  const expected = createHash("sha256")
    .update(FIX_DOMAIN)
    .update(new TextEncoder().encode("fix"))
    .update(num2bin(expiry, 8))
    .update(num2bin(cents, 8))
    .update(num2bin(time, 8))
    .digest();

  assert.equal(got.length, 32);
  assert.equal(bytesToHex(got), expected.toString("hex"));
  assert.notEqual(bytesToHex(predictFixDigest({ expiry: expiry + 300n, cents, time })), bytesToHex(got));
  assert.notEqual(bytesToHex(predictFixDigest({ expiry, cents: cents + 1n, time })), bytesToHex(got));
  assert.notEqual(bytesToHex(predictFixDigest({ expiry, cents, time: time + 1n })), bytesToHex(got));
});
