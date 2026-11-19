import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { analyze, DEFAULT_OPTIONS } from "../src/analyze/index.ts";
import type { Run } from "../src/types.ts";
import { makeDataset, makeRun, resetIds } from "./fixtures/build.ts";
import type { JobSpec } from "./fixtures/build.ts";

const T0 = Date.parse("2026-11-02T09:00:00Z");
const MIN = 60_000;
const window30 = { since: "2026-11-01T00:00:00Z", until: "2026-12-01T00:00:00Z" };
const run = (minute: number, sha: string, jobs: JobSpec[]) =>
  makeRun({ createdAt: T0 + minute * MIN, headSha: sha, headBranch: `b-${sha}`, jobs });
const e2e = (conclusion: string, attempt = 1, offsetSec = 0): JobSpec => ({
  name: "e2e",
  conclusion,
  runAttempt: attempt,
  offsetSec,
  steps: [
    { name: "Set up job", sec: 2 },
    { name: "Run npx playwright test", sec: 1800 },
    { name: "Complete job", sec: 1 },
  ],
});
const analyzeRuns = (runs: Run[]) => analyze(makeDataset(runs, window30), DEFAULT_OPTIONS);

beforeEach(() => resetIds());

/** n clean commits plus the given runs. */
function withCleanCommits(n: number, extra: Run[]): Run[] {
  const runs = [...extra];
  for (let i = 0; i < n; i++) runs.push(run(1000 + i * 60, `clean${i}`, [e2e("success")]));
  return runs;
}

test("fail -> pass across attempts on the same sha is flaky", () => {
  const runs = withCleanCommits(8, [
    run(0, "a", [e2e("failure", 1), e2e("success", 2, 1800)]),
    run(100, "b", [e2e("failure", 1), e2e("success", 2, 1800)]),
  ]);
  const r = analyzeRuns(runs);
  assert.equal(r.flaky.length, 1);
  const f = r.flaky[0]!;
  assert.equal(f.jobName, "e2e");
  assert.equal(f.flakyCount, 2);
  assert.equal(f.occurrences, 10);
  assert.equal(f.flakeRate, 0.2);
  // Each failed attempt: 1803s -> 31 billable min at $0.006
  assert.deepEqual(f.wastedCost, { minutes: 62, usd: 0.37 });
  assert.equal(f.examples.length, 2);

  const finding = r.findings.find((x) => x.kind === "flaky-job");
  assert.ok(finding, "flaky finding emitted");
  assert.match(finding.title, /`CI` › `e2e`/);
  assert.match(finding.detail, /`Run npx playwright test`/);
  assert.match(finding.fix, /playwright\.config\.ts/);
  // $ is billing only; developer waiting (2 green retries x 1803s) is separate.
  assert.deepEqual(finding.monthlySavings, f.wastedCost);
  assert.equal(finding.devHoursSaved, 1);
  assert.doesNotMatch(finding.detail, /included in the savings/);
});

test("framework snippet only when the FAILING step names it (regression: vitejs/vite)", () => {
  // Job installs Playwright, but flakes in "Test serve": that's no evidence for Playwright config.
  const job = (conclusion: string, attempt = 1, offsetSec = 0): JobSpec => ({
    name: "Build&Test: node-26, windows-latest",
    labels: ["windows-latest"],
    conclusion,
    runAttempt: attempt,
    offsetSec,
    steps: [
      { name: "Install Playwright", sec: 60 },
      { name: "Test unit", sec: 60, conclusion: "success" },
      { name: "Test serve", sec: 1800 },
    ],
  });
  const runs: Run[] = [];
  for (let i = 0; i < 3; i++) runs.push(run(i * 100, `f${i}`, [job("failure"), job("success", 2, 2400)]));
  for (let i = 0; i < 10; i++) runs.push(run(1000 + i * 60, `ok${i}`, [job("success")]));
  const f = analyzeRuns(runs).findings.find((x) => x.kind === "flaky-job")!;
  assert.ok(f);
  assert.match(f.detail, /`Test serve`/);
  assert.doesNotMatch(f.fix, /playwright|vitest|jest|cypress|pytest/i);
  assert.match(f.fix, /nick-fields\/retry/);
});

test("fail in one run, pass in a later run on the same sha is flaky", () => {
  const runs = withCleanCommits(5, [run(0, "x", [e2e("failure")]), run(30, "x", [e2e("success")]), run(60, "y", [e2e("timed_out")]), run(90, "y", [e2e("success")])]);
  const r = analyzeRuns(runs);
  assert.equal(r.flaky[0]?.flakyCount, 2);
});

test("not flaky: fail->fail, pass->fail, different shas", () => {
  const runs = [
    run(0, "a", [e2e("failure", 1), e2e("failure", 2, 1800)]),
    run(100, "b", [e2e("success"), e2e("failure", 2, 1800)]),
    run(200, "c", [e2e("failure")]),
    run(300, "d", [e2e("success")]),
    run(400, "e", [e2e("cancelled", 1), e2e("success", 2, 900)]),
  ];
  const r = analyzeRuns(runs);
  assert.equal(r.flaky.length, 0);
  assert.equal(r.findings.filter((f) => f.kind === "flaky-job").length, 0);
});

test("flaky finding needs >= 5% flake rate and >= 2 occurrences", () => {
  // 1 occurrence only
  let r = analyzeRuns(withCleanCommits(3, [run(0, "a", [e2e("failure", 1), e2e("success", 2, 1800)])]));
  assert.equal(r.flaky.length, 1);
  assert.equal(r.findings.filter((f) => f.kind === "flaky-job").length, 0);
  // 2 occurrences but 2/60 = 3.3%
  resetIds();
  r = analyzeRuns(
    withCleanCommits(58, [
      run(0, "a", [e2e("failure", 1), e2e("success", 2, 1800)]),
      run(100, "b", [e2e("failure", 1), e2e("success", 2, 1800)]),
    ]),
  );
  assert.equal(r.flaky[0]?.flakyCount, 2);
  assert.equal(r.findings.filter((f) => f.kind === "flaky-job").length, 0);
});
