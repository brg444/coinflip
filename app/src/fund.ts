import {
  ArkAddress,
  BIP21,
  arkade,
  asset,
  ContractManager,
  IndexedDBContractRepository,
  IndexedDBWalletRepository,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  type ContractEvent,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../../protocol/beacon-id.ts";
import { ARK_URL, BEACON_READ_FEE, EMULATOR_URL, EXIT, isPredict, type Kind } from "../../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo, type Terms } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../../protocol/hex.ts";
import { networkByName } from "../../protocol/network.ts";
import { intentProgram, vaultProgram, vaultProgramFor } from "../../protocol/programs.ts";

export const NETWORK_NAME = "Mutinynet";
export const WALLET_URL = "https://mutinynet.arkade.money";

/**
 * Options: the page is the writer. `collateral` is what it locks, `premium`
 * what the desk pays, `holderPkHex` the desk. Predict: the page is the holder.
 * `premium` is the stake, `collateral` the payout, `writerPkHex` the desk, and
 * `holderAddress` the bettor's own address.
 */
export type FundRequest = {
  kind: Kind;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  /** Pasted Mutinynet address. Premium and settlement pay its taproot key. */
  writerAddress?: string;
  /** Older positions that stored a private key. */
  writerHex?: string;
  holderPkHex?: string;
  /** Predict: the bettor's address. The payout and a refund pay its taproot key. */
  holderAddress?: string;
  /** Predict: the desk's key. */
  writerPkHex?: string;
  /** Display txid of the beacon identity asset, from the desk's quote. Required to build a vault. */
  beaconTxidHex?: string;
  beaconGidx?: number;
  exit?: bigint;
};

export type Deposit = {
  network: typeof NETWORK_NAME;
  address: string;
  vaultAddress: string;
  amountSats: bigint;
  uri: string;
  holderPkHex: string;
  /** Predict: the desk's key. */
  writerPkHex: string;
  beaconTxidHex: string;
  beaconGidx: number;
  exit: number;
};

export type WriterBinding = {
  pubkey: string;
  pkScript: string;
  address: string;
  payoutKey: Uint8Array;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

type Session = {
  client: Awaited<ReturnType<typeof arkade.Arkade.connect>>;
};

const indexer = new RestIndexerProvider(ARK_URL);
const sessions = new Map<string, Promise<Session>>();
let managerPromise: Promise<ContractManager> | null = null;

function contracts(): Promise<ContractManager> {
  managerPromise ??= ContractManager.create({
    indexerProvider: indexer,
    contractRepository: new IndexedDBContractRepository(),
    walletRepository: new IndexedDBWalletRepository(),
    vtxoSyncMaxAgeMs: 60_000,
  });
  return managerPromise;
}

let operatorPromise: Promise<Session> | null = null;

/** Mutinynet server and emulator keys. Does not read the desk's saved positions. */
export function operatorSession(): Promise<Session> {
  if (!operatorPromise) {
    operatorPromise = (async () => {
      const ark = new RestArkProvider(ARK_URL);
      const info = await ark.getInfo();
      if (info.network.trim().toLowerCase() !== "mutinynet") {
        throw new Error("This page restores Mutinynet vaults.");
      }
      const contractManager = await contracts();
      const client = await arkade.Arkade.connect({
        arkade: ark,
        indexer,
        emulator: new RestEmulatorProvider(EMULATOR_URL),
        contractManager,
        network: networkByName(info.network),
      });
      return { client };
    })();
    operatorPromise.catch(() => {
      operatorPromise = null;
    });
  }
  return operatorPromise;
}

export async function readOutpoint(txid: string, vout: number) {
  const page = await indexer.getVtxos({ outpoints: [{ txid, vout }] });
  const want = txid.toLowerCase();
  return (page.vtxos ?? []).find((coin) => (coin.txid || "").toLowerCase() === want && coin.vout === vout) ?? null;
}
const ADDRESS_KEY = "arkade-options-address-v1";
const SESSION_KEY = "arkade-options-session-v1";
const LEGACY_WRITER_KEY = "arkade-options-writer-v1";

function openSession(identity: SingleKey): Promise<Session> {
  const id = identity.toHex();
  let pending = sessions.get(id);
  if (!pending) {
    pending = (async () => {
      const contractManager = await contracts();
      const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(ARK_URL),
        indexer,
        emulator: new RestEmulatorProvider(EMULATOR_URL),
        identity,
        contractManager,
        network: networks.mutinynet,
      });
      return { client };
    })();
    pending.catch(() => {
      sessions.delete(id);
    });
    sessions.set(id, pending);
  }
  return pending;
}

export function btcAmount(sats: bigint) {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** BIP21 deposit link. Amount stays a decimal string so 1 sat is not `1e-8`. */
export function paymentUri(address: string, sats: bigint): string {
  return BIP21.create({ ark: address, amount: btcAmount(sats) as unknown as number });
}

function storedHex(name: string): string | null {
  const raw = globalThis.localStorage?.getItem(name)?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(raw) || raw === "0".repeat(64)) return null;
  return raw;
}

