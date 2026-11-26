import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";

import { EXIT } from "../protocol/constants.ts";
import { bindContracts, directPayoutKey, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { clearAddress, parseWriterAddress, paymentUri, readAddress, readPubkey, saveAddress, verifiedSignerKey } from "./src/fund.ts";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf848nste9qrnlrjwdc39u8pmyczeuwf2g4cfjhqa8esm8mt05u9ev8d3v5pf";

function memory() {
  const box = new Map();
  return {
    getItem: (key) => (box.has(key) ? box.get(key) : null),
    setItem: (key, value) => box.set(key, value),
    removeItem: (key) => box.delete(key),
  };
}

test("a deposit link is the SDK BIP21 form, including one sat", () => {
  assert.equal(paymentUri(ADDRESS, 20_000n), `bitcoin:?ark=${ADDRESS}&amount=0.0002`);
  assert.equal(paymentUri(ADDRESS, 1n), `bitcoin:?ark=${ADDRESS}&amount=0.00000001`);
});

test("a Mutinynet address is saved and a key is refused", () => {
  globalThis.localStorage = memory();
  assert.throws(() => saveAddress("ab".repeat(32)), /tark/);
  assert.throws(() => parseWriterAddress("not an address"), /tark/);
  assert.equal(readAddress(), null);
  assert.equal(readPubkey(), null);
  assert.equal(saveAddress(`  ${ADDRESS.toUpperCase()}  `, "AB".repeat(32)), ADDRESS);
  assert.equal(readAddress(), ADDRESS);
  assert.equal(readPubkey(), "ab".repeat(32));
  assert.equal(saveAddress(ADDRESS), ADDRESS);
  assert.equal(readPubkey(), null);
  clearAddress();
  assert.equal(readAddress(), null);
  assert.equal(readPubkey(), null);
  assert.throws(() => parseWriterAddress(ADDRESS, "ark", "Bitcoin"), /Bitcoin.*ark/);
});

test("wallet connect signer pubkey verifies against DefaultVtxo and binds identical contracts across page and desk", async () => {
  const userKey = await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey();
  const wrongKey = await SingleKey.fromHex("33".repeat(32)).xOnlyPublicKey();
  const serverKey = await SingleKey.fromHex("22".repeat(32)).xOnlyPublicKey();
  const deskKey = await SingleKey.fromHex("44".repeat(32)).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex("55".repeat(32)).compressedPublicKey();
  const script = payoutVtxo(userKey, serverKey, EXIT);
  const address = script.address("tark", serverKey).encode();

  const verified = verifiedSignerKey(address, bytesToHex(userKey), serverKey, EXIT);
  assert.ok(verified);
  assert.equal(bytesToHex(verified), bytesToHex(userKey));
  assert.equal(verifiedSignerKey(address, bytesToHex(wrongKey), serverKey, EXIT), undefined);
  assert.equal(verifiedSignerKey(address, undefined, serverKey, EXIT), undefined);

  const pkScriptHex = bytesToHex(script.pkScript);
  assert.equal(directPayoutKey(bytesToHex(verified), pkScriptHex), undefined);
  const oracleKey = await SingleKey.fromHex("66".repeat(32)).xOnlyPublicKey();
  const shared = {
    kind: 2,
    strike: 6_000_000n,
    collateral: 95_000n,
    premium: 50_000n,
    expiry: 1_800_000_300n,
    deadline: 1_800_000_060n,
    exit: EXIT,
    writerPk: deskKey,
    holderPk: verified,
    oraclePk: oracleKey,
    serverKey,
    emulatorKey,
  };
  const pageBound = bindContracts(shared);
  const deskBound = bindContracts({ ...shared, holderPayoutKey: directPayoutKey(bytesToHex(verified), pkScriptHex) });
  assert.equal(pageBound.intentAddress, deskBound.intentAddress);
  assert.equal(pageBound.vaultAddress, deskBound.vaultAddress);
  assert.equal(bytesToHex(pageBound.intent.userPk), bytesToHex(userKey));
  assert.equal(bytesToHex(pageBound.vault.holderPk), bytesToHex(userKey));
  assert.equal(bytesToHex(pageBound.holderPkScript), pkScriptHex);
});
