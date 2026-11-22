import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * DIA OracleUpdate for BTC/USD. The recipe is OracleIntentUtils in
 * diadata-org/Spectra-interoperability: EIP-712 over the intent fields,
 * domain name "DIA Oracle", version "1.0", chain 1050, salt 0.
 */

export const DIA_REGISTRY = "0x5612599CF48032d7428399d5Fcb99eDcc75c06A7";
export const DIA_WS = "wss://rpc.diadata.org";
export const DIA_RPC = "https://rpc.diadata.org/";
export const SCALE = 10n ** 16n;
export const HALF = SCALE / 2n;
/** `0x10 ||` compressed secp256k1 key of the signer a live intent recovered. */
export const DIA_PUBKEY = hexToBytes("100211ee120bca9f272034d98b1b026bb4ab735ebeb5da8be6a69bf7ee0ea24cfd48");
const DOMAIN = hexToBytes("f57d55f057fd4aba6b1a7f8bccb6a3e826cf71fd34971f22a39d7ffd6e620fb3");
const TYPEHASH = hexToBytes("24e574fa7512cc24e9109b981256e33759d91bc2ee9b74a2bf633e013c0620b5");
const INTENT_TYPE = hexToBytes("ef9b6324ed493183babb66ed98fcf36e9bcb0243ae4c5a29fcd99184b08f1899");
const VERSION = hexToBytes("e6bbd6277e1bf288eed5e8d1780f9a50b239e86b153736bceebccf4ea79d90b3");
const SYMBOL = hexToBytes("ee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489");
const SOURCE = hexToBytes("f5a695b63ab16fd8278cb1cf7d29f274a9574b64e0b894750e08c990fc8891bc");

export type DiaIntent = {
  /** 18-decimal price. */
  price: bigint;
  /** Intent timestamp, unix seconds. This is the beacon sample time. */
  time: number;
  nonce: bigint;
  /** DIA intent expiry. Not the option expiry. */
  intentExpiry: number;
  /** First 64 bytes of the 65-byte Ethereum signature. */
  sig: Uint8Array;
};

export function centsOf(price: bigint): bigint {
  if (price <= 0n) throw new Error("nonpositive price");
  const q = price / SCALE;
  const r = price % SCALE;
  const cents = r >= HALF ? q + 1n : q;
  if (cents <= 0n) throw new Error("price");
  return cents;
}

/** 32-byte big-endian ABI word. Matches `reverseBytes(num2bin(n, 32))` for n under 2^255. */
export function abiWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 255n) throw new Error("abi word");
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The 32-byte digest `attest` rebuilds with `digest(..., 4)`. `symbol` defaults to BTC/USD, which the script pins. */
export function intentDigest(intent: Pick<DiaIntent, "price" | "time" | "nonce" | "intentExpiry">, symbol = "BTC/USD"): Uint8Array {
  const symbolWord = symbol === "BTC/USD" ? SYMBOL : keccak_256(new TextEncoder().encode(symbol));
  const body = concat(
    TYPEHASH,
    INTENT_TYPE,
    VERSION,
    abiWord(1050n),
    abiWord(intent.nonce),
    abiWord(BigInt(intent.intentExpiry)),
    symbolWord,
    abiWord(intent.price),
    abiWord(BigInt(intent.time)),
    SOURCE,
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), DOMAIN, keccak_256(body)));
}

const VIEW = "getLatestIntentByType(string,string)";

function selector(signature: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(signature)).subarray(0, 4);
}

function encString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const pad = (32 - (bytes.length % 32)) % 32;
  const out = new Uint8Array(32 + bytes.length + pad);
  const len = abiWord(BigInt(bytes.length));
  out.set(len, 0);
  out.set(bytes, 32);
  return out;
}

