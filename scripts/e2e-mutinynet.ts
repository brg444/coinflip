import { readFile } from "node:fs/promises";

import {
  arkade,
  asset,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon.ts";
import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { btcAmount } from "../app/src/fund.ts";
import { ARK_URL, BEACON_READ_FEE, EMULATOR_URL, EXIT } from "../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex, xOnly } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { intentProgram } from "../protocol/programs.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";

/**
 * Happy path. Defaults to Mutinynet. `ARK_URL` and `EMULATOR_URL` select the host;
 * the network (and its emulator key) come from arkd `/v1/info`.
 *
 *   pnpm e2e
 *     connects and prints the addresses to fund.
 *
 *   pnpm e2e -- --spend
 *     finalizes an intent that already holds collateral and cancels the second
 *     intent once its deadline has passed. Settlement needs a beacon fixing.
 *
 *   pnpm e2e -- --live
 *     spends the writer and desk keys in data/e2e-keys.json. The writer wallet
 *     funds both intents, the desk finalizes one, and the writer cancels the other.
 *
 * WRITER_KEY and DESK_KEY default to public test keys 1 and 2. BEACON_TXID is the beacon's display txid.
 */

const live = process.argv.includes("--live");
const spend = live || process.argv.includes("--spend");
const saved = live
  ? JSON.parse(await readFile(process.env.E2E_KEYS ?? "data/e2e-keys.json", "utf8")) as { writer: string; desk: string }
  : null;
const writerHex = saved?.writer ?? process.env.WRITER_KEY ?? "1".padStart(64, "0");
const deskHex = saved?.desk ?? process.env.DESK_KEY ?? "2".padStart(64, "0");
const collateral = 50_000n;
const premium = 1_000n;
const strike = 9_700_000n;

const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
const network = networkByName((await new RestArkProvider(arkUrl).getInfo()).network);

async function connect(identity: SingleKey) {
  return arkade.Arkade.connect({
    arkade: new RestArkProvider(arkUrl),
    indexer: new RestIndexerProvider(arkUrl),
    emulator: new RestEmulatorProvider(emulatorUrl),
    identity,
    network,
  });
}

const writer = SingleKey.fromHex(writerHex);
const desk = SingleKey.fromHex(deskHex);
const writerClient = await connect(writer);
const deskClient = await connect(desk);
if (!writerClient.emulatorKey || !deskClient.emulatorKey) {
  throw new Error("emulator key missing");
}

const now = BigInt(Math.floor(Date.now() / 1000));
const expiry = now + 86_400n;
const fillDeadline = now + 600n;
const cancelDeadline = now + 30n;
const writerPk = await writer.xOnlyPublicKey();
const holderPk = await desk.xOnlyPublicKey();
const beaconDisplay = (process.env.BEACON_TXID ?? "").trim().toLowerCase();
if (!beaconDisplay) throw new Error("BEACON_TXID is required");
const beaconGidx = Number(process.env.BEACON_GIDX ?? "0");
const shared = {
  kind: 0 as const,
  strike,
  collateral,
  premium,
  expiry,
  exit: EXIT,
  writerPk,
  holderPk,
  beacon: beaconIdOf(asset.AssetId.create(beaconDisplay, beaconGidx)),
  readFee: BEACON_READ_FEE,
  serverKey: writerClient.serverKey,
  emulatorKey: writerClient.emulatorKey,
};

const fill = bindContracts({ ...shared, deadline: fillDeadline });
const cancel = bindContracts({ ...shared, deadline: cancelDeadline });
await assertServerExit(arkUrl);
const deskScript = payoutVtxo(holderPk, deskClient.serverKey, EXIT);
const deskAddress = deskScript.address(network.hrp, xOnly(deskClient.serverKey)).encode();

console.log("writer", bytesToHex(writerPk));
console.log("desk", bytesToHex(holderPk));
console.log("desk address", deskAddress, `(fund at least ${btcAmount(premium)} BTC for the premium)`);
console.log("fill intent", fill.intentAddress, `(fund ${btcAmount(collateral)} BTC of collateral)`);
console.log("fill vault", fill.vaultAddress);
console.log("cancel intent", cancel.intentAddress, `(fund ${btcAmount(collateral)} BTC, refunds after ${cancelDeadline})`);

if (!spend) {
  console.log("Fund those addresses, then re-run with --spend.");
  process.exit(0);
}

function row(bound: typeof fill, deadline: bigint): QuoteRow {
  return {
    rfqId: "11".repeat(32),
    collateral: collateral.toString(),
    premium: premium.toString(),
    kind: 0,
    strike: strike.toString(),
    expiry: Number(expiry),
    deadline: Number(deadline),
    validUntil: Number(now + 30n),
    exit: Number(EXIT),
    writerPubkey: bytesToHex(writerPk),
    writerPkScript: bytesToHex(bound.writerPkScript),
    holderPubkey: bytesToHex(holderPk),
    beaconTxid: beaconDisplay,
    beaconGidx,
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: Number(now),
    clientPubkey: bytesToHex(writerPk),
  };
}

if (live) {
  const storage = await openSqliteStorage(process.env.DATA_DIR?.trim() || "data", "e2e.sqlite");
  const writerWallet = await Wallet.create({
    identity: writer,
    arkProvider: new RestArkProvider(arkUrl),
    indexerProvider: new RestIndexerProvider(arkUrl),
    settlementConfig: false,
    storage: {
      walletRepository: storage.walletRepository,
      contractRepository: storage.contractRepository,
    },
  });
  const funded = await writerWallet.send({
    recipients: [
      { address: fill.intentAddress, amount: Number(collateral) },
      { address: cancel.intentAddress, amount: Number(collateral) },
    ],
  });
  console.log("funded", funded);
}

async function waitForCoin(label: string, read: () => Promise<{ value: number }[]>, min: bigint) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const coins = await read();
    if (coins.some((coin) => BigInt(coin.value) >= min)) return;
    console.log(label, `not indexed yet (${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} was not indexed`);
}

