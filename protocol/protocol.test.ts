import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";
import { generateSecretKey } from "nostr-tools/pure";

import {
  EXIT,
  PAIR,
  POSITION_KIND,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VAULT_PROGRAM_ID,
  PREDICT_VOID_AFTER,
} from "./constants.ts";
import { bindContracts, directPayoutKey } from "./contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "./hex.ts";
import {
  parsePosition,
  parseWire,
  payoutRefusal,
  predictRefusal,
  requestRefusal,
  type OptionPosition,
  type RfqRequest,
} from "./messages.ts";
import {
  assertNetworkMatch,
  MAINNET_EXIT,
  MAINNET_FALLBACK_DELAY,
  MAINNET_FINAL_EXIT_DELAY,
  MAINNET_Q_MAX,
  MAINNET_STAKE_MAX,
  networkProfile,
} from "./network.ts";
import { nostrPubkey, openSealed, positionEvent, quoteRelay, readPosition, seal } from "./nostr.ts";

const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

async function sampleTerms() {
  const writer = key(1);
  const holder = key(2);
  const backup = key(3);
  const oracle = key(4);
  const server = key(8);
  const emulator = key(9);
  const holderPk = await holder.xOnlyPublicKey();
  return {
    kind: 2 as const,
    strike: 9_700_000n,
    collateral: 100_000n,
    premium: 50_000n,
    expiry: 1_790_000_100n,
    deadline: 1_790_000_000n,
    exit: EXIT,
    writerPk: await writer.xOnlyPublicKey(),
    holderPk,
    holderPayoutKey: holderPk,
    oraclePk: await oracle.xOnlyPublicKey(),
    backupPk: await backup.xOnlyPublicKey(),
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
}

test("hex is lowercase and a compressed key drops its prefix", () => {
  const bytes = Uint8Array.from([0x00, 0xff, 0x10]);
  assert.equal(bytesToHex(bytes), "00ff10");
  assert.deepEqual(hexToBytes("00FF10"), bytes);
  assert.throws(() => hexToBytes("zz"), /hex|letter/);
  const compressed = Uint8Array.from([0x03, ...new Uint8Array(32).fill(0x01)]);
  const only = xOnly(compressed);
  assert.equal(only.length, 32);
  assert.equal(only[0], 1);
  assert.equal(xOnly(only), only);
});

test("derived PredictVault and OptionIntent scripts stay pinned at EXIT=2048", async () => {
  const terms = await sampleTerms();
  const higher = bindContracts(terms);
  const lower = bindContracts({ ...terms, kind: 3 });

  assert.equal(bytesToHex(higher.writerPkScript), "51200f9cab3dda6d21f7bd8b7911351bce3c9f5add512fbfbf2274f0f913f613b7fa");
  assert.equal(bytesToHex(higher.holderPkScript), "5120c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
  assert.equal(bytesToHex(higher.vaultPkScript), "51207080739b0da2e1988fabe0d1154f587c2d9b8fdcd8715a56353886612bf852f4");
  assert.equal(bytesToHex(higher.intentPkScript), "5120d824e6af40acd5bc5d08a1beb67791d963c5d5c76c067c9d76c9a0484353a956");
  assert.equal(bytesToHex(lower.vaultPkScript), "512079343dc80acbcf969871961b1bd516a75f763d0512bb563773770d8114187703");
  assert.ok(higher.intentAddress.startsWith("tark1"));
  assert.ok(higher.vaultAddress.startsWith("tark1"));
  assert.deepEqual(bindContracts(terms).intentPkScript, higher.intentPkScript);
  assert.notEqual(higher.vaultAddress, lower.vaultAddress);
  assert.notEqual(higher.intentAddress, lower.intentAddress);
});

test("a vtxo script is not treated as a pasted address, while a raw taproot key is", async () => {
  const terms = await sampleTerms();
  const bound = bindContracts(terms);
  assert.equal(directPayoutKey(bytesToHex(terms.writerPk), bytesToHex(bound.writerPkScript)), undefined);
  assert.deepEqual(directPayoutKey(bytesToHex(terms.holderPk), bytesToHex(bound.holderPkScript)), terms.holderPk);

  const direct = bindContracts({ ...terms, payoutKey: terms.writerPk });
  assert.equal(bytesToHex(direct.writerPkScript), `5120${bytesToHex(terms.writerPk)}`);
  assert.equal(bytesToHex(direct.writerProgram), bytesToHex(terms.writerPk));
  assert.notEqual(direct.intentAddress, bound.intentAddress);
});

test("quotes use nostr.arkade.sh", () => {
  assert.equal(quoteRelay(["wss://relay.damus.io", "wss://nostr.arkade.sh/"]), "wss://nostr.arkade.sh");
  assert.equal(quoteRelay(["wss://nostr.arkade.sh"]), "wss://nostr.arkade.sh");
});

test("the desk nostr key is the arkade x-only key", async () => {
  const secret = key(1);
  const raw = Uint8Array.from(Buffer.from(secret.toHex(), "hex"));
  assert.equal(nostrPubkey(raw), bytesToHex(await secret.xOnlyPublicKey()));
});

test("NIP-44 seals a Predict RFQ request to the recipient only", () => {
  const desk = generateSecretKey();
  const client = generateSecretKey();
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: PAIR,
    amount_side: "from",
    amount: "50000",
    profile: {
      kind: 2,
      strike: 9_700_000,
      expiry: 1_790_000_100,
      holder_pubkey: "ab".repeat(32),
      holder_pk_script: "5120" + "cd".repeat(32),
    },
  };
  const event = seal(client, nostrPubkey(desk), request, 1_790_000_000);
  assert.equal(event.kind, 24859);
  assert.deepEqual(event.tags, [["p", nostrPubkey(desk)]]);
  assert.deepEqual(openSealed(desk, event), request);
  assert.equal(openSealed(client, event), null);
});

test("a filled Predict vault is public on nostr and rejects tampering or third-party signers", () => {
  const desk = generateSecretKey();
  const bettor = generateSecretKey();
  const stranger = generateSecretKey();
  const position: OptionPosition = {
    v: 1,
    type: "option_position",
    program_id: PREDICT_VAULT_PROGRAM_ID,
    rfq_id: "11".repeat(32),
    pair: PAIR,
    kind: 2,
    collateral: "95000",
    strike: "9700000",
    expiry: 1_790_000_100,
    exit: Number(EXIT),
    writer_pubkey: nostrPubkey(desk),
    writer_pk_script: "5120" + "cd".repeat(32),
    holder_pubkey: nostrPubkey(bettor),
    holder_pk_script: "5120" + "ef".repeat(32),
    stake: "50000",
    oracle_pubkey: "44".repeat(32),
    backup_pubkey: "33".repeat(32),
    void_after: Number(PREDICT_VOID_AFTER),
    fallback_delay: Number(PREDICT_FALLBACK_DELAY),
    final_exit_delay: Number(PREDICT_FINAL_EXIT_DELAY),
    vault_address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qg",
    fill_txid: "ee".repeat(32),
  };

  const deskEvent = positionEvent(desk, position, 1_790_000_000);
  assert.equal(deskEvent.kind, POSITION_KIND);
  assert.deepEqual(readPosition(deskEvent), position);
  assert.equal(openSealed(generateSecretKey(), deskEvent), null);

  const bettorEvent = positionEvent(bettor, position, 1_790_000_000);
  assert.deepEqual(readPosition(bettorEvent), position);

  const tampered = {
    id: deskEvent.id,
    pubkey: deskEvent.pubkey,
    created_at: deskEvent.created_at,
    kind: deskEvent.kind,
    tags: deskEvent.tags,
    content: deskEvent.content.replace(position.fill_txid, "ff".repeat(32)),
    sig: deskEvent.sig,
  };
  assert.equal(readPosition(tampered), null);

  const strangerEvent = positionEvent(stranger, position, 1_790_000_000);
  assert.equal(readPosition(strangerEvent), null);
  assert.equal(parsePosition({ ...position, type: "rfq_quote" }), null);
  assert.equal(parsePosition({ ...position, kind: 0 }), null);
  assert.equal(parsePosition({ ...position, oracle_pubkey: "" }), null);
});

test("wire validation drops legacy kinds, wrong pairs, and malformed amounts", () => {
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: PAIR,
    amount_side: "from",
    amount: "50000",
    profile: {
      kind: 2,
      strike: 9_700_000,
      expiry: 1_790_000_100,
      holder_pubkey: "ab".repeat(32),
      holder_pk_script: "5120" + "cd".repeat(32),
    },
  };
  assert.deepEqual(parseWire(request), request);
  assert.equal(parseWire({ ...request, pair: "arkade:BTC->arkade:BTC" }), null);
  assert.equal(parseWire({ ...request, amount: "0001" }), null);
  assert.equal(parseWire({ ...request, profile: { ...request.profile, kind: 0 } }), null);
  assert.equal(parseWire({ ...request, profile: { ...request.profile, kind: 1 } }), null);
  assert.equal(requestRefusal(request, 1_790_000_100), "expiry");
  assert.equal(requestRefusal(request, 1_790_000_000), "");
  assert.equal(requestRefusal(request, 1_790_000_041), "expiry");
});

