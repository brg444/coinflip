import { arkade, DefaultVtxo, networks, RestArkProvider } from "@arkade-os/sdk";

import type { BeaconId } from "./beacon-id.ts";
import { ARK_URL, EXIT, isPredict, type Kind } from "./constants.ts";
import { bytesToHex, hexToBytes, xOnly } from "./hex.ts";
import { intentProgram, swapProgram, vaultProgramFor } from "./programs.ts";

export type Terms = {
  /** 0 covered call, 1 limited put: the user writes. 2 higher, 3 lower: the user holds. */
  kind: Kind;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  exit: bigint;
  writerPk: Uint8Array;
  /** Taproot output key of the writer's Arkade address. Premium and settlement pay this key. */
  payoutKey?: Uint8Array;
  holderPk: Uint8Array;
  /** Taproot output key of the bettor's Arkade address. A predict payout and a refund pay this key. */
  holderPayoutKey?: Uint8Array;
  /** Identity asset of the AttestationBeacon that settle reads. */
  beacon: BeaconId;
  /** Sats this settle leaves on the beacon. Must match the beacon's readFee. */
  readFee?: bigint;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type Bound = {
  intentAddress: string;
  vaultAddress: string;
  writerPkScript: Uint8Array;
  holderPkScript: Uint8Array;
  /** The page's side: the writer for options, the holder for predict. Refunds pay this. */
  userPkScript: Uint8Array;
  /** The desk's side: the holder for options, the writer for predict. Fills pay this. */
  solverPkScript: Uint8Array;
  vaultPkScript: Uint8Array;
  intentPkScript: Uint8Array;
  writerProgram: Uint8Array;
  holderProgram: Uint8Array;
  optionProgram: Uint8Array;
  intent: Record<string, bigint | Uint8Array>;
  vault: Record<string, bigint | Uint8Array>;
};

/** Arkd refuses a vtxo whose shortest exit leaf is under this delay. */
export async function assertServerExit(url = ARK_URL) {
  const delay = BigInt((await new RestArkProvider(url).getInfo()).unilateralExitDelay);
  if (delay !== EXIT) throw new Error(`server unilateralExitDelay is ${delay}; contracts use ${EXIT}`);
}

export function payoutVtxo(pubKey: Uint8Array, serverKey: Uint8Array, exit: bigint = EXIT) {
  return new DefaultVtxo.Script({
    pubKey: xOnly(pubKey),
    serverPubKey: xOnly(serverKey),
    csvTimelock: { type: "seconds", value: exit },
  });
}

/** Taproot key of a pasted Arkade address, when the script is exactly that key. */
export function directPayoutKey(writerPubkey: string, writerPkScript: string): Uint8Array | undefined {
  let key: Uint8Array;
  let script: Uint8Array;
  try {
    key = xOnly(hexToBytes(writerPubkey));
    script = hexToBytes(writerPkScript);
  } catch {
    return undefined;
  }
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return undefined;
  if (bytesToHex(script.subarray(2)) !== bytesToHex(key)) return undefined;
  return key;
}

export function directPayout(key: Uint8Array): { tweakedPublicKey: Uint8Array; pkScript: Uint8Array } {
  const tweakedPublicKey = xOnly(key);
  const pkScript = new Uint8Array(34);
  pkScript[0] = 0x51;
  pkScript[1] = 0x20;
  pkScript.set(tweakedPublicKey, 2);
  return { tweakedPublicKey, pkScript };
}

export function addressOf(script: { address: (hrp: string, server: Uint8Array) => { encode: () => string } }, serverKey: Uint8Array) {
  return script.address(networks.mutinynet.hrp, xOnly(serverKey)).encode();
}

/**
 * The vault and OptionIntent for one quote. The page and the desk both call
 * this. A quote whose addresses differ from this derivation is refused.
 *
 * Options (kinds 0 and 1) are intent side 0: the user is the writer and locks
 * the notional, the desk pays the premium. Predict (kinds 2 and 3) is side 1:
 * the user is the holder and pays the stake as the premium, the desk is the
 * writer and funds the payout as the collateral of a PredictVault.
 */
export function bindContracts(terms: Terms): Bound {
  const serverKey = xOnly(terms.serverKey);
  const writerPk = xOnly(terms.writerPk);
  const holderPk = xOnly(terms.holderPk);
  if (terms.emulatorKey.length !== 33) {
    throw new Error("emulator key must be 33 bytes");
  }
  if (terms.beacon.txid.length !== 32) throw new Error("beacon txid must be 32 bytes");

  const predict = isPredict(terms.kind);
  const writer = terms.payoutKey ? directPayout(terms.payoutKey) : payoutVtxo(writerPk, serverKey, terms.exit);
  const holder = terms.holderPayoutKey ? directPayout(terms.holderPayoutKey) : payoutVtxo(holderPk, serverKey, terms.exit);
  const keys = { serverKey, emulatorKey: terms.emulatorKey };

  const vaultArgs: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    holderPk,
    writerScript: writer.tweakedPublicKey,
    holderScript: holder.tweakedPublicKey,
    strike: terms.strike,
    collateral: terms.collateral,
    expiry: terms.expiry,
    beaconTxid: terms.beacon.txid,
    beaconGidx: terms.beacon.gidx,
    readFee: terms.readFee ?? 0n,
    exit: terms.exit,
    server: serverKey,
  };
  const vaultScript = new arkade.ArkadeProgramScript(vaultProgramFor(terms.kind), vaultArgs, keys);

  const user = predict ? { pk: holderPk, program: holder } : { pk: writerPk, program: writer };
  const solver = predict ? writer : holder;
  const intentArgs: Record<string, bigint | Uint8Array> = {
    userPk: user.pk,
    userScript: user.program.tweakedPublicKey,
    solverScript: solver.tweakedPublicKey,
    optionScript: vaultScript.tweakedPublicKey,
    side: predict ? 1n : 0n,
    collateral: terms.collateral,
    premium: terms.premium,
    deadline: terms.deadline,
    exit: terms.exit,
    server: serverKey,
  };
  const intentScript = new arkade.ArkadeProgramScript(intentProgram(), intentArgs, keys);

  return {
    intentAddress: addressOf(intentScript, serverKey),
    vaultAddress: addressOf(vaultScript, serverKey),
    writerPkScript: writer.pkScript,
    holderPkScript: holder.pkScript,
    userPkScript: user.program.pkScript,
    solverPkScript: solver.pkScript,
    vaultPkScript: vaultScript.pkScript,
    intentPkScript: intentScript.pkScript,
    writerProgram: writer.tweakedPublicKey,
    holderProgram: holder.tweakedPublicKey,
    optionProgram: vaultScript.tweakedPublicKey,
    intent: intentArgs,
    vault: vaultArgs,
  };
}

