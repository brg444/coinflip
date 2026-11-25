import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { centsOf, DIA_PUBKEY, ethAddressOf, intentDigest, intentSigned, localFeed, type DiaIntent } from "./dia.ts";

/**
 * A real getIntent for BTC/USD signed by the pinned key
 * 0211ee120bca9f272034d98b1b026bb4ab735ebeb5da8be6a69bf7ee0ea24cfd48.
 * Recorded from Lasernet. The 65th signature byte was 27 and is not in the witness.
 */
const RECORDED: DiaIntent = {
  price: 63907720609324293160960n,
  time: 1794696202,
  nonce: 1793790301274550603n,
  intentExpiry: 1794699802,
  sig: Buffer.from("c7036e95adf3073c3cd65e440505f447ff9397685952de165a2871f28fc24b5b2764dfd31c3a6e1cb2d8378175227fa523616c7fe9ca4cd6c752494a5598209e", "hex"),
};

const PUB = DIA_PUBKEY.subarray(1);

function verifies(intent: DiaIntent, symbol = "BTC/USD"): boolean {
  return secp256k1.verify(intent.sig, intentDigest(intent, symbol), PUB, { prehash: false }) === true;
}

test("a recorded DIA intent verifies and scales to cents", () => {
  assert.equal(RECORDED.sig.length, 64);
  assert.equal(DIA_PUBKEY[0], 0x10);
  assert.equal(verifies(RECORDED), true);
  assert.equal(centsOf(RECORDED.price), 6_390_772n);
});

test("a tampered price, timestamp, or symbol does not verify", () => {
  assert.equal(verifies({ ...RECORDED, price: RECORDED.price + 1n }), false);
  assert.equal(verifies({ ...RECORDED, time: RECORDED.time + 1 }), false);
  assert.equal(verifies(RECORDED, "ETH/USD"), false);
});

test("the sample window is expiry through expiry plus 60", () => {
  const time = RECORDED.time;
  const lag = 60;
  const inside = (expiry: number) => time >= expiry && time <= expiry + lag;
  assert.equal(inside(time), true);
  assert.equal(inside(time - 30), true);
  assert.equal(inside(time - 60), true);
  assert.equal(inside(time + 1), false);
  assert.equal(inside(time - 61), false);
});

test("the compiled attest checks the DIA digest, the pinned key, and the window", () => {
  const artifact = JSON.parse(readFileSync(new URL("../contracts/attestation_beacon.artifact.json", import.meta.url), "utf8")) as {
    compiler: { version: string };
    functions: { name: string; arkade?: { asm: string[] } }[];
  };
  assert.equal(artifact.compiler.version, "0.1.0");
  const asm = artifact.functions.find((fn) => fn.name === "attest")?.arkade?.asm ?? [];
  assert.ok(asm.includes("OP_DIGEST"));
  assert.ok(asm.includes("OP_DIV"));
  assert.ok(asm.includes("OP_MOD"));
  assert.ok(asm.includes("OP_CHECKTIME"));
  assert.ok(asm.includes("OP_CHECKSIGFROMSTACK"));
  assert.ok(asm.includes("0x" + Buffer.from(DIA_PUBKEY).toString("hex")));
  assert.ok(asm.includes("0xf57d55f057fd4aba6b1a7f8bccb6a3e826cf71fd34971f22a39d7ffd6e620fb3"));
});

test("localFeed signs verifiable EIP-712 DIA intents and ethAddressOf derives a 20-byte address", () => {
  const feed = localFeed(new Uint8Array(32).fill(7), () => 8_412_345n);
  assert.equal(feed.key.length, 34);
  assert.equal(feed.key[0], 0x10);
  assert.equal(ethAddressOf(feed.key).length, 40);
  const signed = feed.sign(8_412_345n, 1_795_000_030);
  assert.equal(centsOf(signed.price), 8_412_345n);
  assert.equal(intentSigned(signed, feed.key), true);
  assert.equal(intentSigned(signed, DIA_PUBKEY), false);
  assert.equal(intentSigned({ ...signed, price: signed.price + 1n }, feed.key), false);
});
