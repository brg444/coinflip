import {
  arkade,
  asset,
  Batch,
  buildOffchainTx,
  ConditionWitness,
  EmulatorPacket,
  Extension,
  P2A,
  PrevArkTxField,
  Proof,
  setArkPsbtField,
  Transaction,
  TreeSignerSession,
  UnknownPacket,
  type ArkProvider,
  type ArkTxInput,
  type CSVMultisigTapscript,
  type EmulatorProvider,
  type ExtensionPacket,
  type Identity,
  type Network,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { internalTxid, reseedState, STATE_TYPE } from "./beacon.ts";
import { DUST_SATS } from "./constants.ts";
import { bytesToHex } from "./hex.ts";

/**
 * Arkade transactions with more than one covenant input.
 *
 * The SDK's ArkadeTransactionBuilder spends one covenant coin plus coins the
 * identity signs. A beacon read spends two covenants: the consumer at input 0
 * and the beacon at input 1, each with its own emulator entry. This module
 * assembles that shape from the SDK's primitives: one checkpoint per input
 * through buildOffchainTx, the previous Arkade transaction on every input,
 * and one extension output carrying the asset packet, the beacon state, and
 * the emulator packet, ahead of the anchor.
 */

type ProgramScript = InstanceType<typeof arkade.ArkadeProgramScript>;

export type Coin = { txid: string; vout: number; value: number | bigint; prevTx: Uint8Array };

export type CovenantSpend = {
  script: ProgramScript;
  fn: string;
  callArgs?: Record<string, bigint | Uint8Array>;
  coin: Coin;
};

/** A coin the identity signs: a DefaultVtxo or any script with a forfeit leaf. */
export type SignedSpend = {
  coin: Coin;
  tapLeafScript: ArkTxInput["tapLeafScript"];
  tapTree: Uint8Array;
};

export type Spend = CovenantSpend | SignedSpend;

export type Built = {
  arkTx: Transaction;
  checkpoints: Transaction[];
  /** Inputs the identity has to sign. */
  signIndexes: number[];
};

function isCovenant(spend: Spend): spend is CovenantSpend {
  return "script" in spend;
}

/** The witness stack as the emulator packet carries it, compact-size framed like a condition witness. */
export function encodeWitness(items: Uint8Array[]): Uint8Array {
  return ConditionWitness.encode(items)[1];
}

function anchorIndex(tx: Transaction): number {
  for (let i = tx.outputsLength - 1; i >= 0; i--) {
    const script = tx.getOutput(i)?.script;
    if (script && bytesToHex(script) === bytesToHex(P2A.script)) return i;
  }
  throw new Error("anchor output missing");
}

/** Insert the extension ahead of the anchor, as the SDK's builder does. */
function attachExtension(tx: Transaction, packets: ExtensionPacket[]) {
  const out = Extension.create(packets).txOut();
  const anchor = anchorIndex(tx);
  const last = tx.getOutput(anchor);
  tx.updateOutput(anchor, { script: out.script, amount: out.amount });
  tx.addOutput({ script: last!.script!, amount: last!.amount ?? 0n });
}

export function build(spends: Spend[], outputs: { script: Uint8Array; amount: bigint }[], packets: ExtensionPacket[], checkpoint: CSVMultisigTapscript.Type): Built {
  const inputs: ArkTxInput[] = [];
  const entries: { vin: number; script: Uint8Array; witness: Uint8Array }[] = [];
  const conditions = new Map<number, Uint8Array[]>();
  const signIndexes: number[] = [];
  spends.forEach((spend, vin) => {
    if (!isCovenant(spend)) {
      inputs.push({ txid: spend.coin.txid, vout: spend.coin.vout, value: Number(spend.coin.value), tapLeafScript: spend.tapLeafScript, tapTree: spend.tapTree });
      signIndexes.push(vin);
      return;
    }
    const fn = spend.script.functionByName(spend.fn);
    if (!fn) throw new Error(`${spend.script.program.name}.${spend.fn} not found`);
    if (!fn.arkadeScript) throw new Error(`${spend.fn} is not a covenant`);
    const callArgs = spend.callArgs ?? {};
    const stack = (fn.def.arkadeScript?.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, spend.script.args));
    const condition = (fn.def.tapscript.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, spend.script.args));
    inputs.push({ txid: spend.coin.txid, vout: spend.coin.vout, value: Number(spend.coin.value), tapLeafScript: fn.tapLeafScript, tapTree: spend.script.encode() });
    entries.push({ vin, script: fn.arkadeScript, witness: encodeWitness(stack) });
    if (condition.length > 0) conditions.set(vin, condition);
  });
  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, checkpoint);
  spends.forEach((spend, vin) => {
    setArkPsbtField(arkTx, vin, PrevArkTxField, spend.coin.prevTx);
    const condition = conditions.get(vin);
    if (condition) {
      setArkPsbtField(arkTx, vin, ConditionWitness, condition);
      setArkPsbtField(checkpoints[vin]!, 0, ConditionWitness, condition);
    }
  });
  attachExtension(arkTx, [...packets, EmulatorPacket.create(entries)]);
  return { arkTx, checkpoints, signIndexes };
}