/** Canonical Mutinynet address, or an error the page can show. */
export function parseWriterAddress(raw: string): string {
  const trimmed = raw.trim();
  let decoded: ArkAddress;
  try {
    decoded = ArkAddress.decode(trimmed);
  } catch {
    throw new Error("Paste a Mutinynet Arkade address. It starts with tark.");
  }
  if (decoded.hrp !== networks.mutinynet.hrp) {
    throw new Error("Paste a Mutinynet address. It starts with tark.");
  }
  return decoded.encode();
}

export function readAddress(): string | null {
  const raw = globalThis.localStorage?.getItem(ADDRESS_KEY)?.trim() ?? "";
  if (!raw) return null;
  try {
    return parseWriterAddress(raw);
  } catch {
    return null;
  }
}

export function saveAddress(raw: string): string {
  const address = parseWriterAddress(raw);
  globalThis.localStorage?.setItem(ADDRESS_KEY, address);
  return address;
}

export function clearAddress(): void {
  globalThis.localStorage?.removeItem(ADDRESS_KEY);
}

/** Browser identity for talking to arkd. It is not the payout address. */
export function sessionHex(): string {
  const existing = storedHex(SESSION_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  if (bytes.every((byte) => byte === 0)) bytes[0] = 1;
  const hex = bytesToHex(bytes);
  globalThis.localStorage?.setItem(SESSION_KEY, hex);
  return hex;
}

/** Key an older page created without asking. Used only to finish those positions. */
export function legacyWriterHex(): string | null {
  return storedHex(LEGACY_WRITER_KEY);
}

/** Address finalize pays, and the script the desk must accept. */
export async function writerBinding(address: string): Promise<WriterBinding> {
  const decoded = ArkAddress.decode(parseWriterAddress(address));
  const { client } = await openSession(SingleKey.fromHex(sessionHex()));
  if (!client.emulatorKey) throw new Error("The emulator key is missing.");
  await assertServerExit();
  if (bytesToHex(xOnly(client.serverKey)) !== bytesToHex(xOnly(decoded.serverPubKey))) {
    throw new Error("That address is for a different Arkade server.");
  }
  const payoutKey = xOnly(decoded.vtxoTaprootKey);
  return {
    pubkey: bytesToHex(payoutKey),
    pkScript: bytesToHex(decoded.pkScript),
    address: decoded.encode(),
    payoutKey,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  };
}

/** Address finalize pays the premium to, for an older stored key. */
export async function writerPayoutAddress(writerHex: string): Promise<string> {
  const writer = SingleKey.fromHex(writerHex);
  const { client } = await openSession(writer);
  await assertServerExit();
  const pubkey = await writer.xOnlyPublicKey();
  const script = payoutVtxo(pubkey, client.serverKey, EXIT);
  return script.address(networks.mutinynet.hrp, xOnly(client.serverKey)).encode();
}

async function build(req: FundRequest) {
  if (isPredict(req.kind)) return buildPredict(req);
  if (!req.holderPkHex || !req.beaconTxidHex) {
    throw new Error("Selling needs a desk quote that names the beacon.");
  }
  let writerPk: Uint8Array;
  let payoutKey: Uint8Array | undefined;
  let serverKey: Uint8Array;
  let emulatorKey: Uint8Array;
  let identity: SingleKey;
  if (req.writerAddress) {
    const binding = await writerBinding(req.writerAddress);
    writerPk = binding.payoutKey;
    payoutKey = binding.payoutKey;
    serverKey = binding.serverKey;
    emulatorKey = binding.emulatorKey;
    identity = SingleKey.fromHex(sessionHex());
  } else if (req.writerHex) {
    identity = SingleKey.fromHex(req.writerHex);
    const { client } = await openSession(identity);
    if (!client.emulatorKey) throw new Error("The emulator key is missing.");
    await assertServerExit();
    writerPk = await identity.xOnlyPublicKey();
    serverKey = client.serverKey;
    emulatorKey = client.emulatorKey;
  } else {
    throw new Error("Paste your Arkade address first.");
  }
  const { client } = await openSession(identity);
  const holderPk = hexToBytes(req.holderPkHex);
  const beaconTxidHex = req.beaconTxidHex.toLowerCase();
  const beaconGidx = req.beaconGidx ?? 0;
  const exit = req.exit ?? EXIT;
  const terms: Terms = {
    kind: req.kind,
    strike: req.strike,
    collateral: req.collateral,
    premium: req.premium,
    expiry: req.expiry,
    deadline: req.deadline,
    exit,
    writerPk,
    payoutKey,
    holderPk,
    beacon: beaconIdOf(asset.AssetId.create(beaconTxidHex, beaconGidx)),
    readFee: BEACON_READ_FEE,
    serverKey,
    emulatorKey,
  };
  const bound = bindContracts(terms);
  const intent = client.contract(intentProgram(), bound.intent);
  const vault = client.contract(vaultProgram(), bound.vault);
  if (intent.address !== bound.intentAddress || vault.address !== bound.vaultAddress) {
    throw new Error("The contract address does not match the local derivation.");
  }
  return { bound, intent, vault, deskPk: holderPk, beaconTxidHex, beaconGidx, exit, client, terms };
}

/** Predict: the bettor holds, and their address is paid. The desk writes. */
async function buildPredict(req: FundRequest) {
  if (!req.writerPkHex || !req.beaconTxidHex) {
    throw new Error("A prediction needs a desk quote that names the beacon.");
  }
  if (!req.holderAddress) throw new Error("Paste your Arkade address first.");
  const binding = await writerBinding(req.holderAddress);
  const { client } = await openSession(SingleKey.fromHex(sessionHex()));
  const holderPk = binding.payoutKey;
  const writerPk = hexToBytes(req.writerPkHex);
  const beaconTxidHex = req.beaconTxidHex.toLowerCase();
  const beaconGidx = req.beaconGidx ?? 0;
  const exit = req.exit ?? EXIT;
  const terms: Terms = {
    kind: req.kind,
    strike: req.strike,
    collateral: req.collateral,
    premium: req.premium,
    expiry: req.expiry,
    deadline: req.deadline,
    exit,
    writerPk,
    holderPk,
    holderPayoutKey: binding.payoutKey,
    beacon: beaconIdOf(asset.AssetId.create(beaconTxidHex, beaconGidx)),
    readFee: BEACON_READ_FEE,
    serverKey: binding.serverKey,
    emulatorKey: binding.emulatorKey,
  };
  const bound = bindContracts(terms);
  const intent = client.contract(intentProgram(), bound.intent);
  const vault = client.contract(vaultProgramFor(req.kind), bound.vault);
  if (intent.address !== bound.intentAddress || vault.address !== bound.vaultAddress) {
    throw new Error("The contract address does not match the local derivation.");
  }
  return { bound, intent, vault, deskPk: writerPk, beaconTxidHex, beaconGidx, exit, client, terms };
}

/** The same contract the quote was built from, plus the connected Arkade client. */
export async function openContract(req: FundRequest) {
  const built = await build(req);
  if (!built.client.emulator || !built.client.emulatorKey || !built.client.indexer) {
    throw new Error("The emulator is missing.");
  }
  return built;
}

/**
 * Mutinynet address the user funds: the collateral a seller locks, or the
 * stake a bettor puts in. It stays theirs until the desk finalizes.
 */
export async function depositAddress(req: FundRequest): Promise<Deposit> {
  const { bound, deskPk, beaconTxidHex, beaconGidx, exit } = await build(req);
  const amount = isPredict(req.kind) ? req.premium : req.collateral;
  return {
    network: NETWORK_NAME,
    address: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    amountSats: amount,
    uri: paymentUri(bound.intentAddress, amount),
    holderPkHex: isPredict(req.kind) ? "" : bytesToHex(deskPk),
    writerPkHex: isPredict(req.kind) ? bytesToHex(deskPk) : "",
    beaconTxidHex,
    beaconGidx,
    exit: Number(exit),
  };
}

/** Store the intent with the contract manager and return its pkScript. */
export async function registerIntent(req: FundRequest): Promise<string> {
  const { intent } = await build(req);
  await intent.register();
  return bytesToHex(intent.pkScript);
}

export async function intentCoins(script: string): Promise<{ value: bigint; spent: boolean; spentBy: string; txid: string }[] | null> {
  const manager = await contracts();
  const [row] = await manager.getContractsWithVtxos({ script });
  if (!row) return null;
  return (row.vtxos ?? []).map((coin) => ({
    value: BigInt(coin.value),
    spent: Boolean(coin.isSpent || coin.spentBy),
    spentBy: coin.arkTxId || coin.spentBy || "",
    txid: coin.txid || "",
  }));
}

export async function onContractEvent(cb: (event: ContractEvent) => void): Promise<() => void> {
  const manager = await contracts();
  return manager.onContractEvent(cb);
}

/** After the deadline, cancel pays the whole coin back to the user's address. */
export async function cancelIntent(req: FundRequest): Promise<string> {
  const { intent, bound } = await build(req);
  const manager = await contracts();
  await intent.register().catch(() => undefined);
  await manager.refreshVtxos({ scripts: [bytesToHex(intent.pkScript)], after: 0 });
  const coins = await intent.getUtxos();
  const coin = coins[0];
  if (!coin) throw new Error("No coin on this address.");
  const sent = await intent.functions.cancel().from(coin).to(bound.userPkScript, BigInt(coin.value)).send();
  return sent.txid;
}
