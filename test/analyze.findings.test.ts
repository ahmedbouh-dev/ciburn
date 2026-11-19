import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { analyze, DEFAULT_OPTIONS } from "../src/analyze/index.ts";
import type { Finding, FindingKind, Run } from "../src/types.ts";
import { makeDataset, makeRun, resetIds } from "./fixtures/build.ts";
import type { JobSpec, RunSpec, StepSpec } from "./fixtures/build.ts";

const T0 = Date.parse("2026-11-02T09:00:00Z");
const MIN = 60_000;
// 30-day window => monthly normalization factor is exactly 1.
const window30 = { since: "2026-11-01T00:00:00Z", until: "2026-12-01T00:00:00Z" };

const analyzeRuns = (runs: Run[]) => analyze(makeDataset(runs, window30), DEFAULT_OPTIONS);
const kind = (runs: Run[], k: FindingKind): Finding[] => analyzeRuns(runs).findings.filter((f) => f.kind === k);
const at = (minute: number, spec: Omit<RunSpec, "createdAt">) => makeRun({ createdAt: T0 + minute * MIN, ...spec });
const job = (name: string, sec: number, extra: Partial<JobSpec> = {}): JobSpec => ({ name, durationSec: sec, ...extra });

beforeEach(() => resetIds());

function checkShape(f: Finding) {
  assert.match(f.title, /`[^`]+`/, "title names the workflow/job in backticks");
  assert.ok(f.detail.length > 20);
  assert.ok(f.fix.length > 20);
  assert.ok(f.evidence.length <= 5);
  assert.ok(f.monthlySavings.usd >= 0);
}

// ---------------------------------------------------------------------------
describe("missing-concurrency", () => {
  /** n pushes to one PR branch, 3 min apart, each run 10 min long. */
  const burst = (n: number, opts: { cancelled?: boolean; event?: string; branch?: string; gapMin?: number } = {}) =>
    Array.from({ length: n }, (_, i) =>
      at(i * (opts.gapMin ?? 3), {
        event: opts.event ?? "pull_request",
        headBranch: opts.branch ?? "feature/a",
        jobs: [job("test", 3600, { queueSec: 5, ...(opts.cancelled && i < n - 1 ? { durationSec: 180, conclusion: "cancelled" } : {}) })],
      }),
    );

  test("flags superseded PR runs and computes billable waste after the newer run started", () => {
    const fs = kind(burst(4), "missing-concurrency");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    assert.match(f.title, /`CI`/);
    assert.match(f.fix, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    // Each of the first 3 runs: job starts at +5s, runs 3600s (60 billable min). Newer run at +180s:
    // kept ceil(175/60) = 3 min => 57 wasted min each => 171 min * $0.006.
    assert.deepEqual(f.monthlySavings, { minutes: 171, usd: 1.03 });
    assert.match(f.detail, /3 of 4 push\/PR runs/);
  });

  test("not flagged when superseded runs are already cancelled (has concurrency)", () => {
    assert.equal(kind(burst(5, { cancelled: true }), "missing-concurrency").length, 0);
  });

  test("not flagged when pushes don't overlap", () => {
    assert.equal(kind(burst(5, { gapMin: 90 }), "missing-concurrency").length, 0);
  });

  test("not flagged for fewer than 3 superseded runs", () => {
    assert.equal(kind(burst(3), "missing-concurrency").length, 0);
  });

  test("pushes to the default branch are excluded", () => {
    assert.equal(kind(burst(6, { event: "push", branch: "main" }), "missing-concurrency").length, 0);
  });

  test("feature-branch pushes get the cancel-all-but-default snippet", () => {
    const runs = [...burst(4, { event: "push", branch: "feature/b" }), at(500, { event: "push", headBranch: "main", jobs: [job("test", 60)] })];
    const f = kind(runs, "missing-concurrency")[0];
    assert.ok(f);
    assert.match(f.fix, /default_branch/);
  });
});

// ---------------------------------------------------------------------------
describe("rerun-waste", () => {
  const rerun = (minute: number, onlyFailed: boolean) =>
    at(minute, {
      headSha: `s${minute}`,
      jobs: [
        job("lint", 120),
        job("test", 1800, { conclusion: "failure" }),
        // "Re-run failed jobs": GitHub lists the passed lint again under attempt 2 as a COPY with the
        // original timestamps (same offset/queue/duration => identical startedAt/completedAt).
        onlyFailed ? job("lint", 120, { runAttempt: 2 }) : job("lint", 120, { runAttempt: 2, offsetSec: 900 }),
        job("test", 1800, { conclusion: "failure", runAttempt: 2, offsetSec: 900 }),
      ],
    });

  test("counts only executions thrown away by a re-execution; carried-over copies are free", () => {
    const fs = kind([rerun(0, false), rerun(100, false), rerun(200, true)], "rerun-waste");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    // 3 x test 30 min + lint 2 min only for the two "Re-run all jobs" runs = 94 min.
    // The third run's lint was carried over, not re-executed: its attempt-1 result is final.
    assert.equal(f.monthlySavings.minutes, 94);
    assert.equal(f.devHoursSaved, 0);
    assert.match(f.detail, /3 runs were re-run/);
    assert.match(f.detail, /2 re-executions were of jobs that had already passed/);
    assert.match(f.fix, /gh run rerun \d+ --failed/);
  });

  test("carried-over job copies are not billed twice (regression: vitejs/vite)", () => {
    const runs = [rerun(0, true), rerun(100, true), rerun(200, true)];
    const r = analyzeRuns(runs);
    // Per run: lint 2 + test 30 + test 30 = 62 min; the copied lint in attempt 2 costs nothing.
    assert.equal(r.totals.cost.minutes, 3 * 62);
    assert.equal(r.totals.jobs, 9);
    const f = r.findings.find((x) => x.kind === "rerun-waste")!;
    assert.match(f.title, /Retrying failures without code changes/);
    assert.doesNotMatch(f.fix, /--failed/, "no 'use Re-run failed jobs' advice when nobody re-ran passed jobs");
  });

  test("not flagged with fewer than 3 re-run runs", () => {
    assert.equal(kind([rerun(0, false), rerun(100, false)], "rerun-waste").length, 0);
  });

  test("flaky failures are not double counted", () => {
    const flakyRerun = (minute: number) =>
      at(minute, {
        headSha: `f${minute}`,
        jobs: [job("e2e", 600, { conclusion: "failure" }), job("e2e", 600, { runAttempt: 2, offsetSec: 900 })],
      });
    // All earlier-attempt cost is claimed by the flaky finding => nothing left to report.
    assert.equal(kind([flakyRerun(0), flakyRerun(100), flakyRerun(200)], "rerun-waste").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("cancelled-waste", () => {
  test("flags a large share of cancelled minutes and attributes fail-fast", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      at(i * 120, {
        headBranch: `b${i}`,
        jobs: [job("lint", 60, { conclusion: "failure" }), job("test", 1800, { conclusion: "cancelled" })],
      }),
    );
    const fs = kind(runs, "cancelled-waste");
    assert.equal(fs.length, 1);
    checkShape(fs[0]!);
    assert.match(fs[0]!.detail, /6 were cancelled because a sibling job failed/);
    assert.match(fs[0]!.fix, /needs: lint/);
    // 6 x 30 min cancelled, 50% avoidable
    assert.equal(fs[0]!.monthlySavings.minutes, 90);
  });

  test("not flagged when the cancelled share is small", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      at(i * 120, { headBranch: `b${i}`, jobs: [job("test", 900, i === 0 ? { conclusion: "cancelled", durationSec: 60 } : {})] }),
    );
    assert.equal(kind(runs, "cancelled-waste").length, 0);
  });

  test("cancellations by concurrency (superseded runs) are not waste", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      at(i * 3, {
        headBranch: "feature/a",
        jobs: [job("test", 600, i < 4 ? { conclusion: "cancelled", durationSec: 180 } : {})],
      }),
    );
    assert.equal(kind(runs, "cancelled-waste").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("expensive-runner", () => {
  const steps = (...names: string[]): StepSpec[] => names.map((name) => ({ name, sec: 120 }));

  test("macOS job without platform-specific steps: savings = cost minus linux rate", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [job("unit", 600, { labels: ["macos-latest"], steps: steps("Run npm ci", "Run npm test") }), job("lint", 60)],
      }),
    );
    const fs = kind(runs, "expensive-runner");
    assert.equal(fs.length, 1);
    checkShape(fs[0]!);
    // 5 x 10 min: macOS $3.10 vs linux $0.30
    assert.equal(fs[0]!.monthlySavings.usd, 2.8);
    assert.match(fs[0]!.fix, /runs-on: ubuntu-latest/);
  });

  test("platform-specific macOS jobs are not flagged", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [job("app", 600, { labels: ["macos-latest"], steps: steps("Run xcodebuild test -scheme App") })],
      }),
    );
    assert.equal(kind(runs, "expensive-runner").length, 0);
  });

  test("matrix leg with a linux sibling: drop non-linux legs on PRs", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      at(i * 60, {
        event: i < 4 ? "pull_request" : "push",
        headBranch: i < 4 ? `b${i}` : "main",
        jobs: [job("test (ubuntu-latest)", 300), job("test (windows-latest)", 1800, { labels: ["windows-latest"] })],
      }),
    );
    const f = kind(runs, "expensive-runner")[0];
    assert.ok(f);
    assert.match(f.title, /Windows matrix leg/);
    // 4 PR runs x 30 min x $0.01
    assert.deepEqual(f.monthlySavings, { minutes: 120, usd: 1.2 });
    assert.match(f.fix, /fromJSON/);
  });

  test("oversized larger runner with short jobs is flagged; long jobs are not", () => {
    const short = Array.from({ length: 60 }, (_, i) =>
      at(i * 60, { headBranch: `b${i}`, jobs: [job("build", 50, { labels: ["ubuntu-latest-16-cores"] })] }),
    );
    const fs = kind(short, "expensive-runner");
    assert.equal(fs.length, 1);
    assert.match(fs[0]!.title, /16-core runner/);
    // 60 x 1 min x $0.042 = 2.52 vs 60 x ceil(100/60)=2 min x $0.006 = 0.72
    assert.equal(fs[0]!.monthlySavings.usd, 1.8);

    resetIds();
    const long = Array.from({ length: 6 }, (_, i) =>
      at(i * 60, { headBranch: `b${i}`, jobs: [job("build", 900, { labels: ["ubuntu-latest-16-cores"] })] }),
    );
    assert.equal(kind(long, "expensive-runner").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("slow-step", () => {
  const ci = (n: number, installSec: number, extraSteps: StepSpec[] = [], installName = "Run npm ci") =>
    Array.from({ length: n }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [
          {
            name: "test",
            steps: [{ name: "Set up job", sec: 3 }, ...extraSteps, { name: installName, sec: installSec }, { name: "Run npm test", sec: 200 }],
          },
        ],
      }),
    );

  test("uncached npm ci is flagged with a setup-node cache snippet", () => {
    const fs = kind(ci(80, 90), "slow-step");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    assert.match(f.title, /`Run npm ci`/);
    assert.match(f.fix, /cache: npm/);
    // 60% of 80 x 90s = 72 min
    assert.equal(f.monthlySavings.minutes, 72);
  });

  test("ecosystem-specific snippets", () => {
    assert.match(kind(ci(80, 90, [], "Run uv sync --locked"), "slow-step")[0]!.fix, /enable-cache: true/);
    resetIds();
    assert.match(kind(ci(80, 90, [], "Run cargo build --release"), "slow-step")[0]!.fix, /rust-cache/);
    resetIds();
    assert.match(kind(ci(80, 90, [], "Run docker build -t app ."), "slow-step")[0]!.fix, /type=gha/);
  });

  test("not flagged when the job has a cache step", () => {
    assert.equal(kind(ci(80, 90, [{ name: "Cache node_modules", sec: 5 }]), "slow-step").length, 0);
  });

  test("not flagged when the step is fast or not an install step", () => {
    assert.equal(kind(ci(80, 30), "slow-step").length, 0);
    resetIds();
    assert.equal(kind(ci(80, 90, [], "Run npm test -- --shard 1"), "slow-step").length, 0);
  });

  test("the same install in several jobs becomes one finding", () => {
    const runs = Array.from({ length: 60 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: ["lint", "test", "build"].map((name) => ({ name, steps: [{ name: "Run pnpm install --frozen-lockfile", sec: 80 }, { name: "Run pnpm " + name, sec: 60 }] })),
      }),
    );
    const fs = kind(runs, "slow-step");
    assert.equal(fs.length, 1);
    assert.match(fs[0]!.title, /3 jobs of `CI`/);
    assert.match(fs[0]!.fix, /cache: pnpm/);
  });
});

// ---------------------------------------------------------------------------
describe("long-queue", () => {
  const queued = (n: number, queueSec: number, event = "pull_request", labels = ["self-hosted", "linux"]) =>
    Array.from({ length: n }, (_, i) =>
      at(i * 60, { event, headBranch: event === "schedule" ? "main" : `b${i}`, jobs: [job("deploy", 120, { queueSec, labels })] }),
    );

  test("flags p95 queue > 120s on PR/push as developer hours, never as billing $", () => {
    const fs = kind(queued(16, 300), "long-queue");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    assert.match(f.detail, /developer waiting time, not GitHub billing/);
    assert.match(f.fix, /maxRunners/);
    assert.deepEqual(f.monthlySavings, { minutes: 0, usd: 0 });
    // 16 x (300 - 30)s = 1.2 h
    assert.equal(f.devHoursSaved, 1.2);
  });

  test("below 1 developer hour/month it is noise", () => {
    assert.equal(kind(queued(6, 300), "long-queue").length, 0);
  });

  test("not flagged for short queues or scheduled runs", () => {
    assert.equal(kind(queued(16, 60), "long-queue").length, 0);
    resetIds();
    assert.equal(kind(queued(16, 300, "schedule"), "long-queue").length, 0);
  });

  test("jobs waiting for the same runner pool become one finding (regression: react-native)", () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: ["android-a", "android-b", "android-c"].map((name, k) => job(name, 300, { queueSec: 200 + k * 20, labels: ["4-core-ubuntu"] })),
      }),
    );
    const fs = kind(runs, "long-queue");
    assert.equal(fs.length, 1);
    assert.match(fs[0]!.title, /3 jobs of `CI` wait .* `4-core-ubuntu` runner/);
    assert.equal(fs[0]!.jobName, undefined);
    // per run only the longest wait counts: 20 x (240 - 30)s = 1.17 h (not 3 x that)
    assert.equal(fs[0]!.devHoursSaved, 1.2);
  });

  test("waiting on `needs:` upstream jobs is not queue time", () => {
    // `deploy` is created with the run but can only start after `build` (200s) finished.
    const runs = Array.from({ length: 6 }, (_, i) =>
      at(i * 60, {
        headBranch: `b${i}`,
        jobs: [job("build", 200, { queueSec: 0 }), job("deploy", 60, { queueSec: 210 })],
      }),
    );
    const r = analyzeRuns(runs);
    const deploy = r.jobs.find((j) => j.jobName === "deploy")!;
    assert.equal(deploy.p95QueueSec, 10);
    assert.equal(r.findings.filter((f) => f.kind === "long-queue").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("timeout", () => {
  test("jobs hanging until the 6h default get a timeout-minutes suggestion", () => {
    const runs = [
      ...Array.from({ length: 5 }, (_, i) => at(i * 60, { event: "push", headBranch: "main", jobs: [job("link-check", 240)] })),
      at(400, { event: "push", headBranch: "main", jobs: [job("link-check", 360 * 60, { conclusion: "timed_out" })] }),
    ];
    const fs = kind(runs, "timeout");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    // p95 of successes 240s -> 2x = 8 min -> rounded to 10 (min 10)
    assert.match(f.fix, /timeout-minutes: 10/);
    assert.equal(f.monthlySavings.minutes, 350);
  });

  test("not flagged without timeouts", () => {
    const runs = Array.from({ length: 5 }, (_, i) => at(i * 60, { headBranch: `b${i}`, jobs: [job("link-check", 240)] }));
    assert.equal(kind(runs, "timeout").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("schedule-noise", () => {
  const sched = (n: number, failRate: number, sec = 300) =>
    Array.from({ length: n }, (_, i) =>
      at(i * 480, {
        workflowName: "Nightly",
        workflowPath: ".github/workflows/nightly.yml",
        event: "schedule",
        headBranch: "main",
        jobs: [
          {
            name: "scan",
            conclusion: i < n * failRate ? "failure" : "success",
            steps: [
              { name: "Set up job", sec: 2 },
              { name: "Run trivy fs .", sec },
            ],
          },
        ],
      }),
    );

  test("flags mostly-failing scheduled workflows with the failing step", () => {
    const fs = kind(sched(90, 0.7), "schedule-noise");
    assert.equal(fs.length, 1);
    const f = fs[0]!;
    checkShape(f);
    assert.match(f.title, /`Nightly` fails 70%/);
    assert.match(f.detail, /`scan › Run trivy fs \.`/);
    assert.match(f.fix, /cron/);
    assert.match(f.fix, /gh workflow disable "Nightly"/);
  });

  test("not flagged when healthy and cheap relative to the rest", () => {
    const pr = Array.from({ length: 30 }, (_, i) => at(i * 60, { headBranch: `b${i}`, jobs: [job("test", 1200)] }));
    assert.equal(kind([...sched(9, 0.1, 60), ...pr], "schedule-noise").length, 0);
  });
});
