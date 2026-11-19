// Regression tests for false positives found by running ciburn on real repositories
// (vitejs/vite and facebook/react-native, 2026-11-19).

import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { analyze, DEFAULT_OPTIONS } from "../src/analyze/index.ts";
import { inferEco, matrixKey, platformSpecific } from "../src/analyze/findings.ts";
import { runnerOs } from "../src/pricing.ts";
import type { Finding, FindingKind, Run } from "../src/types.ts";
import { makeDataset, makeRun, resetIds } from "./fixtures/build.ts";
import type { JobSpec, RunSpec, StepSpec } from "./fixtures/build.ts";

const T0 = Date.parse("2026-11-02T09:00:00Z");
const MIN = 60_000;
const window30 = { since: "2026-11-01T00:00:00Z", until: "2026-12-01T00:00:00Z" };
const analyzeRuns = (runs: Run[], window = window30) => analyze(makeDataset(runs, window), DEFAULT_OPTIONS);
const kind = (runs: Run[], k: FindingKind): Finding[] => analyzeRuns(runs).findings.filter((f) => f.kind === k);
const at = (minute: number, spec: Omit<RunSpec, "createdAt">) => makeRun({ createdAt: T0 + minute * MIN, ...spec });
const steps = (...names: string[]): StepSpec[] => names.map((name) => ({ name, sec: 120 }));

beforeEach(() => resetIds());

describe("runner / platform classification", () => {
  test("custom macOS labels like xcode-27 are macOS, not linux", () => {
    assert.equal(runnerOs(["xcode-27"]), "macos");
    assert.equal(runnerOs(["macos-15"]), "macos");
    assert.equal(runnerOs(["4-core-ubuntu"]), "linux");
  });

  test("platformSpecific tokenizes job ids and ignores (non-windows) labels", () => {
    assert.equal(platformSpecific("test_e2e_ios_rntester / test (Release)"), true);
    assert.equal(platformSpecific("build-rn-slice (Debug, mac-catalyst)"), true);
    assert.equal(platformSpecific("(non-windows) Set Playwright path"), false);
    assert.equal(platformSpecific("Build&Test: node-26 Test unit Test serve"), false);
    assert.equal(platformSpecific("Run xcodebuild test"), true);
  });

  test("matrixKey only pairs runner-label legs", () => {
    assert.equal(matrixKey("Build&Test: node-26, macos-latest"), "Build&Test: node-26, <os>");
    assert.equal(matrixKey("Build&Test: node-26, ubuntu-latest"), "Build&Test: node-26, <os>");
    assert.equal(matrixKey("test (windows-2022)"), "test (<os>)");
    assert.equal(matrixKey("build-rn-slice (Debug, ios-simulator)"), null, "build variant, not an OS leg");
  });
});

describe("expensive-runner", () => {
  test("comma-style matrix leg is detected; skipped (windows)/(non-windows) steps are no evidence (vite)", () => {
    const leg = (os: string, labels: string[], sec: number): JobSpec => ({
      name: `Build&Test: node-26, ${os}`,
      labels,
      steps: [
        { name: "(non-windows) Set Playwright path", sec: 2 },
        { name: "(windows) Set Playwright path", sec: 0, conclusion: "skipped" },
        { name: "Test unit", sec },
      ],
    });
    const runs = Array.from({ length: 10 }, (_, i) =>
      at(i * 60, { headBranch: `b${i}`, jobs: [leg("ubuntu-latest", ["ubuntu-latest"], 300), leg("macos-latest", ["macos-latest"], 600)] }),
    );
    const f = kind(runs, "expensive-runner")[0];
    assert.ok(f, "macOS leg flagged");
    assert.match(f.title, /macOS matrix leg/);
    assert.match(f.detail, /`Build&Test: node-26, ubuntu-latest`/);
  });

  test("iOS work with underscore job ids is not suggested for linux (react-native)", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [
          { name: "test_e2e_ios_rntester / test (Release)", labels: ["macos-15"], steps: steps("Setup node.js", "Run yarn", "Run E2E Tests") },
          { name: "prebuild / build-rn-slice (Debug, ios-simulator)", labels: ["xcode-27"], steps: steps("Build") },
          { name: "prebuild / build-rn-slice (Debug, mac-catalyst)", labels: ["macos-15"], steps: steps("Build") },
        ],
      }),
    );
    assert.equal(kind(runs, "expensive-runner").length, 0);
  });

  test("skipped jobs with labels [] are not a 'linux leg'", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [
          { name: "test (ubuntu-latest)", labels: [], conclusion: "skipped" },
          { name: "test (macos-latest)", labels: ["macos-latest"], durationSec: 600, steps: steps("Run npm test") },
        ],
      }),
    );
    const f = kind(runs, "expensive-runner")[0];
    assert.ok(f);
    assert.doesNotMatch(f.title, /matrix leg/, "falls back to the move-to-linux finding");
  });
});

