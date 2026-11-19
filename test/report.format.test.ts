import { test } from "node:test";
import assert from "node:assert/strict";
import { duration, minutes, pct, splitFences, trend, usd } from "../src/report/format.ts";

test("usd formats whole dollars, cents and tiny amounts", () => {
  assert.equal(usd(1234.4), "$1,234");
  assert.equal(usd(12.4), "$12.40");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0), "$0");
  assert.equal(usd(-5), "-$5.00");
});

test("duration uses s / m s / h m", () => {
  assert.equal(duration(42), "42s");
  assert.equal(duration(190), "3m 10s");
  assert.equal(duration(185), "3m 05s");
  assert.equal(duration(3900), "1h 05m");
  assert.equal(duration(120), "2m");
});

test("pct, trend, minutes", () => {
  assert.equal(pct(0.256), "26%");
  assert.equal(pct(0.001), "<1%");
  assert.equal(pct(0), "0%");
  assert.equal(trend(0.18), "+18%");
  assert.equal(trend(-0.05), "-5%");
  assert.equal(trend(null), "–");
  assert.equal(minutes(12345.2), "12,345 min");
});

test("splitFences separates prose and code", () => {
  const segs = splitFences("Add this:\n\n```yaml\na: 1\nb: 2\n```\nDone.");
  assert.deepEqual(segs.map((s) => s.type), ["text", "code", "text"]);
  assert.deepEqual(segs[1], { type: "code", lang: "yaml", code: "a: 1\nb: 2" });
});

test("hours, impact sorting and savings parts keep $ and dev time apart", async () => {
  const { hours, savingsParts, sortFindings, totalDevHours, totalSavings, stripEmphasis } = await import("../src/report/format.ts");
  const { sampleReport } = await import("./fixtures/sample-report.ts");
  assert.equal(hours(38.2), "38h");
  assert.equal(hours(2.46), "2.5h");
  assert.equal(hours(0.01), "<0.1h");
  const base = sampleReport.findings[0]!;
  assert.deepEqual(savingsParts({ ...base, monthlySavings: { usd: 2.27, minutes: 1 }, devHoursSaved: 30 }), ["$2.27/mo", "30h dev time/mo"]);
  assert.deepEqual(savingsParts({ ...base, monthlySavings: { usd: 0, minutes: 0 }, devHoursSaved: 6 }), ["6h dev time/mo"]);
  // Hours-only finding outranks a $281 one at $100/h, but totals stay separate.
  const sorted = sortFindings(sampleReport);
  assert.equal(sorted[0]!.kind, "long-queue");
  assert.equal(Math.round(totalSavings(sampleReport.findings) * 10) / 10, 513.4);
  assert.equal(totalDevHours(sampleReport.findings), 14);
  assert.equal(stripEmphasis("use **Re-run failed jobs** now"), "use Re-run failed jobs now");
});