export function latestIntentCall(): string {
  const first = encString("OracleUpdate");
  const head = concat(abiWord(64n), abiWord(BigInt(64 + first.length)));
  const data = concat(selector(VIEW), head, first, encString("BTC/USD"));
  return `0x${[...data].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function wordAt(raw: Uint8Array, index: number): bigint {
  let value = 0n;
  for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(raw[index * 32 + i]!);
  return value;
}

function dyn(raw: Uint8Array, base: number, offset: number): Uint8Array {
  const start = base + offset;
  const len = Number(wordAt(raw.subarray(start, start + 32), 0));
  return raw.subarray(start + 32, start + 32 + len);
}

/** Decode a `getLatestIntentByType` eth_call result, without the 0x prefix. */
export function decodeIntent(resultHex: string): DiaIntent {
  const raw = hexToBytes(resultHex.replace(/^0x/, ""));
  const base = Number(wordAt(raw, 0));
  const heads = Array.from({ length: 11 }, (_, i) => Number(wordAt(raw, 1 + i)));
  const price = wordAt(raw, 7);
  const time = Number(wordAt(raw, 8));
  const nonce = wordAt(raw, 4);
  const intentExpiry = Number(wordAt(raw, 5));
  const signature = dyn(raw, base, heads[9]!);
  if (signature.length !== 65) throw new Error("dia signature");
  const symbol = new TextDecoder().decode(dyn(raw, base, heads[5]!));
  const intentType = new TextDecoder().decode(dyn(raw, base, heads[0]!));
  if (intentType !== "OracleUpdate" || symbol !== "BTC/USD") throw new Error("dia intent");
  if (wordAt(raw, 3) !== 1050n) throw new Error("dia chain");
  return { price, time, nonce, intentExpiry, sig: signature.subarray(0, 64) };
}

/** The pinned DIA key signed this intent. A bad signature is false, not an exception. */
export function intentSigned(intent: DiaIntent): boolean {
  if (intent.sig.length !== 64) return false;
  try {
    return secp256k1.verify(intent.sig, intentDigest(intent), DIA_PUBKEY.subarray(1), { prehash: false }) === true;
  } catch {
    return false;
  }
}

function accepts(intent: DiaIntent): boolean {
  return intentSigned(intent);
}

async function rpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(DIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`dia ${res.status}`);
  const body = await res.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "dia");
  return body.result;
}

async function intentByHash(hash: string, signal?: AbortSignal): Promise<DiaIntent> {
  const data = `0x${[...selector("getIntent(bytes32)")].map((byte) => byte.toString(16).padStart(2, "0")).join("")}${hash.replace(/^0x/, "")}`;
  const result = await rpc("eth_call", [{ to: DIA_REGISTRY, data }, "latest"], signal);
  if (typeof result !== "string") throw new Error("dia intent");
  return decodeIntent(result);
}

export async function fetchLatestIntent(signal?: AbortSignal): Promise<DiaIntent> {
  const res = await fetch(DIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: DIA_REGISTRY, data: latestIntentCall() }, "latest"],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`dia ${res.status}`);
  const body = await res.json() as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(body.error?.message ?? "dia");
  return decodeIntent(body.result);
}

/**
 * The newest BTC/USD intent the pinned key signed. The registry also stores
 * prints from other authorized signers. Those do not pass `attest`.
 */
export async function fetchPinnedIntent(signal?: AbortSignal): Promise<DiaIntent> {
  const latest = await fetchLatestIntent(signal);
  if (accepts(latest)) return latest;
  const head = Number(await rpc("eth_blockNumber", [], signal));
  const filter = intentRegisteredFilter();
  const logs = await rpc("eth_getLogs", [{
    address: filter.address,
    fromBlock: `0x${Math.max(0, head - 20_000).toString(16)}`,
    toBlock: "latest",
    topics: filter.topics,
  }], signal);
  if (!Array.isArray(logs)) throw new Error("dia logs");
  const want = "10e34723aa722c7a9860f5ec6446f22252db168a"; // DIA's pinned signer address
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i] as { data?: string; topics?: string[] };
    const data = (log.data ?? "").replace(/^0x/, "");
    // Non-indexed fields are timestamp, then signer. Price is an indexed topic.
    const signer = data.slice(64 + 24, 128);
    if (signer !== want) continue;
    const hash = log.topics?.[1];
    if (!hash) continue;
    const intent = await intentByHash(hash, signal);
    if (accepts(intent)) return intent;
  }
  throw new Error("no pinned DIA intent");
}

/** Topic of `IntentRegistered` for symbol `BTC/USD`. Indexed string is keccak256 of the bytes. */
export function intentRegisteredFilter(): { address: string; topics: [string, null, string] } {
  const event = keccak_256(new TextEncoder().encode("IntentRegistered(bytes32,string,uint256,uint256,address)"));
  const symbol = keccak_256(new TextEncoder().encode("BTC/USD"));
  const hex = (bytes: Uint8Array) => `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { address: DIA_REGISTRY, topics: [hex(event), null, hex(symbol)] };
}