describe("slow-step", () => {
  const ci = (n: number, stepNames: string[], installName: string, installSec = 90) =>
    Array.from({ length: n }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [{ name: "test", steps: [...stepNames.map((name) => ({ name, sec: 5 })), { name: installName, sec: installSec }] }],
      }),
    );

  test("CocoaPods install gets a Pods cache snippet, not the job's JS package manager (react-native)", () => {
    const f = kind(ci(80, ["Run yarn install"], "Install the CocoaPods dependencies"), "slow-step").find((x) => x.title.includes("CocoaPods"));
    assert.ok(f);
    assert.match(f.fix, /Podfile\.lock/);
    assert.doesNotMatch(f.fix, /cache: yarn/);
  });

  test("a build step that mentions CocoaPods is not an install step", () => {
    assert.equal(kind(ci(80, [], "Build HelloWorld with CocoaPods (Debug)"), "slow-step").length, 0);
  });

  test("hedged when a setup action may cache invisibly (react-native 'Setup node.js')", () => {
    const f = kind(ci(160, ["Setup node.js"], "Run yarn"), "slow-step")[0];
    assert.ok(f);
    assert.match(f.title, /check its cache/);
    assert.match(f.detail, /`Setup node\.js`.*can't see/);
    // 30% instead of 60%: 160 x 90s x 0.3 = 72 min
    assert.equal(f.monthlySavings.minutes, 72);
  });

  test("generic install steps only get an ecosystem snippet with explicit evidence", () => {
    assert.equal(inferEco("generic", ["Set up Node", "Install dependencies"]), "generic");
    assert.equal(inferEco("generic", ["Install pnpm and node 26", "Install dependencies"]), "pnpm");
    assert.equal(inferEco("generic", ["Setup Python", "Run pip install -r requirements.txt"]), "pip");
    assert.equal(inferEco("npm", ["anything"]), "npm");
  });

  test("generic install next to setup-* actions is hedged (react-native Format job)", () => {
    const f = kind(ci(160, ["Setup Node.js", "Setup Python"], "Install dependencies"), "slow-step")[0];
    assert.ok(f);
    assert.match(f.title, /check its cache/);
    assert.match(f.fix, /actions\/cache@v4/);
  });
});

describe("missing-concurrency", () => {
  test("cancelled superseded PR runs prove concurrency even with many overlapping main pushes (react-native)", () => {
    const runs: Run[] = [];
    // 4 PR pushes 3 min apart, superseded ones cancelled after 3 min
    for (let i = 0; i < 4; i++) {
      runs.push(at(i * 3, { headBranch: "feature/a", jobs: [{ name: "test", durationSec: i < 3 ? 180 : 3600, conclusion: i < 3 ? "cancelled" : "success" }] }));
    }
    // 8 overlapping pushes to main that run to completion
    for (let i = 0; i < 8; i++) runs.push(at(500 + i * 3, { event: "push", headBranch: "main", jobs: [{ name: "test", durationSec: 3600 }] }));
    // a few non-cancelled PR overlaps elsewhere (below the 50% share)
    for (let i = 0; i < 2; i++) runs.push(at(900 + i * 3, { headBranch: "feature/b", jobs: [{ name: "test", durationSec: 3600 }] }));
    assert.equal(kind(runs, "missing-concurrency").length, 0);
  });
});

describe("window normalization", () => {
  test("windows shorter than a day are not floored to 1 day", () => {
    const runs = [at(0, { jobs: [{ name: "t", durationSec: 600 }] })];
    const r = analyzeRuns(runs, { since: "2026-11-02T08:00:00Z", until: "2026-11-02T14:00:00Z" });
    assert.equal(r.days, 0.25);
    assert.equal(r.totals.monthlyCost.minutes, 10 * 120);
  });
});