function unitTransfer(id: asset.AssetId, vin: number, vout: number): asset.Packet {
  return asset.Packet.create([
    asset.AssetGroup.create(id, null, [asset.AssetInput.create(vin, 1n)], [asset.AssetOutput.create(vout, 1n)], []),
  ]);
}

export function statePacket(state: Uint8Array): ExtensionPacket {
  return new UnknownPacket(STATE_TYPE, state);
}

export type BeaconCoin = {
  script: ProgramScript;
  coin: Coin;
  /** The state packet of the transaction that created the coin. */
  state: Uint8Array;
  id: asset.AssetId;
};

/**
 * Settle a beacon vault: the vault at input 0, the beacon at input 1 through
 * `read`. Output 0 continues the beacon plus `readFee`. The payouts are the
 * vault's locked value minus that fee. No extra coin.
 */
export function buildSettle(input: {
  vault: { script: ProgramScript; coin: Coin };
  beacon: BeaconCoin;
  readFee: bigint;
  payouts: { script: Uint8Array; amount: bigint }[];
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  const spends: Spend[] = [
    { script: input.vault.script, fn: "settle", coin: input.vault.coin },
    { script: input.beacon.script, fn: "read", callArgs: { selfIndex: 1n }, coin: input.beacon.coin },
  ];
  const outputs = [
    { script: input.beacon.script.pkScript, amount: BigInt(input.beacon.coin.value) + input.readFee },
    ...input.payouts,
  ];
  return build(spends, outputs, [unitTransfer(input.beacon.id, 1, 0), statePacket(input.beacon.state)], input.checkpoint);
}

export function refundOutputs(
  locked: bigint,
  stake: bigint,
  holderScript: Uint8Array,
  writerScript: Uint8Array,
): { script: Uint8Array; amount: bigint }[] {
  if (stake <= DUST_SATS) throw new Error("stake must exceed dust");
  if (locked < stake) throw new Error("vault underfunded for stake refund");
  const house = locked - stake;
  if (house > DUST_SATS) {
    return [
      { script: holderScript, amount: stake },
      { script: writerScript, amount: house },
    ];
  }
  return [{ script: holderScript, amount: locked }];
}

export function buildRefund(input: {
  vault: { script: ProgramScript; coin: Coin };
  stake: bigint;
  holderScript: Uint8Array;
  writerScript: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  const outputs = refundOutputs(BigInt(input.vault.coin.value), input.stake, input.holderScript, input.writerScript);
  return build([{ script: input.vault.script, fn: "refund", coin: input.vault.coin }], outputs, [], input.checkpoint);
}

/** Publish a fixing: the beacon at input 0, continued at output 0 with the next state. */
export function buildAttest(input: {
  beacon: BeaconCoin;
  /** Option expiry. The slot key. */
  expiry: bigint;
  /** DIA price, 18 decimals. */
  price: bigint;
  /** DIA timestamp. */
  time: bigint;
  nonce: bigint;
  intentExpiry: bigint;
  /** 64-byte r||s of the DIA signature. */
  sig: Uint8Array;
  /** 64-byte BIP340 Schnorr signature from `adminPk` over `attestDigest`. */
  adminSig: Uint8Array;
  next: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  if (input.sig.length !== 64) throw new Error("dia signature");
  if (input.adminSig.length !== 64) throw new Error("admin signature");
  const callArgs: Record<string, bigint | Uint8Array> = {
    expiry: input.expiry,
    price: input.price,
    time: input.time,
    nonce: input.nonce,
    intentExpiry: input.intentExpiry,
    sig: input.sig,
    adminSig: input.adminSig,
  };
  return build(
    [{
      script: input.beacon.script,
      fn: "attest",
      callArgs,
      coin: input.beacon.coin,
    }],
    [{ script: input.beacon.script.pkScript, amount: BigInt(input.beacon.coin.value) }],
    [unitTransfer(input.beacon.id, 0, 0), statePacket(input.next)],
    input.checkpoint,
  );
}

/** Migrate the beacon coin to a new Taproot script while preserving its identity asset and state packet. */
export function buildMigrate(input: {
  beacon: BeaconCoin;
  nextProgram: Uint8Array;
  nextPkScript: Uint8Array;
  opSig: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  if (input.nextProgram.length !== 32) throw new Error("nextProgram must be 32 bytes");
  if (input.opSig.length !== 64) throw new Error("op signature");
  return build(
    [{
      script: input.beacon.script,
      fn: "migrate",
      callArgs: {
        "next.program": input.nextProgram,
        "next.version": 1n,
        opSig: input.opSig,
      },
      coin: input.beacon.coin,
    }],
    [{ script: input.nextPkScript, amount: BigInt(input.beacon.coin.value) }],
    [unitTransfer(input.beacon.id, 0, 0), statePacket(input.beacon.state)],
    input.checkpoint,
  );
}

/**
 * Restore the 329-byte STATE packet on a freshly batch-renewed beacon VTXO that lacks STATE.
 * `sign` receives the checkpoint outpoint (`txid` in internal byte order) so `opSig` is bound to this exact spend.
 */
export function buildReseed(input: {
  beacon: Omit<BeaconCoin, "state">;
  round: bigint;
  lastExpiry: bigint;
  sign: (outpoint: { txid: Uint8Array; vout: number }) => Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  const fn = input.beacon.script.functionByName("reseed");
  if (!fn || !fn.arkadeScript) throw new Error("AttestationBeacon.reseed not found");
  const next = reseedState(input.round, input.lastExpiry);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{
      txid: input.beacon.coin.txid,
      vout: input.beacon.coin.vout,
      value: Number(input.beacon.coin.value),
      tapLeafScript: fn.tapLeafScript,
      tapTree: input.beacon.script.encode(),
    }],
    [{ script: input.beacon.script.pkScript, amount: BigInt(input.beacon.coin.value) }],
    input.checkpoint,
  );
  setArkPsbtField(arkTx, 0, PrevArkTxField, input.beacon.coin.prevTx);
  const cpIn = arkTx.getInput(0);
  if (!cpIn?.txid || cpIn.index == null) throw new Error("checkpoint input missing");
  const opSig = input.sign({ txid: internalTxid(bytesToHex(cpIn.txid)), vout: cpIn.index });
  if (opSig.length !== 64) throw new Error("op signature");
  const callArgs: Record<string, bigint | Uint8Array> = {
    round: input.round,
    lastExpiry: input.lastExpiry,
    opSig,
  };
  const stack = (fn.def.arkadeScript?.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, input.beacon.script.args));
  attachExtension(arkTx, [
    unitTransfer(input.beacon.id, 0, 0),
    statePacket(next),
    EmulatorPacket.create([{ vin: 0, script: fn.arkadeScript, witness: encodeWitness(stack) }]),
  ]);
  return { arkTx, checkpoints, signIndexes: [] };
}

/** Renew the beacon VTXO in an Arkade batch round via `AttestationBeacon.reboard`, keeping its identity asset. */
export async function reboardBeacon(input: {
  arkProvider: ArkProvider;
  emulator: EmulatorProvider;
  network: Network;
  script: ProgramScript;
  address: string;
  coin: { txid: string; vout: number; value: number; script: string; prevTx: Uint8Array; assets?: { assetId: string; amount: bigint | number }[] };
  id: asset.AssetId;
  opSig: Uint8Array;
  signal?: AbortSignal;
}): Promise<{ commitmentTxid: string; intentId: string }> {
  if (input.opSig.length !== 64) throw new Error("op signature");
  const fn = input.script.functionByName("reboard");
  if (!fn || !fn.arkadeScript) throw new Error("AttestationBeacon.reboard not found");
  const callArgs: Record<string, bigint | Uint8Array> = { opSig: input.opSig };
  const stack = (fn.def.arkadeScript?.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, input.script.args));
  const witness = encodeWitness(stack);
  const coinInput = {
    txid: input.coin.txid,
    vout: input.coin.vout,
    value: input.coin.value,
    script: input.coin.script,
    prevTx: input.coin.prevTx,
    tapTree: input.script.encode(),
    forfeitTapLeafScript: fn.tapLeafScript,
    proofTapLeafScript: fn.tapLeafScript,
    assets: input.coin.assets,
  };
  const recipients = [{
    address: input.address,
    amount: input.coin.value,
    assets: [{ assetId: input.id.toString(), amount: 1n }],
  }];
  const packets: ExtensionPacket[] = [
    unitTransfer(input.id, 1, 0),
    EmulatorPacket.create([{ vin: 1, script: fn.arkadeScript, witness }]),
  ];
  const session = TreeSignerSession.random();
  const sessionKey = bytesToHex(await session.getPublicKey());
  const registerMessage = {
    type: "register" as const,
    onchain_output_indexes: [] as number[],
    valid_at: 0,
    expire_at: 0,
    cosigners_public_keys: [sessionKey],
  };
  const deleteMessage = { type: "delete" as const, expire_at: 0 };
  const outputs = [
    { script: input.script.pkScript, amount: BigInt(input.coin.value) },
    Extension.create(packets).txOut(),
  ];
  const [signedProof, deleteProof] = await Promise.all(
    [registerMessage, deleteMessage].map((message) =>
      input.emulator.submitIntent({
        proof: base64.encode(Proof.create(message, [coinInput as never], outputs).toPSBT()),
        message,
      })
    ),
  );
  const abort = new AbortController();
  let registering = false;
  let forfeiting = false;
  try {
    const outpoint = `${input.coin.txid}:${input.coin.vout}`;
    const events = Batch.prime(input.arkProvider.getEventStream(abort.signal, [sessionKey, outpoint]));
    registering = true;
    const intentId = await input.arkProvider.registerIntent({ proof: signedProof, message: registerMessage });
    const handler = arkade.createArkadeBatchHandler(
      intentId,
      [{ ...coinInput, arkadeScriptBytes: fn.arkadeScript } as never],
      undefined,
      signedProof,
      registerMessage,
      session,
      input.arkProvider,
      input.emulator,
      input.network,
      recipients,
    );
    const commitmentTxid = await Batch.join(
      events,
      {
        ...handler,
        onBatchFinalization: (...args) => {
          forfeiting = true;
          return handler.onBatchFinalization(...args);
        },
      },
      { abortController: abort },
    );
    return { commitmentTxid, intentId };
  } catch (err) {
    if (registering && !forfeiting) {
      await input.arkProvider.deleteIntent({ proof: deleteProof, message: deleteMessage }).catch(() => undefined);
    }
    throw err;
  } finally {
    abort.abort();
  }
}

/** Sign the identity's inputs and submit to the emulator. */
export async function submit(built: Built, emulator: Pick<EmulatorProvider, "submitTx">, identity?: Identity): Promise<{ txid: string; signedArkTx: string }> {
  let arkTx = built.arkTx;
  let checkpoints = built.checkpoints;
  if (built.signIndexes.length > 0) {
    if (!identity) throw new Error("an identity is required to sign the fee coin");
    arkTx = await identity.sign(arkTx, built.signIndexes);
    checkpoints = await Promise.all(checkpoints.map((cp, i) => (built.signIndexes.includes(i) ? identity.sign(cp, [0]) : Promise.resolve(cp))));
  }
  const res = await emulator.submitTx(base64.encode(arkTx.toPSBT()), checkpoints.map((cp) => base64.encode(cp.toPSBT())));
  return { txid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id, signedArkTx: res.signedArkTx };
}
