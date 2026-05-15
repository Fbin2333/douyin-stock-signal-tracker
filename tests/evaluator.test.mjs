import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMention } from "../src/lib/evaluator.mjs";

test("uses next trading day open as baseline and max close in 4-day window", () => {
  const mention = {
    id: 1,
    symbol: "002639.SZ",
    comment_date: "2026-04-02"
  };
  const bars = [
    { date: "2026-04-02", open: 18.86, high: 20.3, low: 18.6, close: 19.8 },
    { date: "2026-04-03", open: 19.81, high: 20.99, low: 19.36, close: 20.55 },
    { date: "2026-04-07", open: 20.18, high: 21.57, low: 19.73, close: 20.91 },
    { date: "2026-04-08", open: 20.5, high: 21.41, low: 20.29, close: 20.67 },
    { date: "2026-04-09", open: 20.4, high: 20.69, low: 19.55, close: 19.55 }
  ];

  const result = evaluateMention(mention, bars);
  assert.equal(result.status, "completed");
  assert.equal(result.baseline_date, "2026-04-03");
  assert.equal(result.baseline_open, 19.81);
  assert.equal(result.max_close_date, "2026-04-07");
  assert.equal(result.is_win, 1);
  assert.equal(Number(result.max_close_return_pct.toFixed(2)), 5.55);
});

test("marks mention pending when fewer than four future trading days exist", () => {
  const mention = {
    id: 1,
    symbol: "002639.SZ",
    comment_date: "2026-04-28"
  };
  const bars = [
    { date: "2026-04-29", open: 17.53, high: 17.87, low: 17.35, close: 17.66 }
  ];

  const result = evaluateMention(mention, bars);
  assert.equal(result.status, "pending");
  assert.equal(result.baseline_date, "2026-04-29");
});
