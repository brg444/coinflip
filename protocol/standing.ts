import { arkade, UnknownPacket, type CSVMultisigTapscript } from "@arkade-os/sdk";

import type { BeaconId } from "./beacon-id.ts";
import { DUST_SATS } from "./constants.ts";
import { addressOf, directPayout, payoutVtxo, scriptArg } from "./contracts.ts";
import { build, type Built, type Coin } from "./cospend.ts";
import { bytesToHex, xOnly } from "./hex.ts";
import { standingLegProgram, standingVaultProgram } from "./programs.ts";

/** Packet on the match. Version, holder key, holder payout program. */
export const STANDING_PARTY = 33;
const PARTY_SIZE = 65;

export type StandingTerms = {
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  exit: bigint;
  writerPk: Uint8Array;
  /** Taproot output key of the writer's Arkade address, when it is exactly that key. */
  payoutKey?: Uint8Array;
  beacon: BeaconId;
  readFee?: bigint;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type StandingScript = {
  address: string;
  pkScript: Uint8Array;
  program: Uint8Array;
  args: Record<string, bigint | Uint8Array>;
  script: arkade.ArkadeProgramScript;
};

function keysOf(terms: { serverKey: Uint8Array; emulatorKey: Uint8Array }) {
  if (terms.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  return { serverKey: xOnly(terms.serverKey), emulatorKey: terms.emulatorKey };
}

function compile(program: ReturnType<typeof standingVaultProgram>, args: Record<string, bigint | Uint8Array>, keys: { serverKey: Uint8Array; emulatorKey: Uint8Array }, serverKey: Uint8Array): StandingScript {
  const script = new arkade.ArkadeProgramScript(program, args, keys);
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    program: script.tweakedPublicKey,
    args,
    script,
  };
}

/**
 * The vault a writer can fund before any holder exists. The program names the
 * writer and the terms. It does not name a holder.
 */
export function bindStandingVault(terms: StandingTerms): StandingScript {
  if (terms.beacon.txid.length !== 32) throw new Error("beacon txid must be 32 bytes");
  const keys = keysOf(terms);
  const writerPk = xOnly(terms.writerPk);
  const writer = terms.payoutKey ? directPayout(terms.payoutKey) : payoutVtxo(writerPk, keys.serverKey, terms.exit);
  const args: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    ...scriptArg("writerScript", writer.tweakedPublicKey),
    strike: terms.strike,
    collateral: terms.collateral,
    expiry: terms.expiry,
    beaconTxid: terms.beacon.txid,
    beaconGidx: terms.beacon.gidx,
    readFee: terms.readFee ?? 0n,
    exit: terms.exit,
    server: keys.serverKey,
  };
  return compile(standingVaultProgram(), args, keys, keys.serverKey);
}

function leg(terms: StandingTerms, side: 0 | 1, userPk: Uint8Array, userScript: Uint8Array, premiumScript: Uint8Array, vaultProgram: Uint8Array): StandingScript {
  const keys = keysOf(terms);
  const args: Record<string, bigint | Uint8Array> = {
    userPk: xOnly(userPk),
    ...scriptArg("userScript", userScript),
    ...scriptArg("premiumScript", premiumScript),
    ...scriptArg("vaultProgram", vaultProgram),
    side: BigInt(side),
    collateral: terms.collateral,
    premium: terms.premium,
    deadline: terms.deadline,
    exit: terms.exit,
    server: keys.serverKey,
  };
  return compile(standingLegProgram(), args, keys, keys.serverKey);
}

/** Side 0. An ordinary send to this address is the writer's standing offer. */
export function bindWriterLeg(terms: StandingTerms): StandingScript {
  const vault = bindStandingVault(terms);
  const writerScript = vault.args["writerScript.program"];
  if (!(writerScript instanceof Uint8Array)) throw new Error("writer script missing");
  return leg(terms, 0, terms.writerPk, writerScript, writerScript, vault.program);
}

/**
 * Side 1 for one holder taking that writer's vault. The writer's coin does not
 * change when the holder is chosen.
 */
export function bindHolderLeg(terms: StandingTerms, holderPk: Uint8Array, holderPayoutKey?: Uint8Array): StandingScript {
  const keys = keysOf(terms);
  const vault = bindStandingVault(terms);
  const writerScript = vault.args["writerScript.program"];
  if (!(writerScript instanceof Uint8Array)) throw new Error("writer script missing");
  const holder = holderPayoutKey ? directPayout(holderPayoutKey) : payoutVtxo(xOnly(holderPk), keys.serverKey, terms.exit);
  return leg(terms, 1, holderPk, holder.tweakedPublicKey, writerScript, vault.program);
}