const fillIntent = deskClient.contract(intentProgram(), fill.intent);
const cancelIntent = writerClient.contract(intentProgram(), cancel.intent);
await waitForCoin("fill intent", () => fillIntent.getUtxos(), collateral);
await waitForCoin("cancel intent", () => cancelIntent.getUtxos(), collateral);

const filled = await fillQuote({
  client: deskClient,
  deskScript,
  row: row(fill, fillDeadline),
  now: Number(now),
  ark: deskClient.arkProvider as RestArkProvider,
  termsFor: (item) => ({
    kind: 0,
    strike,
    collateral,
    premium,
    expiry,
    deadline: BigInt(item.deadline),
    exit: EXIT,
    writerPk,
    holderPk,
    beacon: beaconIdOf(asset.AssetId.create(beaconDisplay, beaconGidx)),
    serverKey: deskClient.serverKey,
    emulatorKey: deskClient.emulatorKey!,
  }),
});
console.log("finalize", filled.result, filled.txid ?? "");
if (filled.result !== "filled") throw new Error(`finalize ${filled.result}`);

const cancelContract = writerClient.contract(intentProgram(), cancel.intent);
const cancelCoins = await cancelContract.getUtxos();
if (cancelCoins.length === 0) {
  console.log("cancel waiting for a coin");
} else {
  const waitMs = Math.max(0, Number(cancelDeadline) * 1000 - Date.now() + 2_000);
  if (waitMs > 0) {
    console.log(`cancel waits ${Math.ceil(waitMs / 1000)}s for the deadline`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const coin = (await cancelContract.getUtxos())[0];
  if (!coin) {
    console.log("cancel coin already spent");
  } else {
    const sent = await cancelContract.functions.cancel().from(coin).to(cancel.writerPkScript, BigInt(coin.value)).send();
    console.log("cancel", sent.txid);
  }
}
process.exit(0);
