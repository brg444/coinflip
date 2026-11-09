import assert from "node:assert/strict";
import test from "node:test";

import {
  CSVMultisigTapscript,
  Extension,
  SingleKey,
  Transaction,
  asset,
  buildOffchainTx,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";

import { beaconIdOf, bindBeacon, genesisState, nextState, priceValue } from "./beacon.ts";
import { BEACON_READ_FEE, DUST_SATS, EXIT } from "./constants.ts";
import { payoutVtxo } from "./contracts.ts";
import { buildSettle, statePacket, submit, type Coin } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { rawStandingVaultProgram, rawVaultProgram } from "./programs.ts";
import {
  STANDING_PARTY,
  bindHolderLeg,
  bindStandingVault,
  bindWriterLeg,
  buildStandingMatch,
  type StandingTerms,
} from "./standing.ts";

const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const checkpoint = CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT));
const collateral = 20_000n;
const premium = 1_000n;

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

async function terms(): Promise<StandingTerms> {
  const writer = key(1);
  const server = key(8);
  const emulator = key(9);
  return {
    kind: 0,
    strike: 9_700_000n,
    collateral,
    premium,
    expiry: 1_790_000_000n,
    deadline: 1_790_000_210n,
    exit: EXIT,
    writerPk: await writer.xOnlyPublicKey(),
    beacon: beaconIdOf(asset.AssetId.create("07".repeat(32), 0)),
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
}

async function funded(script: Uint8Array, amount: bigint): Promise<Coin> {
  const owner = payoutVtxo(await key(3).xOnlyPublicKey(), await key(8).xOnlyPublicKey(), EXIT);
  const { arkTx } = buildOffchainTx(
    [{
      txid: crypto.getRandomValues(new Uint8Array(32)),
      vout: 0,
      value: Number(amount),
      tapLeafScript: owner.forfeit(),
      tapTree: owner.encode(),
    }],
    [{ script, amount }],
    checkpoint,
  );
  return { txid: arkTx.id, vout: 0, value: Number(amount), prevTx: arkTx.toBytes(true, true) };
}

function spend(tx: Transaction) {
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    outputs.push({ amount: out?.amount ?? 0n, script: out?.script ? bytesToHex(out.script) : "" });
  }
  return outputs;
}

function opcodeCount(program: ReturnType<typeof rawVaultProgram>, name: string) {
  const asm = program.functions.settle?.arkadeScript?.asm ?? [];
  return asm.filter((token) => token === name).length;
}

test("the writer's offer does not name a holder", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const vault = bindStandingVault(shared);
  const first = await key(2).xOnlyPublicKey();
  const second = await key(4).xOnlyPublicKey();
  const one = bindHolderLeg(shared, first);
  const other = bindHolderLeg(shared, second);
  assert.equal(bytesToHex(writer.args["vaultProgram.program"] as Uint8Array), bytesToHex(vault.program));
  assert.equal(bytesToHex(one.args["vaultProgram.program"] as Uint8Array), bytesToHex(vault.program));
  assert.equal(bytesToHex(other.args["vaultProgram.program"] as Uint8Array), bytesToHex(vault.program));
  assert.equal(writer.address, bindWriterLeg(shared).address);
  assert.notEqual(one.address, other.address);
  assert.notEqual(one.address, writer.address);
  assert.equal(bytesToHex(one.args.userPk as Uint8Array), bytesToHex(first));
  assert.equal(bytesToHex(other.args.userPk as Uint8Array), bytesToHex(second));
  const writerFields = Object.values(writer.args).filter((value) => value instanceof Uint8Array).map((value) => bytesToHex(value));
  const vaultFields = Object.values(vault.args).filter((value) => value instanceof Uint8Array).map((value) => bytesToHex(value));
  assert.equal(writerFields.includes(bytesToHex(first)), false);
  assert.equal(vaultFields.includes(bytesToHex(first)), false);
  assert.equal(opcodeCount(rawStandingVaultProgram(), "MUL"), opcodeCount(rawVaultProgram(), "MUL"));
  assert.equal(opcodeCount(rawStandingVaultProgram(), "DIV"), opcodeCount(rawVaultProgram(), "DIV"));
  assert.equal(opcodeCount(rawVaultProgram(), "MUL"), 2);
  assert.equal(opcodeCount(rawVaultProgram(), "DIV"), 2);
});

