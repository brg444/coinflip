import assert from "node:assert/strict";
import test from "node:test";

import { base64 } from "@scure/base";
import { buildOffchainTx, SingleKey, Transaction, type ArkTxInput, type IndexerProvider } from "@arkade-os/sdk";

import { EXIT } from "../protocol/constants.ts";
import { payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { cosignCheckpoint, finalizeDeskSpends, pendingOutpoints, settleEmulatorTx } from "./finalize.ts";

const SERVER = "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a";

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

test("cosign adds the desk signature on its checkpoint and leaves the other input alone", async () => {
  const desk = key(2);
  const foreignKey = key(4);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const foreign = payoutVtxo(await foreignKey.xOnlyPublicKey(), server, EXIT);
  const { checkpoints } = buildOffchainTx(
    [
      {
        txid: "aa".repeat(32),
        vout: 0,
        value: 20_000,
        tapLeafScript: foreign.forfeit(),
        tapTree: foreign.encode(),
      } as unknown as ArkTxInput,
      {
        txid: "bb".repeat(32),
        vout: 1,
        value: 1_000,
        tapLeafScript: script.forfeit(),
        tapTree: script.encode(),
      } as unknown as ArkTxInput,
    ],
    [{ script: script.pkScript, amount: 21_000n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const foreignPsbt = base64.encode(checkpoints[0]!.toPSBT());
  const owned = base64.encode(checkpoints[1]!.toPSBT());
  const kept = await cosignCheckpoint(desk, script.pkScript, foreignPsbt);
  const signed = await cosignCheckpoint(desk, script.pkScript, owned);
  assert.equal(kept, foreignPsbt);
  const before = Transaction.fromPSBT(base64.decode(owned)).getInput(0).tapScriptSig?.length ?? 0;
  const after = Transaction.fromPSBT(base64.decode(signed)).getInput(0).tapScriptSig?.length ?? 0;
  assert.equal(before, 0);
  assert.equal(after, 1);
  assert.equal(bytesToHex(script.pkScript).length, 68);
});

test("finalizeDeskSpends proves the pending coin and finalizes the server checkpoints", async () => {
  const desk = key(3);
  const holderPk = await desk.xOnlyPublicKey();
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(holderPk, server, EXIT);
  const { checkpoints } = buildOffchainTx(
    [{
      txid: "cc".repeat(32),
      vout: 2,
      value: 40_633,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 40_633n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const raw = base64.encode(checkpoints[0]!.toPSBT());
  let proved = false;
  const finalized: string[][] = [];
  const done = await finalizeDeskSpends({
    identity: desk,
    deskScript: script,
    indexer: {
      async getVtxos(filter) {
        assert.ok(filter);
        assert.equal(filter.pendingOnly, true);
        assert.deepEqual(filter.scripts, [bytesToHex(script.pkScript)]);
        return { vtxos: [{ txid: "cc".repeat(32), vout: 2, value: 40_633, isSpent: true }] };
      },
      async getVirtualTxs() {
        throw new Error("indexer fallback is for an empty pending list");
      },
    } as Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ark: {
      async getPendingTxs(intent) {
        assert.equal(intent.message.type, "get-pending-tx");
        assert.equal(intent.message.expire_at, 0);
        const proof = Transaction.fromPSBT(base64.decode(intent.proof));
        assert.ok((proof.getInput(0).tapScriptSig?.length ?? 0) > 0);
        proved = true;
        return [{ arkTxid: "dd".repeat(32), signedCheckpointTxs: [raw] }];
      },
      async finalizeTx(arkTxid, txs) {
        finalized.push([arkTxid, ...txs]);
      },
    },
  });
  assert.equal(proved, true);
  assert.deepEqual(done, ["dd".repeat(32)]);
  const signed = Transaction.fromPSBT(base64.decode(finalized[0]![1]!));
  assert.equal(signed.getInput(0).tapScriptSig?.length, 1);
});

test("an empty pending list is finalized from the indexer virtual txs", async () => {
  const desk = key(5);
  const foreignKey = key(6);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const foreign = payoutVtxo(await foreignKey.xOnlyPublicKey(), server, EXIT);
  const { arkTx, checkpoints } = buildOffchainTx(
    [
      {
        txid: "ee".repeat(32),
        vout: 0,
        value: 100_000,
        tapLeafScript: foreign.forfeit(),
        tapTree: foreign.encode(),
      } as unknown as ArkTxInput,
      {
        txid: "ff".repeat(32),
        vout: 1,
        value: 40_633,
        tapLeafScript: script.forfeit(),
        tapTree: script.encode(),
      } as unknown as ArkTxInput,
    ],
    [{ script: script.pkScript, amount: 140_633n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const byId = new Map<string, string>([
    [arkTx.id, base64.encode(arkTx.toPSBT())],
    ...checkpoints.map((tx) => [tx.id, base64.encode(tx.toPSBT())] as const),
  ]);
  const finalized: string[][] = [];
  const done = await finalizeDeskSpends({
    identity: desk,
    deskScript: script,
    indexer: {
      async getVtxos() {
        return {
          vtxos: [{
            txid: "ff".repeat(32),
            vout: 1,
            value: 40_633,
            isSpent: true,
            arkTxId: arkTx.id,
          }],
        };
      },
      async getVirtualTxs(ids) {
        // Mutinynet returns these sorted by txid, not in request order.
        return { txs: ids.map((id) => byId.get(id) ?? "").reverse() };
      },
    } as Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ark: {
      async getPendingTxs() {
        return [];
      },
      async finalizeTx(arkTxid, txs) {
        finalized.push([arkTxid, ...txs]);
      },
    },
  });
  assert.deepEqual(done, [arkTx.id]);
  assert.equal(finalized[0]![0], arkTx.id);
  assert.equal(finalized[0]!.length, 3);
  const foreignSigned = Transaction.fromPSBT(base64.decode(finalized[0]![1]!));
  const deskSigned = Transaction.fromPSBT(base64.decode(finalized[0]![2]!));
  assert.equal(foreignSigned.id, checkpoints[0]!.id);
  assert.equal(deskSigned.id, checkpoints[1]!.id);
  assert.equal(foreignSigned.getInput(0).tapScriptSig?.length ?? 0, 0);
  assert.equal(deskSigned.getInput(0).tapScriptSig?.length, 1);
});

test("a missing offchain row is submitted again and then finalized", async () => {
  const desk = key(7);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{
      txid: "ab".repeat(32),
      vout: 0,
      value: 40_633,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 40_633n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const arkRaw = base64.encode(arkTx.toPSBT());
  const checkpointRaw = base64.encode(checkpoints[0]!.toPSBT());
  const byId = new Map([[arkTx.id, arkRaw], [checkpoints[0]!.id, checkpointRaw]]);
  const submitted: string[] = [];
  const finalized: string[][] = [];
  let attempts = 0;
  const done = await finalizeDeskSpends({
    identity: desk,
    deskScript: script,
    indexer: {
      async getVtxos() {
        return { vtxos: [{ txid: "ab".repeat(32), vout: 0, value: 40_633, isSpent: true, arkTxId: arkTx.id }] };
      },
      async getVirtualTxs(ids) {
        return { txs: ids.map((id) => byId.get(id) ?? "") };
      },
    } as Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ark: {
      async getPendingTxs() {
        return [];
      },
      async finalizeTx(arkTxid, txs) {
        attempts += 1;
        if (attempts === 1) throw new Error(`TX_NOT_FOUND (19): offchain tx ${arkTxid} not found`);
        finalized.push([arkTxid, ...txs]);
      },
      async submitTx(signedArkTx, checkpointTxs) {
        submitted.push(signedArkTx, ...checkpointTxs);
        return { arkTxid: arkTx.id, signedCheckpointTxs: [checkpointRaw] };
      },
    },
  });
  assert.deepEqual(done, [arkTx.id]);
  assert.equal(submitted[0], arkRaw);
  assert.equal(Transaction.fromPSBT(base64.decode(submitted[1]!)).id, checkpoints[0]!.id);
  const signed = Transaction.fromPSBT(base64.decode(finalized[0]![1]!));
  assert.equal(signed.getInput(0).tapScriptSig?.length, 1);
});

test("an already-spent input is not submitted again or left pending", async () => {
  const desk = key(8);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{
      txid: "cd".repeat(32),
      vout: 0,
      value: 40_633,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 40_633n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const byId = new Map([
    [arkTx.id, base64.encode(arkTx.toPSBT())],
    [checkpoints[0]!.id, base64.encode(checkpoints[0]!.toPSBT())],
  ]);
  let submits = 0;
  let pendingReads = 0;
  const refreshed: string[] = [];
  const opts = {
    identity: desk,
    deskScript: script,
    async reconcileSpent(outpoints: { txid: string; vout: number }[]) {
      refreshed.push(...outpoints.map((coin) => `${coin.txid}:${coin.vout}`));
    },
    indexer: {
      async getVtxos() {
        return { vtxos: [{ txid: "cd".repeat(32), vout: 0, value: 40_633, isSpent: true, arkTxId: arkTx.id }] };
      },
      async getVirtualTxs(ids: string[]) {
        return { txs: ids.map((id) => byId.get(id) ?? "") };
      },
    } as Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">,
    ark: {
      async getPendingTxs() {
        pendingReads += 1;
        return [];
      },
      async finalizeTx() {
        throw new Error(`TX_NOT_FOUND (19): offchain tx ${arkTx.id} not found`);
      },
      async submitTx() {
        submits += 1;
        throw new Error("VTXO_ALREADY_SPENT (6): cdcdcdcd:0 already spent");
      },
    },
  };
  assert.deepEqual(await finalizeDeskSpends(opts), []);
  assert.deepEqual(refreshed, [`${"cd".repeat(32)}:0`]);
  assert.equal((await pendingOutpoints(opts.indexer, script)).size, 0);
  assert.deepEqual(await finalizeDeskSpends(opts), []);
  assert.equal(submits, 1);
  assert.equal(pendingReads, 1);
  assert.deepEqual(refreshed, [`${"cd".repeat(32)}:0`]);
});

test("settleEmulatorTx finalizes the package send() returned, and submits it when arkd has no row", async () => {
  const desk = key(5);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{
      txid: "ee".repeat(32),
      vout: 0,
      value: 1_000,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 1_000n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const signedArkTx = base64.encode(arkTx.toPSBT());
  const checkpoint = base64.encode(checkpoints[0]!.toPSBT());
  const finalized: string[] = [];
  let submits = 0;
  const done = await settleEmulatorTx({
    identity: desk,
    deskScript: script,
    txid: arkTx.id,
    signedArkTx,
    signedCheckpointTxs: [checkpoint],
    ark: {
      async getPendingTxs() {
        return [];
      },
      async finalizeTx(arkTxid, txs) {
        if (finalized.length === 0) throw new Error(`TX_NOT_FOUND (19): offchain tx ${arkTxid} not found`);
        finalized.push(arkTxid);
        assert.equal(txs.length, 1);
        const sigs = Transaction.fromPSBT(base64.decode(txs[0]!)).getInput(0).tapScriptSig?.length ?? 0;
        assert.equal(sigs, 1);
      },
      async submitTx(raw, txs) {
        submits += 1;
        assert.equal(raw, signedArkTx);
        assert.equal(txs.length, 1);
        finalized.push("submitted");
        return { arkTxid: arkTx.id, signedCheckpointTxs: [checkpoint] };
      },
    },
  });
  assert.equal(done, true);
  assert.equal(submits, 1);
  assert.deepEqual(finalized, ["submitted", arkTx.id]);
});

test("settleEmulatorTx treats an already-finalized package as done", async () => {
  const desk = key(5);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{
      txid: "ee".repeat(32),
      vout: 0,
      value: 1_000,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 1_000n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  let submits = 0;
  const done = await settleEmulatorTx({
    identity: desk,
    deskScript: script,
    txid: arkTx.id,
    signedArkTx: base64.encode(arkTx.toPSBT()),
    signedCheckpointTxs: [base64.encode(checkpoints[0]!.toPSBT())],
    ark: {
      async getPendingTxs() {
        return [];
      },
      async finalizeTx() {
        throw new Error("INTERNAL_ERROR (0): failed to finalize offchain tx: not in a valid stage to finalize offchain tx");
      },
      async submitTx() {
        submits += 1;
        return { arkTxid: arkTx.id, signedCheckpointTxs: [] };
      },
    },
  });
  assert.equal(done, true);
  assert.equal(submits, 0);
});
