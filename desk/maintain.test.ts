import assert from "node:assert/strict";
import test from "node:test";

import { maintainDeskCoins } from "./maintain.ts";

test("startup finalizes pending spends, recovers swept coins, then renews", async () => {
  const calls: string[] = [];
  const maintained = await maintainDeskCoins({
    async markPending() {
      calls.push("markPending");
    },
    async finalizePendingTxs() {
      calls.push("finalizePendingTxs");
      return { finalized: ["aa".repeat(32)], pending: ["aa".repeat(32)] };
    },
    async refreshCoins() {
      calls.push("refreshCoins");
    },
    async recoverVtxos() {
      calls.push("recoverVtxos");
      return "recover-tx";
    },
    async renewVtxos() {
      calls.push("renewVtxos");
      return "renew-tx";
    },
  });
  assert.deepEqual(calls, [
    "markPending",
    "finalizePendingTxs",
    "refreshCoins",
    "recoverVtxos",
    "renewVtxos",
  ]);
  assert.deepEqual(maintained.finalized, ["aa".repeat(32)]);
  assert.equal(maintained.recovered, "recover-tx");
  assert.equal(maintained.renewed, "renew-tx");
});

test("startup still renews when recovery has nothing to settle", async () => {
  const calls: string[] = [];
  const maintained = await maintainDeskCoins({
    async markPending() {
      calls.push("markPending");
    },
    async finalizePendingTxs() {
      calls.push("finalizePendingTxs");
      return { finalized: [], pending: [] };
    },
    async refreshCoins() {
      calls.push("refreshCoins");
    },
    async recoverVtxos() {
      calls.push("recoverVtxos");
      throw new Error("No recoverable VTXOs found");
    },
    async renewVtxos() {
      calls.push("renewVtxos");
      throw new Error("No VTXOs available to renew");
    },
  });
  assert.deepEqual(calls, [
    "markPending",
    "finalizePendingTxs",
    "refreshCoins",
    "recoverVtxos",
    "renewVtxos",
  ]);
  assert.equal(maintained.recovered, null);
  assert.equal(maintained.renewed, null);
});

test("a failed recovery does not skip renewal", async () => {
  const calls: string[] = [];
  const maintained = await maintainDeskCoins({
    async markPending() {},
    async finalizePendingTxs() {
      return { finalized: [], pending: [] };
    },
    async refreshCoins() {},
    async recoverVtxos() {
      calls.push("recoverVtxos");
      throw new Error("VTXO_ALREADY_SPENT (6): aa:0 already spent");
    },
    async renewVtxos() {
      calls.push("renewVtxos");
      return "renew-tx";
    },
  });
  assert.deepEqual(calls, ["recoverVtxos", "renewVtxos"]);
  assert.equal(maintained.recovered, null);
  assert.equal(maintained.renewed, "renew-tx");
});