test("a matcher spends the writer leg and a later holder leg", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holderPk = await key(2).xOnlyPublicKey();
  const holder = bindHolderLeg(shared, holderPk);
  const built = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium) },
    checkpoint,
  });
  assert.deepEqual(built.signIndexes, []);
  assert.equal(built.arkTx.inputsLength, 2);
  for (let vin = 0; vin < 2; vin++) {
    assert.equal((built.arkTx.getInput(vin).tapScriptSig ?? []).length, 0);
  }
  const paid = spend(built.arkTx);
  assert.equal(paid[0]?.amount, premium);
  assert.equal(paid[0]?.script, bytesToHex(programOf(writer.args["userScript.program"] as Uint8Array)));
  assert.equal(paid[1]?.amount, collateral);
  assert.equal(paid[1]?.script, bytesToHex(programOf(writer.args["vaultProgram.program"] as Uint8Array)));
  assert.equal(paid.length, 4);
  const extension = Extension.fromBytes(hexToBytes(paid[2]!.script));
  const party = extension.getPacketByType(STANDING_PARTY)!.serialize();
  assert.equal(party.length, 65);
  assert.equal(party[0], 1);
  assert.equal(bytesToHex(party.subarray(1, 33)), bytesToHex(holderPk));
  assert.equal(bytesToHex(party.subarray(33)), bytesToHex(holder.args["userScript.program"] as Uint8Array));
  const emulator = extension.getEmulatorPacket()!;
  assert.deepEqual(emulator.entries.map((entry) => entry.vin), [0, 1]);
  assert.equal(bytesToHex(emulator.entries[0]!.script), bytesToHex(writer.script.functionByName("fill")!.arkadeScript!));
  assert.equal(bytesToHex(emulator.entries[1]!.script), bytesToHex(holder.script.functionByName("fill")!.arkadeScript!));

  const sent = await submit(built, {
    async submitTx(arkTx: string, checkpoints: string[]) {
      assert.equal(checkpoints.length, 2);
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpoints };
    },
  });
  assert.equal(sent.txid, Transaction.fromPSBT(base64.decode(sent.signedArkTx)).id);
});

test("holder change above dust returns to the holder, and dust folds into the premium", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holder = bindHolderLeg(shared, await key(2).xOnlyPublicKey());
  const changed = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral + 500n) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium + DUST_SATS + 1n) },
    checkpoint,
  });
  const outputs = spend(changed.arkTx);
  assert.equal(outputs[0]?.amount, premium + 500n);
  assert.equal(outputs[2]?.amount, DUST_SATS + 1n);
  assert.equal(outputs[2]?.script, bytesToHex(programOf(holder.args["userScript.program"] as Uint8Array)));
  assert.equal(outputs.length, 5);

  const folded = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium + DUST_SATS) },
    checkpoint,
  });
  const dust = spend(folded.arkTx);
  assert.equal(dust[0]?.amount, premium + DUST_SATS);
  assert.equal(dust.length, 4);
});

test("standing vault settle pays the packet holder and the writer, and folds a dust leg", async () => {
  const split = await settleStanding(10_000_000n, 9_700_000n);
  assert.equal(holderPayoff(0, 10_000_000n, 9_700_000n, collateral), 600n);
  assert.equal(split.mode, "split");
  assert.deepEqual(paidLegs(split.tx), [
    [bytesToHex(split.holderScript), 600n],
    [bytesToHex(split.writerScript), 18_400n],
  ]);

  const toWriter = await settleStanding(10_000_000n, 9_840_000n);
  assert.equal(holderPayoff(0, 10_000_000n, 9_840_000n, collateral), 320n);
  assert.ok(320n <= DUST_SATS);
  assert.equal(toWriter.mode, "writer");
  assert.deepEqual(paidLegs(toWriter.tx), [[bytesToHex(toWriter.writerScript), collateral - BEACON_READ_FEE]]);

  const toHolder = await settleStanding(10_000_000n, 665_000n);
  const ph = holderPayoff(0, 10_000_000n, 665_000n, collateral);
  assert.equal(ph, 18_670n);
  assert.equal(collateral - BEACON_READ_FEE - ph, DUST_SATS);
  assert.equal(toHolder.mode, "holder");
  assert.deepEqual(paidLegs(toHolder.tx), [[bytesToHex(toHolder.holderScript), collateral - BEACON_READ_FEE]]);
});

test("a holder leg that pays the wrong writer is refused", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holderPk = await key(2).xOnlyPublicKey();
  const holder = bindHolderLeg(shared, holderPk);
  const coins = {
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium) },
    checkpoint,
  };
  const otherWriter = bindWriterLeg({ ...shared, writerPk: await key(5).xOnlyPublicKey() });
  const aimedElsewhere = bindHolderLeg({ ...shared, writerPk: await key(5).xOnlyPublicKey() }, holderPk);
  assert.throws(
    () => buildStandingMatch({ ...coins, holder: { script: aimedElsewhere.script, coin: coins.holder.coin } }),
    /different vaults|not paid to the writer/,
  );
  assert.notEqual(otherWriter.address, writer.address);

  const shortWriter = await funded(writer.pkScript, collateral - 1n);
  const shortHolder = await funded(holder.pkScript, premium - 1n);
  assert.throws(
    () => buildStandingMatch({ ...coins, writer: { script: writer.script, coin: shortWriter } }),
    /short of the collateral/,
  );
  assert.throws(
    () => buildStandingMatch({ ...coins, holder: { script: holder.script, coin: shortHolder } }),
    /short of the premium/,
  );
});