test("Bitcoin mainnet network profile derives ark1 addresses with 7-day exit and conservative launch limits", async () => {
  const main = networkProfile("bitcoin");
  assert.equal(main.id, "bitcoin");
  assert.equal(main.isMainnet, true);
  assert.equal(main.hrp, "ark");
  assert.equal(main.exit, MAINNET_EXIT);
  assert.equal(main.fallbackDelay, MAINNET_FALLBACK_DELAY);
  assert.equal(main.finalExitDelay, MAINNET_FINAL_EXIT_DELAY);
  assert.equal(main.qMax, MAINNET_Q_MAX);
  assert.equal(main.stakeMax, MAINNET_STAKE_MAX);
  assert.equal(networkProfile("mainnet").id, "bitcoin");
  assert.equal(assertNetworkMatch("bitcoin", "bitcoin").id, "bitcoin");
  assert.throws(() => assertNetworkMatch("bitcoin", "mutinynet"), /does not match/);

  const writerPk = await key(1).xOnlyPublicKey();
  const holderPk = await key(2).xOnlyPublicKey();
  const backupPk = await key(3).xOnlyPublicKey();
  const oraclePk = await key(4).xOnlyPublicKey();
  const serverKey = await key(8).xOnlyPublicKey();
  const emulatorKey = await key(9).compressedPublicKey();
  const bound = bindContracts({
    kind: 2,
    strike: 10_000_000n,
    collateral: 190_000n,
    premium: 100_000n,
    expiry: 1_800_000_300n,
    deadline: 1_800_000_060n,
    exit: main.exit,
    voidAfter: main.voidAfter,
    fallbackDelay: main.fallbackDelay,
    finalExitDelay: main.finalExitDelay,
    backupPk,
    writerPk,
    holderPk,
    oraclePk,
    serverKey,
    emulatorKey,
    hrp: main.hrp,
  });
  assert.ok(bound.intentAddress.startsWith("ark1"));
  assert.ok(bound.vaultAddress.startsWith("ark1"));

  const now = 1_800_000_000;
  assert.equal(predictRefusal(now + 300, 100_000n, now, { stakeMax: main.stakeMax, qMax: main.qMax }), "");
  assert.equal(predictRefusal(now + 300, 100_001n, now, { stakeMax: main.stakeMax, qMax: main.qMax }), "stake");
  assert.equal(payoutRefusal(50_000_001n, 100_000n, main.qMax), "payout");
  assert.equal(payoutRefusal(100_001n, 100_000n, main.qMax), "");
  assert.equal(payoutRefusal(100_000n, 100_000n, main.qMax), "payout");
});
