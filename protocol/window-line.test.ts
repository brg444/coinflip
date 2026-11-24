import assert from "node:assert/strict";
import test from "node:test";

import { openingSample, WINDOW_LINE_WITHIN_S, windowOpen } from "./window-line.ts";

test("a window opened one grid step before it closes", () => {
  assert.equal(windowOpen(1_800_000_300), 1_800_000_000);
});

test("a window's line is the first sample at or after it opened", () => {
  const open = 1_800_000_000;
  const samples = [
    { time: open - 5, price: "6000000" },
    { time: open + 22, price: "6000100" },
    { time: open + 47, price: "6000200" },
  ];
  assert.equal(openingSample(samples, open)?.price, "6000100");
  assert.equal(openingSample([...samples].reverse(), open)?.price, "6000100", "order does not matter");
});

test("no line before the oracle has a sample in the window, nor from a sample long after", () => {
  const open = 1_800_000_000;
  assert.equal(openingSample([{ time: open - 1, price: "1" }], open), null);
  assert.equal(openingSample([{ time: open + WINDOW_LINE_WITHIN_S + 1, price: "1" }], open), null);
  assert.equal(openingSample([{ time: open + WINDOW_LINE_WITHIN_S, price: "7" }], open)?.price, "7");
});