/** Fill the two legs, then spend the vault coin those legs created. */
async function settleStanding(price: bigint, strike: bigint) {
  const shared = { ...(await terms()), strike, readFee: BEACON_READ_FEE };
  const writer = bindWriterLeg(shared);
  const holder = bindHolderLeg(shared, await key(2).xOnlyPublicKey());
  const match = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium) },
    checkpoint,
  });
  const vault = bindStandingVault(shared);
  assert.equal(vault.args.readFee, BEACON_READ_FEE);
  assert.equal(bytesToHex(match.arkTx.getOutput(1)!.script!), bytesToHex(vault.pkScript));
  assert.equal(match.arkTx.getOutput(1)!.amount, collateral);
  const party = Extension.fromBytes(match.arkTx.getOutput(2)!.script!).getPacketByType(STANDING_PARTY)!.serialize();
  const holderProgram = holder.args["userScript.program"] as Uint8Array;
  assert.equal(bytesToHex(party.subarray(33)), bytesToHex(holderProgram));

  const beacon = bindBeacon({
    id: shared.beacon,
    signers: [shared.writerPk],
    threshold: 1n,
    domain: new TextEncoder().encode("BTCUSD-FIX"),
    expiryLag: 60n,
    readFee: BEACON_READ_FEE,
    adminPk: shared.writerPk,
    serverKey: shared.serverKey,
    emulatorKey: shared.emulatorKey,
  });
  const fixed = nextState(genesisState(), shared.expiry, priceValue(price, shared.expiry));
  const beaconTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  beaconTx.addInput({ txid: new Uint8Array(32), index: 1 });
  beaconTx.addOutput({ script: beacon.pkScript, amount: 330n });
  beaconTx.addOutput(Extension.create([statePacket(fixed)]).txOut());
  const ph = holderPayoff(0, price, strike, collateral);
  const split = settlementOutputs(ph, collateral, BEACON_READ_FEE);
  const holderScript = programOf(holderProgram);
  const writerScript = programOf(vault.args["writerScript.program"] as Uint8Array);
  const payouts = split.mode === "split"
    ? [
        { script: holderScript, amount: split.holder },
        { script: writerScript, amount: split.writer },
      ]
    : [{ script: split.mode === "holder" ? holderScript : writerScript, amount: split.mode === "holder" ? split.holder : split.writer }];
  const built = buildSettle({
    vault: {
      script: vault.script,
      coin: { txid: match.arkTx.id, vout: 1, value: collateral, prevTx: match.arkTx.toBytes(true, true) },
    },
    beacon: {
      script: beacon.script,
      coin: { txid: beaconTx.id, vout: 0, value: 330n, prevTx: beaconTx.toBytes(true, true) },
      state: fixed,
      id: asset.AssetId.create("07".repeat(32), 0),
    },
    readFee: BEACON_READ_FEE,
    payouts,
    checkpoint,
  });
  const tx = built.arkTx;
  assert.equal(tx.inputsLength, 2);
  const spentVault = built.checkpoints[0]!.getInput(0);
  assert.equal(spentVault.index, 1);
  assert.equal(bytesToHex(spentVault.txid!), match.arkTx.id);
  const extensionIndex = split.mode === "split" ? 3 : 2;
  const extension = Extension.fromBytes(tx.getOutput(extensionIndex)!.script!);
  const spent = extension.getEmulatorPacket()!.entries[0]!;
  assert.equal(bytesToHex(spent.script), bytesToHex(vault.script.functionByName("settle")!.arkadeScript!));
  assert.equal(tx.getOutput(0)!.amount, 330n + BEACON_READ_FEE);
  assert.equal(bytesToHex(tx.getOutput(0)!.script!), bytesToHex(beacon.pkScript));
  return { tx, mode: split.mode, holderScript, writerScript };
}

function paidLegs(tx: Transaction) {
  const legs = [];
  for (let i = 1; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)!;
    if (out.amount === 0n) break;
    legs.push([bytesToHex(out.script!), out.amount]);
  }
  return legs;
}

function programOf(program: Uint8Array): Uint8Array {
  const script = new Uint8Array(34);
  script[0] = 0x51;
  script[1] = 0x20;
  script.set(program, 2);
  return script;
}
