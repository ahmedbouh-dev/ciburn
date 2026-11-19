import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, DEFAULT_OPTIONS } from "../src/analyze/index.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import type { FindingKind, RunnerOs } from "../src/types.ts";
import { makeDataset, sampleDataset } from "./fixtures/build.ts";

const report = analyze(sampleDataset(), DEFAULT_OPTIONS);

test("sample dataset shape", () => {
  const ds = sampleDataset();
  assert.equal(ds.repo, "acme/webapp");
  assert.ok(ds.runs.length >= 180 && ds.runs.length <= 240, `~200 runs, got ${ds.runs.length}`);
  assert.deepEqual(sampleDataset(), ds, "deterministic");
});

test("totals are consistent", () => {
  const t = report.totals;
  assert.equal(report.days, 14);
  assert.equal(t.runs, report.workflows.reduce((a, w) => a + w.runs, 0));
  assert.equal(t.jobs, report.workflows.reduce((a, w) => a + w.jobs, 0));
  const osSum = (Object.keys(t.byOs) as RunnerOs[]).reduce((a, k) => a + t.byOs[k].usd, 0);
  assert.ok(Math.abs(osSum - t.cost.usd) < 0.05);
  assert.ok(Math.abs(t.monthlyCost.usd - (t.cost.usd * 30) / 14) < 0.05, "monthly = value * 30 / days");
  assert.ok(t.wastedCost.usd > 0 && t.wastedCost.usd < t.cost.usd);
  assert.ok(t.queueHours > 0);
  assert.deepEqual(report.pricing, DEFAULT_PRICING);
});

test("lists are sorted and bounded", () => {
  const desc = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! >= x);
  assert.ok(desc(report.workflows.map((w) => w.cost.usd)));
  assert.ok(desc(report.jobs.map((j) => j.cost.usd)));
  assert.ok(desc(report.slowSteps.map((s) => s.totalSec)));
  assert.ok(report.slowSteps.length <= 15);
  assert.ok(desc(report.flaky.map((f) => f.flakyCount)));
  assert.ok(desc(report.findings.map((f) => f.monthlySavings.usd + f.devHoursSaved * report.devHourlyUsd)), "sorted by impact");
});

test("billing $ and developer hours stay separate", () => {
  assert.equal(report.devHourlyUsd, DEFAULT_OPTIONS.devHourlyUsd);
  const queue = report.findings.find((f) => f.kind === "long-queue")!;
  assert.equal(queue.monthlySavings.usd, 0, "queue time is not billed");
  assert.ok(queue.devHoursSaved >= 1);
  const flaky = report.findings.find((f) => f.kind === "flaky-job")!;
  assert.ok(flaky.devHoursSaved > 0);
  for (const f of report.findings) {
    assert.ok(Number.isFinite(f.devHoursSaved) && f.devHoursSaved >= 0);
    assert.doesNotMatch(f.detail, /included in the savings/);
  }
  // Billing savings never exceed what was actually billed (monthly).
  const billed = report.findings.reduce((a, f) => a + f.monthlySavings.usd, 0);
  assert.ok(billed < report.totals.monthlyCost.usd);
});

test("sample contains every planted phenomenon", () => {
  const kinds = new Set(report.findings.map((f) => f.kind));
  const expected: FindingKind[] = [
    "missing-concurrency",
    "flaky-job",
    "rerun-waste",
    "expensive-runner",
    "slow-step",
    "long-queue",
    "timeout",
    "schedule-noise",
  ];
  for (const k of expected) assert.ok(kinds.has(k), `missing ${k}`);
  assert.equal(report.flaky[0]?.jobName, "e2e");
  const mac = report.jobs.find((j) => j.jobName === "test (macos-latest)");
  assert.equal(mac?.os, "macos");
});

test("every finding is specific and actionable", () => {
  for (const f of report.findings) {
    assert.match(f.title, /`[^`]+`/, f.title);
    assert.match(f.detail, /\d/, "detail contains numbers");
    assert.ok(f.fix.length > 30);
    assert.ok(f.evidence.length >= 1 && f.evidence.length <= 5);
    assert.ok(f.evidence.every((u) => u.startsWith("https://github.com/acme/webapp/actions/runs/")));
    assert.ok(["high", "medium", "low"].includes(f.severity));
  }
  const kinds = report.findings.map((f) => `${f.kind}:${f.title}`);
  assert.equal(new Set(kinds).size, kinds.length, "no duplicate findings");
});

test("workflow stats", () => {
  const ci = report.workflows.find((w) => w.workflowName === "CI")!;
  assert.ok(ci.successRate > 0.8 && ci.successRate <= 1);
  assert.ok(ci.p50DurationSec > 300 && ci.p95DurationSec >= ci.p50DurationSec);
  assert.notEqual(ci.costTrend, null);
  const scan = report.workflows.find((w) => w.workflowName === "Security Scan")!;
  assert.ok(scan.successRate < 0.5);
});

test("empty dataset produces an empty but valid report", () => {
  const r = analyze(makeDataset([], { since: "2026-11-01T00:00:00Z", until: "2026-11-15T00:00:00Z" }), DEFAULT_OPTIONS);
  assert.equal(r.totals.runs, 0);
  assert.equal(r.totals.cost.usd, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.workflows, []);
});
