import { arkade, DefaultVtxo, networks, RestArkProvider } from "@arkade-os/sdk";

import {
  ARK_URL,
  EXIT,
  PREDICT_FALLBACK_DELAY,
  PREDICT_FINAL_EXIT_DELAY,
  PREDICT_VOID_AFTER,
  type PredictKind,
} from "./constants.ts";
import { bytesToHex, hexToBytes, xOnly } from "./hex.ts";
import { exitSequence, intentProgram, predictVaultProgram } from "./programs.ts";

export type Terms = {
  /** 2 higher, 3 lower: the bettor holds and the desk writes. */
  kind: PredictKind;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  exit: bigint;
  writerPk: Uint8Array;
  /** Optional raw Taproot output key for the writer's Arkade address. */
  payoutKey?: Uint8Array;
  holderPk: Uint8Array;
  /** Optional raw Taproot output key for the bettor's Arkade address. */
  holderPayoutKey?: Uint8Array;
  /** X-only pubkey of the oracle co-signing canonical fixings for PredictVault.settle. */
  oraclePk: Uint8Array;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  backupPk?: Uint8Array;
  voidAfter?: bigint;
  fallbackDelay?: bigint;
  finalExitDelay?: bigint;
  /** Bech32m address HRP ("ark" on Bitcoin mainnet, "tark" on Mutinynet/regtest). */
  hrp?: string;
};

export type Bound = {
  intentAddress: string;
  vaultAddress: string;
  writerPkScript: Uint8Array;
  holderPkScript: Uint8Array;
  /** The bettor's script. Refunds and winning settlements pay this. */
  userPkScript: Uint8Array;
  /** The desk's script. Fills and losing settlements pay this. */
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
export async function assertServerExit(url = ARK_URL, expectedExit: bigint = EXIT) {
  const delay = BigInt((await new RestArkProvider(url).getInfo()).unilateralExitDelay);
  if (delay !== expectedExit) throw new Error(`server unilateralExitDelay is ${delay}; contracts use ${expectedExit}`);
}

export function payoutVtxo(pubKey: Uint8Array, serverKey: Uint8Array, exit: bigint = EXIT) {
  return new DefaultVtxo.Script({
    pubKey: xOnly(pubKey),
    serverPubKey: xOnly(serverKey),
    csvTimelock: { type: "seconds", value: exit },
  });
}

/** Taproot key of a pasted Arkade address, when the script is exactly that key. */
export function directPayoutKey(pubkey: string, pkScript: string): Uint8Array | undefined {
  let key: Uint8Array;
  let script: Uint8Array;
  try {
    key = xOnly(hexToBytes(pubkey));
    script = hexToBytes(pkScript);
  } catch {
    return undefined;
  }
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return undefined;
  if (bytesToHex(script.subarray(2)) !== bytesToHex(key)) return undefined;
  return key;
}

/** Witness version 1. `program` is the 32-byte output key the contract compares. */
export function scriptArg(name: string, program: Uint8Array): Record<string, bigint | Uint8Array> {
  return { [`${name}.program`]: program, [`${name}.version`]: 1n };
}

export function directPayout(key: Uint8Array): { tweakedPublicKey: Uint8Array; pkScript: Uint8Array } {
  const tweakedPublicKey = xOnly(key);
  const pkScript = new Uint8Array(34);
  pkScript[0] = 0x51;
  pkScript[1] = 0x20;
  pkScript.set(tweakedPublicKey, 2);
  return { tweakedPublicKey, pkScript };
}

export function addressOf(
  script: { address: (hrp: string, server: Uint8Array) => { encode: () => string } },
  serverKey: Uint8Array,
  hrp: string = networks.mutinynet.hrp,
) {
  return script.address(hrp, xOnly(serverKey)).encode();
}

/**
 * Derive the PredictVault and OptionIntent (side 1) for one quote.
 * Both the page and the desk call this; quotes whose addresses differ are refused.
 */
export function bindContracts(terms: Terms): Bound {
  const serverKey = xOnly(terms.serverKey);
  const writerPk = xOnly(terms.writerPk);
  const holderPk = xOnly(terms.holderPk);
  if (terms.emulatorKey.length !== 33) {
    throw new Error("emulator key must be 33 bytes");
  }
  if (terms.kind !== 2 && terms.kind !== 3) {
    throw new Error(`unsupported kind ${terms.kind}`);
  }
  if (!terms.oraclePk) {
    throw new Error("oraclePk is required for PredictVault");
  }
  const writer = terms.payoutKey ? directPayout(terms.payoutKey) : payoutVtxo(writerPk, serverKey, terms.exit);
  const holder = terms.holderPayoutKey ? directPayout(terms.holderPayoutKey) : payoutVtxo(holderPk, serverKey, terms.exit);
  const keys = { serverKey, emulatorKey: terms.emulatorKey };

  const voidAfter = terms.voidAfter ?? PREDICT_VOID_AFTER;
  const fallbackDelay = terms.fallbackDelay ?? PREDICT_FALLBACK_DELAY;
  const finalExitDelay = terms.finalExitDelay ?? PREDICT_FINAL_EXIT_DELAY;
  if (voidAfter <= 0n) throw new Error("voidAfter must be positive");
  if (fallbackDelay < terms.exit) throw new Error("fallbackDelay must be at least exit");
  if (finalExitDelay <= fallbackDelay) throw new Error("finalExitDelay must exceed fallbackDelay");
  const oraclePk = xOnly(terms.oraclePk);
  const backupPk = xOnly(terms.backupPk ?? terms.emulatorKey);

  const vaultArgs: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    holderPk,
    ...scriptArg("writerScript", writer.tweakedPublicKey),
    ...scriptArg("holderScript", holder.tweakedPublicKey),
    strike: terms.strike,
    collateral: terms.collateral,
    stake: terms.premium,
    expiry: terms.expiry,
    oraclePk,
    backupPk,
    voidAfter,
    fallbackDelay: exitSequence(fallbackDelay),
    finalExitDelay: exitSequence(finalExitDelay),
    server: serverKey,
  };
  const vaultScript = new arkade.ArkadeProgramScript(predictVaultProgram(), vaultArgs, keys);

  const intentArgs: Record<string, bigint | Uint8Array> = {
    userPk: holderPk,
    ...scriptArg("userScript", holder.tweakedPublicKey),
    ...scriptArg("solverScript", writer.tweakedPublicKey),
    ...scriptArg("optionScript", vaultScript.tweakedPublicKey),
    side: 1n,
    collateral: terms.collateral,
    premium: terms.premium,
    deadline: terms.deadline,
    exit: exitSequence(terms.exit),
    server: serverKey,
  };
  const intentScript = new arkade.ArkadeProgramScript(intentProgram(), intentArgs, keys);

  const hrp = terms.hrp ?? networks.mutinynet.hrp;
  return {
    intentAddress: addressOf(intentScript, serverKey, hrp),
    vaultAddress: addressOf(vaultScript, serverKey, hrp),
    writerPkScript: writer.pkScript,
    holderPkScript: holder.pkScript,
    userPkScript: holder.pkScript,
    solverPkScript: writer.pkScript,
    vaultPkScript: vaultScript.pkScript,
    intentPkScript: intentScript.pkScript,
    writerProgram: writer.tweakedPublicKey,
    holderProgram: holder.tweakedPublicKey,
    optionProgram: vaultScript.tweakedPublicKey,
    intent: intentArgs,
    vault: vaultArgs,
  };
}
