import assert from "node:assert/strict";
import test from "node:test";

import {
  amount,
  betFault,
  btcAmount,
  clipDetail,
  fmtBtc,
  hhmm,
  int,
  lineNote,
  lineTag,
  mmss,
  parseStake,
  parseUsd,
  shortAddress,
  shortAddress12,
  timesX,
  usd0,
  usd2,
  usdFig,
  usdLine,
  usdStake,
  utcTime,
  whenDay,
  worth,
} from "./format.ts";

test("BTC and satoshi formatters handle whole, fractional, negative, and threshold values", () => {
  assert.equal(btcAmount(0n), "0");
  assert.equal(btcAmount(50_000n), "0.0005");
  assert.equal(btcAmount(100_000_000n), "1");
  assert.equal(fmtBtc(-50_000n), "-0.0005");
  assert.equal(int(1_234_567n), "1,234,567");
  assert.equal(amount(99_999n), "99,999 sats");
  assert.equal(amount(100_000n), "₿0.001");
  assert.equal(timesX(1.9), "1.90×");
});

test("USD formatters and stake/USD parsers validate precision and bounds", () => {
  assert.equal(usd0(91_234.6), "$91,235");
  assert.equal(usd2(91_234.5), "$91,234.50");
  assert.equal(usdLine(91_200), "$91,200");
  assert.equal(usdLine(91_200.25), "$91,200.25");
  assert.equal(usdFig(125.4), "$125");
  assert.equal(usdFig(12.5), "$12.50");
  assert.equal(usdStake(25), "$25");
  assert.equal(usdStake(12.5), "$12.50");
  assert.equal(worth(100_000_000n, 90_000), 90_000);

  assert.equal(parseUsd("25"), 25);
  assert.equal(parseUsd("$1,250.50"), 1250.5);
  assert.equal(parseUsd("0"), null);
  assert.equal(parseUsd("12.345"), null);
  assert.equal(parseUsd("-5"), null);

  assert.equal(parseStake("0.0005"), 50_000n);
  assert.equal(parseStake("0,001"), 100_000n);
  assert.equal(parseStake("1.00000000"), 100_000_000n);
  assert.equal(parseStake("0.000000001"), null);
  assert.equal(parseStake("abc"), null);
});

test("time, address, line step, detail redaction, and desk fault helpers stay predictable", () => {
  assert.equal(mmss(125), "2:05");
  assert.equal(hhmm(new Date(Date.UTC(2026, 9, 2, 8, 5, 0))), "08:05");
  assert.equal(utcTime(Date.UTC(2026, 9, 2, 8, 5, 0) / 1000), "08:05 UTC");
  assert.equal(whenDay(Date.UTC(2026, 9, 2, 8, 5, 0) / 1000), "Oct 2");

  const addr = "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxs";
  assert.equal(shortAddress(addr), "ark1qzpq904a…dttuxs");
  assert.equal(shortAddress12(addr), "ark1qzpq904a…wfdttuxs");
  assert.equal(shortAddress("short"), "short");

  assert.equal(lineNote(0), "Current price");
  assert.equal(lineNote(50), "$50 above current price");
  assert.equal(lineNote(-100), "$100 under current price");
  assert.equal(lineTag(0), "now");
  assert.equal(lineTag(50), "+$50");
  assert.equal(lineTag(-50), "−$50");

  assert.equal(clipDetail("  Authorization: Bearer supersecret123\nsecond line"), "Authorization: Bearer …");
  assert.equal(clipDetail("Bearer supersecret123"), "Bearer …");
  assert.equal(clipDetail("token=abc12345"), "token …");

  const [sentence, detail] = betFault("refused: stake", 10_000n, 100_000n);
  assert.equal(sentence, "Stake between 0.0001 and 0.001 BTC.");
  assert.equal(detail, "refused: stake");
  assert.match(betFault("float short", 10_000n, 100_000n)[0], /cover this payout/i);
});