export function standingParty(holderPk: Uint8Array, holderScript: Uint8Array): Uint8Array {
  if (holderPk.length !== 32 || holderScript.length !== 32) throw new Error("holder key and script are 32 bytes");
  const body = new Uint8Array(PARTY_SIZE);
  body[0] = 1;
  body.set(holderPk, 1);
  body.set(holderScript, 33);
  return body;
}

function bytesArg(script: arkade.ArkadeProgramScript, name: string): Uint8Array {
  const value = script.args[name];
  if (!(value instanceof Uint8Array)) throw new Error(`${name} missing`);
  return value;
}

function intArg(script: arkade.ArkadeProgramScript, name: string): bigint {
  const value = script.args[name];
  if (typeof value !== "bigint") throw new Error(`${name} missing`);
  return value;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return bytesToHex(a) === bytesToHex(b);
}

function programPk(program: Uint8Array): Uint8Array {
  if (program.length !== 32) throw new Error("payout program must be 32 bytes");
  const script = new Uint8Array(34);
  script[0] = 0x51;
  script[1] = 0x20;
  script.set(program, 2);
  return script;
}

/**
 * Spend a writer leg and a holder leg in one fill. Input 0 is the writer.
 * Input 1 is the holder. Output 0 pays the premium to the writer. Output 1
 * locks the collateral in the writer's vault. The party packet names the holder.
 * Neither funder signs. A desk can fund either leg, or still fill a lone
 * OptionIntent from its float.
 */
export function buildStandingMatch(input: {
  writer: { script: arkade.ArkadeProgramScript; coin: Coin };
  holder: { script: arkade.ArkadeProgramScript; coin: Coin };
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  const writer = input.writer.script;
  const holder = input.holder.script;
  if (intArg(writer, "side") !== 0n) throw new Error("writer leg is not side 0");
  if (intArg(holder, "side") !== 1n) throw new Error("holder leg is not side 1");
  const writerPayout = bytesArg(writer, "userScript.program");
  if (!sameBytes(bytesArg(writer, "premiumScript.program"), writerPayout)) {
    throw new Error("writer premium is not paid to the writer");
  }
  if (!sameBytes(bytesArg(holder, "premiumScript.program"), writerPayout)) {
    throw new Error("holder premium is not paid to the writer");
  }
  if (!sameBytes(bytesArg(writer, "vaultProgram.program"), bytesArg(holder, "vaultProgram.program"))) {
    throw new Error("legs name different vaults");
  }
  const collateral = intArg(writer, "collateral");
  const premium = intArg(writer, "premium");
  if (collateral !== intArg(holder, "collateral")) throw new Error("legs name different collateral");
  if (premium !== intArg(holder, "premium")) throw new Error("legs name different premiums");
  if (collateral <= DUST_SATS) throw new Error("collateral is below the dust line");
  if (premium <= DUST_SATS) throw new Error("premium is below the dust line");

  const writerValue = BigInt(input.writer.coin.value);
  const holderValue = BigInt(input.holder.coin.value);
  if (writerValue < collateral) throw new Error("writer coin is short of the collateral");
  if (holderValue < premium) throw new Error("holder coin is short of the premium");

  const writerChange = writerValue - collateral;
  const holderChange = holderValue - premium;
  const folded = holderChange > 0n && holderChange <= DUST_SATS ? holderChange : 0n;
  const outputs: { script: Uint8Array; amount: bigint }[] = [
    { script: programPk(writerPayout), amount: premium + writerChange + folded },
    { script: programPk(bytesArg(writer, "vaultProgram.program")), amount: collateral },
  ];
  if (holderChange > DUST_SATS) {
    outputs.push({ script: programPk(bytesArg(holder, "userScript.program")), amount: holderChange });
  }

  return build(
    [
      { script: writer, fn: "fill", coin: input.writer.coin },
      { script: holder, fn: "fill", coin: input.holder.coin },
    ],
    outputs,
    [new UnknownPacket(STANDING_PARTY, standingParty(bytesArg(holder, "userPk"), bytesArg(holder, "userScript.program")))],
    input.checkpoint,
  );
}
