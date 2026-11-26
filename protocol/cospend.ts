import {
  arkade,
  buildOffchainTx,
  ConditionWitness,
  EmulatorPacket,
  Extension,
  P2A,
  PrevArkTxField,
  setArkPsbtField,
  Transaction,
  type ArkTxInput,
  type CSVMultisigTapscript,
  type EmulatorProvider,
  type ExtensionPacket,
  type Identity,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { DUST_SATS } from "./constants.ts";
import { centsOf } from "./dia.ts";
import { bin2num } from "./fixing.ts";
import { bytesToHex } from "./hex.ts";

/**
 * Covenant off-chain transaction builders for standalone PredictVaultV3
 * settlement (`settle`) and post-void-window refund (`refund`).
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

function readCompactSize(bytes: Uint8Array, at: number): [number, number] | null {
  if (at >= bytes.length) return null;
  const first = bytes[at]!;
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd) {
    if (at + 3 > bytes.length) return null;
    return [bytes[at + 1]! | (bytes[at + 2]! << 8), at + 3];
  }
  if (first === 0xfe) {
    if (at + 5 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4);
    return [view.getUint32(0, true), at + 5];
  }
  return null;
}

/** Decode a compact-size framed witness stack produced by `encodeWitness`. */
export function decodeWitness(bytes: Uint8Array): Uint8Array[] | null {
  const head = readCompactSize(bytes, 0);
  if (!head) return null;
  const [count, start] = head;
  const items: Uint8Array[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    const next = readCompactSize(bytes, at);
    if (!next) return null;
    const [len, dataAt] = next;
    if (dataAt + len > bytes.length) return null;
    items.push(bytes.subarray(dataAt, dataAt + len));
    at = dataAt + len;
  }
  return at === bytes.length ? items : null;
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

export type PredictFixingInput = {
  /** 18-decimal DIA BTC/USD price. */
  price: bigint;
  /** Sample unix timestamp inside `[expiry, expiry + 60]`. */
  time: bigint;
  /** DIA intent nonce. */
  nonce: bigint;
  /** DIA intent expiry. */
  intentExpiry: bigint;
  /** 64-byte DIA EIP-712 signature (`r || s`). */
  sig: Uint8Array;
  /** 64-byte BIP340 Schnorr signature from `oraclePk` over `predictFixDigest`. */
  oracleSig: Uint8Array;
};

/**
 * Settle a standalone PredictVaultV3: 1 input (vault), payouts starting at output 0.
 * Direct stack signature verification — no shared oracle coin, no asset transfer, no state packet.
 */
export function buildPredictSettle(input: {
  vault: { script: ProgramScript; coin: Coin };
  fixing: PredictFixingInput;
  payouts: { script: Uint8Array; amount: bigint }[];
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  if (input.fixing.sig.length !== 64) throw new Error("dia signature");
  if (input.fixing.oracleSig.length !== 64) throw new Error("oracle signature");
  return build(
    [{
      script: input.vault.script,
      fn: "settle",
      callArgs: {
        price: input.fixing.price,
        time: input.fixing.time,
        nonce: input.fixing.nonce,
        intentExpiry: input.fixing.intentExpiry,
        sig: input.fixing.sig,
        oracleSig: input.fixing.oracleSig,
      },
      coin: input.vault.coin,
    }],
    input.payouts,
    [],
    input.checkpoint,
  );
}

/** Extract the rounded USD cents price from a standalone `PredictVault.settle` transaction's emulator witness. */
export function predictSettlePriceCents(tx: Transaction): bigint | null {
  try {
    const entry = Extension.fromTx(tx).getEmulatorPacket()?.entries.find((item) => item.vin === 0);
    if (!entry?.witness?.length) return null;
    const stack = decodeWitness(entry.witness);
    if (!stack || stack.length !== 6) return null;
    // Witness order matches `settle(price, time, nonce, intentExpiry, sig, oracleSig)` reversed on stack:
    // [oracleSig (64B), sig (64B), intentExpiry, nonce, time, price] or forward [price, ..., sig (64B), oracleSig (64B)].
    const rawBytes = stack[0]!.length === 64 && stack[1]!.length === 64
      ? stack[5]!
      : stack[4]!.length === 64 && stack[5]!.length === 64
        ? stack[0]!
        : null;
    if (!rawBytes || rawBytes.length === 0) return null;
    const rawPrice = bin2num(rawBytes);
    if (rawPrice <= 0n) return null;
    return centsOf(rawPrice);
  } catch {
    return null;
  }
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

/** Sign the identity's inputs (if any) and submit to the emulator. */
export async function submit(built: Built, emulator: Pick<EmulatorProvider, "submitTx">, identity?: Identity): Promise<{ txid: string; signedArkTx: string }> {
  let arkTx = built.arkTx;
  let checkpoints = built.checkpoints;
  if (built.signIndexes.length > 0) {
    if (!identity) throw new Error("an identity is required to sign inputs");
    arkTx = await identity.sign(arkTx, built.signIndexes);
    checkpoints = await Promise.all(checkpoints.map((cp, i) => (built.signIndexes.includes(i) ? identity.sign(cp, [0]) : Promise.resolve(cp))));
  }
  const res = await emulator.submitTx(base64.encode(arkTx.toPSBT()), checkpoints.map((cp) => base64.encode(cp.toPSBT())));
  return { txid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id, signedArkTx: res.signedArkTx };
}
