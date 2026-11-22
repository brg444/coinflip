import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_BEACON_STATUS } from "./beacon-status.ts";
import { quoteMatchesBeacon } from "./rfq.ts";

test("quoteMatchesBeacon accepts only the pinned beacon txid and group index", () => {
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid.toUpperCase(), 0), true);
  assert.equal(quoteMatchesBeacon(LIVE_BEACON_STATUS.issueTxid, 1), false);
  assert.equal(quoteMatchesBeacon("00".repeat(32), 0), false);
  assert.equal(quoteMatchesBeacon("not-a-txid", 0), false);
});
