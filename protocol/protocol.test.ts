import assert from "node:assert/strict";
import test from "node:test";

import { asset, SingleKey } from "@arkade-os/sdk";
import { generateSecretKey } from "nostr-tools/pure";

import { beaconIdOf, bindBeacon } from "./beacon.ts";
import { BEACON_READ_FEE, EXIT, OPTION_VAULT_PROGRAM_ID, PAIR, POSITION_KIND } from "./constants.ts";
import { bindContracts, directPayoutKey } from "./contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "./hex.ts";
import { beaconWindowRefusal, parsePosition, parseWire, premiumRefusal, requestRefusal, type OptionPosition, type RfqRequest } from "./messages.ts";
import { nostrPubkey, openSealed, positionEvent, quoteRelay, readPosition, seal } from "./nostr.ts";
import { payablePremium, premiumSats, quotedPremium } from "./pricing.ts";

const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

async function sampleTerms() {
  const writer = key(1);
  const holder = key(2);
  const server = key(8);
  const emulator = key(9);
  return {
    kind: 0 as const,
    strike: 9_700_000n,
    collateral: 10_000_000n,
    premium: 235_647n,
    expiry: 1_790_000_000n,
    deadline: 1_790_000_210n,
    exit: 512n,
    writerPk: await writer.xOnlyPublicKey(),
    holderPk: await holder.xOnlyPublicKey(),
    beacon: beaconIdOf(asset.AssetId.create("07".repeat(32), 0)),
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

test("derived intent and vault addresses stay pinned", async () => {
  const terms = await sampleTerms();
  const bound = bindContracts(terms);
  assert.equal(
    bound.intentAddress,
    "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qzweca6vgu82rs9k2eue2upuz2pv07f6fftatpf795pzvcfrhprxz4szxe4",
  );
  assert.equal(
    bound.vaultAddress,
    "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrls8jcf3cehkrdldzu3qxnp2tfknjaph80z7ytzk2dvtq0y3t02znwnx0j",
  );
  assert.equal(bytesToHex(bound.writerPkScript), "51203d002da23716b1975b89b46563d89040a3c71d017593934bfb751b68a7cae991");
  assert.deepEqual(bindContracts(terms).intentPkScript, bound.intentPkScript);
});

test("a vtxo script is not treated as a pasted address", async () => {
  const terms = await sampleTerms();
  const bound = bindContracts(terms);
  assert.equal(directPayoutKey(bytesToHex(terms.writerPk), bytesToHex(bound.writerPkScript)), undefined);
});

test("a pasted address is paid at its taproot key", async () => {
  const terms = await sampleTerms();
  const direct = bindContracts({ ...terms, payoutKey: terms.writerPk });
  assert.equal(bytesToHex(direct.writerPkScript), `5120${bytesToHex(terms.writerPk)}`);
  assert.equal(bytesToHex(direct.writerProgram), bytesToHex(terms.writerPk));
  assert.notEqual(direct.intentAddress, bindContracts(terms).intentAddress);
});

test("a premium at or below 330 sats is a refusal", () => {
  assert.equal(premiumRefusal(330n), "premium below dust");
  assert.equal(premiumRefusal(331n), "");
  assert.equal(payablePremium(0n), 331n);
  assert.equal(payablePremium(330n), 331n);
  assert.equal(payablePremium(331n), 331n);
  assert.equal(payablePremium(1_158n), 1_158n);
  const now = 1_700_000_000;
  assert.equal(quotedPremium(0n, now + 600, now), 1_001n);
  assert.equal(quotedPremium(398n, now + 600, now), 1_001n);
  assert.equal(quotedPremium(1_000n, now + 600, now), 1_001n);
  assert.equal(quotedPremium(1_001n, now + 600, now), 1_001n);
  assert.equal(quotedPremium(2_000n, now + 600, now), 2_000n);
  assert.equal(premiumRefusal(quotedPremium(398n, now + 600, now), 200_000n), "");
  assert.equal(premiumRefusal(quotedPremium(1_990n, now + 600, now), 1_000_000n), "");
  assert.equal(quotedPremium(2_000n, now + 7 * 86_400, now), 2_000n);
  assert.equal(quotedPremium(100n, now + 7 * 86_400, now), 331n);
  assert.equal(premiumRefusal(10_000n, 10_000n), "premium");
  assert.equal(premiumRefusal(9_999n, 10_000n), "");
  const priced = premiumSats({
    kind: 0,
    spotCents: 10_000_000,
    strikeCents: 11_000_000,
    years: 30 / 365,
    collateralSats: 10_000_000n,
    vol: 0.55,
  });
  assert.equal(priced.sats > 330n, true);
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

test("NIP-44 seals a quote to the recipient only", () => {
  const desk = generateSecretKey();
  const client = generateSecretKey();
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: "arkade:BTC->arkade:BTC-OPTION",
    amount_side: "from",
    amount: "10000000",
    profile: {
      kind: 0,
      strike: 9_700_000,
      expiry: 1_790_000_000,
      writer_pubkey: "ab".repeat(32),
      writer_pk_script: "5120" + "cd".repeat(32),
    },
  };
  const event = seal(client, nostrPubkey(desk), request, 1_790_000_000);
  assert.equal(event.kind, 24859);
  assert.deepEqual(event.tags, [["p", nostrPubkey(desk)]]);
  assert.deepEqual(openSealed(desk, event), request);
  assert.equal(openSealed(client, event), null);
});

test("a filled vault is public on nostr and a sealed quote is not", () => {
  const desk = generateSecretKey();
  const position: OptionPosition = {
    v: 1,
    type: "option_position",
    program_id: OPTION_VAULT_PROGRAM_ID,
    rfq_id: "11".repeat(32),
    pair: PAIR,
    kind: 0,
    collateral: "10000000",
    strike: "9700000",
    expiry: 1_790_000_000,
    exit: 2048,
    writer_pubkey: "ab".repeat(32),
    writer_pk_script: "5120" + "cd".repeat(32),
    holder_pubkey: nostrPubkey(desk),
    beacon_txid: "07".repeat(32),
    beacon_gidx: 0,
    vault_address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qg",
    fill_txid: "ee".repeat(32),
  };
  const event = positionEvent(desk, position, 1_790_000_000);
  assert.equal(event.kind, POSITION_KIND);
  assert.deepEqual(readPosition(event), position);
  const { program_id: _programId, ...legacyBody } = position;
  const legacy = readPosition(positionEvent(desk, legacyBody as OptionPosition, 1_790_000_000));
  assert.equal(legacy?.program_id, OPTION_VAULT_PROGRAM_ID);
  assert.equal(legacy?.holder_pubkey, position.holder_pubkey);
  assert.equal(openSealed(generateSecretKey(), event), null);
  const tampered = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content.replace(position.fill_txid, "ff".repeat(32)),
    sig: event.sig,
  };
  assert.equal(readPosition(tampered), null);
  const writerKey = generateSecretKey();
  const writerSigned: OptionPosition = { ...position, writer_pubkey: nostrPubkey(writerKey) };
  assert.deepEqual(readPosition(positionEvent(writerKey, writerSigned, 1_790_000_000)), writerSigned);
  const quoted = { ...position, holder_pubkey: "ff".repeat(32) };
  const mismatched = positionEvent(desk, quoted, 1_790_000_000);
  assert.equal(readPosition(mismatched), null);
  assert.equal(parsePosition({ ...position, type: "rfq_quote" }), null);
});

test("a wire message with the wrong pair is dropped", () => {
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: "arkade:BTC->arkade:BTC-OPTION",
    amount_side: "from",
    amount: "10000000",
    profile: {
      kind: 0,
      strike: 9_700_000,
      expiry: 1_790_000_000,
      writer_pubkey: "ab".repeat(32),
      writer_pk_script: "5120" + "cd".repeat(32),
    },
  };
  assert.deepEqual(parseWire(request), request);
  assert.equal(parseWire({ ...request, pair: "arkade:BTC->arkade:BTC" }), null);
  assert.equal(parseWire({ ...request, amount: "0001" }), null);
  assert.equal(beaconWindowRefusal(60n), "");
  assert.equal(beaconWindowRefusal(120n), "expiry lag");
  assert.equal(beaconWindowRefusal(0n), "expiry lag");
  assert.equal(beaconWindowRefusal(null), "oracle");
  assert.equal(requestRefusal(request, 1_790_000_000), "expiry");
  assert.equal(requestRefusal({ ...request, profile: { ...request.profile, expiry: 1_790_000_700 } }, 1_790_000_000), "");
  assert.equal(requestRefusal({ ...request, profile: { ...request.profile, expiry: 1_790_000_600 } }, 1_790_000_000), "expiry");
  assert.equal(requestRefusal({ ...request, profile: { ...request.profile, expiry: 1_790_000_060 } }, 1_790_000_000), "expiry");
  assert.equal(requestRefusal({ ...request, profile: { ...request.profile, expiry: 1_800_000_000 } }, 1_700_000_000), "");
});

test("addresses and unilateral tapscript bytes stay identical at EXIT=2048", async () => {
  const writerPk = await key(1).xOnlyPublicKey();
  const holderPk = await key(2).xOnlyPublicKey();
  const oraclePk = await key(3).xOnlyPublicKey();
  const serverKey = await key(8).xOnlyPublicKey();
  const emulatorKey = await key(9).compressedPublicKey();
  const beacon = beaconIdOf(asset.AssetId.create("07".repeat(32), 0));
  const common = {
    strike: 9_700_000n,
    collateral: 100_000n,
    premium: 20_000n,
    expiry: 1_790_000_100n,
    deadline: 1_790_000_000n,
    exit: EXIT,
    writerPk,
    holderPk,
    beacon,
    oraclePk,
    readFee: BEACON_READ_FEE,
    serverKey,
    emulatorKey,
  };
  const call = bindContracts({ ...common, kind: 0 });
  const put = bindContracts({ ...common, kind: 1 });
  const higher = bindContracts({ ...common, kind: 2, readFee: 0n });
  const lower = bindContracts({ ...common, kind: 3, readFee: 0n });
  assert.equal(call.intentAddress, "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qzu2qvg9lr9kgk2mndht7yup40vgswzgsz7ggxwgksq5lky9ts643l6a3m6");
  assert.equal(call.vaultAddress, "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrdm35e6fry9e8qt2xnrr34lt3hfh7vr7n7p5zdr52g3g04hk23dy9766w4");
  assert.equal(put.intentAddress, "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrxna9s74zq3kvfwkvdms3hqd8mmdfnrj93ec93akm8mull0j06y23fwgrz");
  assert.equal(put.vaultAddress, "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qzxssap5m5k74dhu7qazfl5u46t9xdtzdpqqy0kan7nk7wqgmx3pn0g5938");
  assert.ok(higher.intentAddress.startsWith("tark1"));
  assert.ok(higher.vaultAddress.startsWith("tark1"));
  assert.ok(lower.intentAddress.startsWith("tark1"));
  assert.ok(lower.vaultAddress.startsWith("tark1"));
  assert.notEqual(higher.vaultAddress, lower.vaultAddress);
  assert.notEqual(higher.intentAddress, lower.intentAddress);
  const bcn = bindBeacon({
    id: beacon,
    domain: new TextEncoder().encode("BTCUSD-FIX"),
    expiryLag: 60n,
    readFee: BEACON_READ_FEE,
    adminPk: writerPk,
    exit: EXIT,
    serverKey,
    emulatorKey,
  });
  assert.equal(bcn.address, "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qz8s7647wwk2qk4z0dmng6xvkhmsx3rcelwd7h0tj9gmr4lc0ux4wg03fce");
  assert.equal(
    bytesToHex(bcn.script.functionByName("unilateral")!.tapLeafScript[1]),
    "03040040b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798acc0",
  );
});

test("Bitcoin mainnet network profile derives ark1 addresses with 7-day exit and conservative launch limits", async () => {
  const { assertNetworkMatch, MAINNET_EXIT, MAINNET_FALLBACK_DELAY, MAINNET_FINAL_EXIT_DELAY, MAINNET_Q_MAX, MAINNET_STAKE_MAX, networkProfile } = await import("./network.ts");
  const { parseOracleBeacon } = await import("../settle/oracle.ts");
  const { predictRefusal, payoutRefusal } = await import("./messages.ts");

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
  const assetId = asset.AssetId.create("ab".repeat(32), 0);
  const beacon = beaconIdOf(assetId);
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
    readFee: 0n,
    serverKey,
    emulatorKey,
    hrp: main.hrp,
  });
  assert.ok(bound.intentAddress.startsWith("ark1"));
  assert.ok(bound.vaultAddress.startsWith("ark1"));

  const bcn = bindBeacon({
    id: beacon,
    domain: new TextEncoder().encode("BTCUSD-FIX"),
    expiryLag: 60n,
    readFee: BEACON_READ_FEE,
    adminPk: writerPk,
    exit: main.exit,
    hrp: main.hrp,
    serverKey,
    emulatorKey,
  });
  assert.ok(bcn.address.startsWith("ark1"));
  const status = {
    assetId: assetId.toString(),
    issueTxid: "ab".repeat(32),
    address: bcn.address,
    args: {
      ctrlTxid: bytesToHex(beacon.txid),
      domain: bytesToHex(new TextEncoder().encode("BTCUSD-FIX")),
      expiryLag: 60,
      readFee: Number(BEACON_READ_FEE),
      adminPk: bytesToHex(writerPk),
      exit: Number(main.exit),
    },
  };
  assert.equal(parseOracleBeacon(status, "ab".repeat(32), 0, "ark").ok, true);
  assert.equal(parseOracleBeacon(status, "ab".repeat(32), 0, "tark").ok, false);

  const now = 1_800_000_000;
  assert.equal(predictRefusal(now + 300, 100_000n, now, { stakeMax: main.stakeMax, qMax: main.qMax }), "");
  assert.equal(predictRefusal(now + 300, 100_001n, now, { stakeMax: main.stakeMax, qMax: main.qMax }), "stake");
  assert.equal(payoutRefusal(50_000_001n, 100_000n, BEACON_READ_FEE, main.qMax), "payout");
});