/** Witness program the swap's output 0 is checked against. */
export function swapMakerProgram(makerPk: Uint8Array, serverKey: Uint8Array, exit: bigint = EXIT): Uint8Array {
  return payoutVtxo(makerPk, serverKey, exit).tweakedPublicKey;
}

export function bindSwap(input: {
  makerPk: Uint8Array;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  offerAssetIdTxid: Uint8Array;
  offerAssetIdGidx: bigint;
  offerAmount: bigint;
  wantAssetIdTxid: Uint8Array;
  wantAssetIdGidx: bigint;
  wantAmount: bigint;
  expirationTime: bigint;
  exit?: bigint;
  makerProgram: Uint8Array;
}) {
  const exit = input.exit ?? EXIT;
  const serverKey = xOnly(input.serverKey);
  const args: Record<string, bigint | Uint8Array> = {
    makerPk: xOnly(input.makerPk),
    offerAssetIdTxid: input.offerAssetIdTxid,
    offerAssetIdGidx: input.offerAssetIdGidx,
    offerAmount: input.offerAmount,
    wantAssetIdTxid: input.wantAssetIdTxid,
    wantAssetIdGidx: input.wantAssetIdGidx,
    wantAmount: input.wantAmount,
    expirationTime: input.expirationTime,
    exit,
    vtxo_SingleSig_makerPk_exit: input.makerProgram,
    server: serverKey,
  };
  const script = new arkade.ArkadeProgramScript(swapProgram(), args, {
    serverKey,
    emulatorKey: input.emulatorKey,
  });
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    args,
  };
}
