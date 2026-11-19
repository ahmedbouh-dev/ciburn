import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDuration, money, percentile, round } from "../src/analyze/stats.ts";

test("percentile: edge cases", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 95), 7);
});

test("percentile: linear interpolation", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5, "input order does not matter");
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(round(percentile(hundred, 95), 2), 95.05);
  assert.equal(percentile(hundred, 0), 1);
  assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile(hundred, 150), 100, "clamped");
});

test("percentile does not mutate input", () => {
  const xs = [3, 1, 2];
  percentile(xs, 50);
  assert.deepEqual(xs, [3, 1, 2]);
});

test("money rounds usd to cents", () => {
  assert.deepEqual(money(10.04, 1.23456), { minutes: 10, usd: 1.23 });
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(150), "2.5 min");
  assert.equal(fmtDuration(7200), "2 h");
});
