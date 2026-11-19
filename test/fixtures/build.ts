// Builders for synthetic Datasets, plus a realistic deterministic sample used by tests and the
// CLI demo mode (no network).

import type { Dataset, Job, Run, Step } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Builders

export interface StepSpec {
  name: string;
  sec: number;
  conclusion?: string | null;
}

export interface JobSpec {
  name: string;
  labels?: string[];
  runAttempt?: number;
  /** Job createdAt relative to the run's createdAt, in seconds. */
  offsetSec?: number;
  queueSec?: number;
  /** Defaults to the sum of step durations, or 60. */
  durationSec?: number;
  conclusion?: string | null;
  status?: string;
  /** Leave the job unstarted (startedAt/completedAt null). */
  notStarted?: boolean;
  steps?: StepSpec[];
  id?: number;
}

export interface RunSpec {
  id?: number;
  repo?: string;
  workflowName?: string;
  workflowPath?: string;
  workflowId?: number;
  event?: string;
  headBranch?: string | null;
  headSha?: string;
  createdAt: string | number | Date;
  conclusion?: string | null;
  status?: string;
  /** Defaults to the highest runAttempt among jobs (or 1). */
  runAttempt?: number;
  jobs?: JobSpec[];
}

let nextRunId = 10_000;
let nextJobId = 500_000;

/** Reset id counters so fixtures are reproducible across tests. */
export function resetIds(): void {
  nextRunId = 10_000;
  nextJobId = 500_000;
}

function toMs(t: string | number | Date): number {
  return typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : t.getTime();
}

const iso = (msVal: number): string => new Date(msVal).toISOString();

export function makeJob(runId: number, runCreatedAtMs: number, spec: JobSpec): Job {
  const conclusion = spec.conclusion === undefined ? "success" : spec.conclusion;
  const createdMs = runCreatedAtMs + (spec.offsetSec ?? 0) * 1000;
  const stepsSpec = spec.steps ?? [];
  const duration = spec.durationSec ?? (stepsSpec.length ? stepsSpec.reduce((a, s) => a + s.sec, 0) : 60);
  const started = spec.notStarted || conclusion === "skipped" ? null : createdMs + (spec.queueSec ?? 5) * 1000;
  const completed = started === null ? null : started + duration * 1000;

  const steps: Step[] = [];
  let cursor = started ?? 0;
  // A non-success job fails in its last "real" step (not GitHub's "Complete job"/"Post ..." steps).
  let failIdx = -1;
  stepsSpec.forEach((s, i) => {
    if (!/^(Complete job|Post )/.test(s.name)) failIdx = i;
  });
  stepsSpec.forEach((s, i) => {
    const stepConclusion =
      s.conclusion !== undefined
        ? s.conclusion
        : started === null
          ? null
          : i === failIdx && conclusion !== "success"
            ? conclusion
            : "success";
    steps.push({
      name: s.name,
      number: i + 1,
      conclusion: stepConclusion,
      startedAt: started === null ? null : iso(cursor),
      completedAt: started === null ? null : iso(cursor + s.sec * 1000),
    });
    cursor += s.sec * 1000;
  });

  return {
    id: spec.id ?? nextJobId++,
    runId,
    runAttempt: spec.runAttempt ?? 1,
    name: spec.name,
    status: spec.status ?? (started === null && conclusion === null ? "queued" : "completed"),
    conclusion,
    createdAt: iso(createdMs),
    startedAt: started === null ? null : iso(started),
    completedAt: completed === null ? null : iso(completed),
    labels: spec.labels ?? ["ubuntu-latest"],
    runnerName: started === null ? null : "GitHub Actions 1",
    steps,
  };
}

/** Run conclusion derived from the latest attempt's jobs, like GitHub does. */
function deriveConclusion(jobs: Job[], attempt: number): string {
  const latest = jobs.filter((j) => j.runAttempt === attempt);
  if (latest.some((j) => j.conclusion === "failure" || j.conclusion === "timed_out")) return "failure";
  if (latest.some((j) => j.conclusion === "cancelled")) return "cancelled";
  return "success";
}

export function makeRun(spec: RunSpec): Run {
  const id = spec.id ?? nextRunId++;
  const repo = spec.repo ?? "acme/webapp";
  const createdMs = toMs(spec.createdAt);
  const jobs = (spec.jobs ?? []).map((j) => makeJob(id, createdMs, j));
  const runAttempt = spec.runAttempt ?? Math.max(1, ...jobs.map((j) => j.runAttempt));
  const latest = jobs.filter((j) => j.runAttempt === runAttempt);
  const latestStart = latest.length ? Math.min(...latest.map((j) => Date.parse(j.createdAt))) : createdMs;
  const ends = jobs.flatMap((j) => (j.completedAt ? [Date.parse(j.completedAt)] : []));
  const path = spec.workflowPath ?? ".github/workflows/ci.yml";
  return {
    id,
    workflowId: spec.workflowId ?? hash(path),
    workflowName: spec.workflowName ?? "CI",
    workflowPath: path,
    event: spec.event ?? "pull_request",
    headBranch: spec.headBranch === undefined ? "feature/x" : spec.headBranch,
    headSha: spec.headSha ?? `sha${id}`,
    status: spec.status ?? "completed",
    conclusion: spec.conclusion === undefined ? deriveConclusion(jobs, runAttempt) : spec.conclusion,
    runAttempt,
    createdAt: iso(createdMs),
    runStartedAt: iso(latestStart),
    updatedAt: iso(ends.length ? Math.max(...ends) : createdMs),
    htmlUrl: `https://github.com/${repo}/actions/runs/${id}`,
    jobs,
  };
}

export function makeDataset(
  runs: Run[],
  opts: { repo?: string; since?: string; until?: string; fetchedAt?: string } = {},
): Dataset {
  const times = runs.map((r) => Date.parse(r.createdAt));
  const since = opts.since ?? (times.length ? iso(Math.min(...times)) : "2026-11-01T00:00:00.000Z");
  const until = opts.until ?? (times.length ? iso(Math.max(...times) + 3_600_000) : "2026-11-15T00:00:00.000Z");
  return { repo: opts.repo ?? "acme/webapp", since, until, fetchedAt: opts.fetchedAt ?? until, runs };
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 1_000_000;
}

// ---------------------------------------------------------------------------
// Sample dataset: acme/webapp, 14 days, ~210 runs, every phenomenon present.

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SETUP: StepSpec = { name: "Set up job", sec: 2 };
const CHECKOUT: StepSpec = { name: "Run actions/checkout@v4", sec: 3 };
// pnpm/action-setup has no cache input. With "Run actions/setup-node@v4" the slow-step finding is
// (correctly) hedged, because setup-node's `cache:` input is invisible in step names.
const SETUP_NODE: StepSpec = { name: "Run pnpm/action-setup@v4", sec: 6 };
const COMPLETE: StepSpec = { name: "Complete job", sec: 1 };

/**
 * Phenomena in the sample:
 * - CI has no concurrency: quick follow-up pushes to PR branches leave superseded runs running.
 * - `pnpm install` without cache in every CI job (~80s).
 * - `test (macos-latest)` matrix leg runs on every PR next to `test (ubuntu-latest)`.
 * - `build` uses a 16-core runner for a ~70s job.
 * - `e2e` is flaky (~13% of commits): failed, then re-run (failed jobs only or all jobs) and passes.
 * - Some CI runs are cancelled by hand mid-way.
 * - Deploy runs on a small self-hosted pool with long queues.
 * - Security Scan runs 3×/day on a schedule, fails ~60% in `Run trivy`, with an uncached docker build.
 * - Docs `link-check` hangs until the 6 h default timeout twice.
 */
export function sampleDataset(): Dataset {
  resetIds();
  const rand = rng(42);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const chance = (p: number) => rand() < p;
  const sha = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const since = Date.parse("2026-11-01T00:00:00Z");
  const until = Date.parse("2026-11-15T00:00:00Z");
  const DAY = 86_400_000;
  /** Random time on a random day during working hours (07-19 UTC). */
  const workTime = (dayFrom = 0, dayTo = 14) => since + Math.floor(between(dayFrom, dayTo)) * DAY + between(7, 19) * 3_600_000;

  const runs: Run[] = [];

  const ciJobs = (attempt: number, offset: number, opts: { e2eFails: boolean; only?: string[]; cancelAt?: number }): JobSpec[] => {
    const install = (): StepSpec => ({ name: "Run pnpm install --frozen-lockfile", sec: Math.round(between(70, 95)) });
    const all: JobSpec[] = [
      {
        name: "lint",
        steps: [SETUP, CHECKOUT, SETUP_NODE, install(), { name: "Run pnpm lint", sec: Math.round(between(30, 50)) }, COMPLETE],
      },
      {
        name: "test (ubuntu-latest)",
        steps: [SETUP, CHECKOUT, SETUP_NODE, install(), { name: "Run pnpm test", sec: Math.round(between(330, 420)) }, COMPLETE],
      },
      {
        name: "test (macos-latest)",
        labels: ["macos-latest"],
        queueSec: Math.round(between(10, 60)),
        steps: [SETUP, CHECKOUT, SETUP_NODE, install(), { name: "Run pnpm test", sec: Math.round(between(380, 480)) }, COMPLETE],
      },
      {
        name: "e2e",
        conclusion: opts.e2eFails ? "failure" : "success",
        steps: [
          SETUP,
          CHECKOUT,
          SETUP_NODE,
          install(),
          { name: "Run npx playwright install --with-deps", sec: Math.round(between(40, 60)) },
          { name: "Run npx playwright test", sec: Math.round(between(420, 560)) },
          COMPLETE,
        ],
      },
      {
        name: "build",
        labels: ["ubuntu-latest-16-cores"],
        steps: [SETUP, CHECKOUT, { name: "Run pnpm build", sec: Math.round(between(45, 80)) }, COMPLETE],
      },
    ];
    return all
      .filter((j) => !opts.only || opts.only.includes(j.name))
      .map((j) => {
        const job: JobSpec = { queueSec: Math.round(between(3, 15)), ...j, runAttempt: attempt, offsetSec: offset };
        if (opts.cancelAt !== undefined) {
          const total = (j.steps ?? []).reduce((a, s) => a + s.sec, 0);
          if (total > opts.cancelAt) {
            job.conclusion = "cancelled";
            job.durationSec = opts.cancelAt;
            job.steps = undefined;
          }
        }
        return job;
      });
  };

  /** One CI run with optional flaky e2e and re-run. */
  const ciRun = (createdAt: number, event: string, branch: string) => {
    const commit = sha();
    const flakyE2e = chance(0.13);
    const cancelAt = !flakyE2e && chance(0.06) ? Math.round(between(150, 400)) : undefined;
    const jobs = ciJobs(1, 0, { e2eFails: flakyE2e, cancelAt });
    if (flakyE2e && chance(0.75)) {
      // Re-run ~20-60 min later; half the time someone clicks "Re-run all jobs".
      const offset = Math.round(between(1200, 3600));
      const only = chance(0.5) ? ["e2e"] : undefined;
      jobs.push(...ciJobs(2, offset, { e2eFails: chance(0.1), only }));
    }
    runs.push(makeRun({ createdAt, event, headBranch: branch, headSha: commit, jobs }));
  };

  // PR branches with bursts of pushes (some within minutes -> superseded runs).
  for (let b = 0; b < 26; b++) {
    const branch = `feature/${["auth", "cart", "search", "billing", "i18n", "perf", "ui", "api"][b % 8]}-${b}`;
    let t = workTime(0, 13);
    const pushes = 3 + Math.floor(rand() * 3);
    for (let p = 0; p < pushes && t < until; p++) {
      ciRun(t, "pull_request", branch);
      t += chance(0.5) ? between(2, 9) * 60_000 : between(40, 240) * 60_000;
    }
  }

  // Pushes to main: CI + Deploy (self-hosted, long queue) + occasionally Docs.
  let docsRuns = 0;
  for (let i = 0; i < 30; i++) {
    const t = workTime();
    ciRun(t, "push", "main");
    runs.push(
      makeRun({
        workflowName: "Deploy",
        workflowPath: ".github/workflows/deploy.yml",
        event: "push",
        headBranch: "main",
        headSha: sha(),
        createdAt: t + 60_000,
        jobs: [
          {
            name: "deploy",
            labels: ["self-hosted", "linux", "deploy"],
            // Small pool: most of the time 30-90s, during busy hours up to 12 min.
            queueSec: Math.round(chance(0.4) ? between(240, 720) : between(30, 90)),
            steps: [SETUP, CHECKOUT, { name: "Run ./scripts/deploy.sh", sec: Math.round(between(150, 240)) }, COMPLETE],
          },
        ],
      }),
    );
    if (i % 4 === 0 && docsRuns < 8) {
      docsRuns++;
      const hang = docsRuns === 2 || docsRuns === 6;
      runs.push(
        makeRun({
          workflowName: "Docs",
          workflowPath: ".github/workflows/docs.yml",
          event: "push",
          headBranch: "main",
          createdAt: t + 120_000,
          jobs: [
            {
              name: "link-check",
              conclusion: hang ? "timed_out" : "success",
              durationSec: hang ? 360 * 60 : Math.round(between(120, 200)),
              steps: hang
                ? [SETUP, CHECKOUT, { name: "Run lychee --no-progress './**/*.md'", sec: 360 * 60 - 6, conclusion: "cancelled" }]
                : [SETUP, CHECKOUT, { name: "Run lychee --no-progress './**/*.md'", sec: Math.round(between(100, 180)) }, COMPLETE],
            },
          ],
        }),
      );
    }
  }

  // Scheduled security scan, 3×/day, failing ~60%.
  for (let d = 0; d < 14; d++) {
    for (const hour of [2, 10, 18]) {
      const fails = chance(0.6);
      runs.push(
        makeRun({
          workflowName: "Security Scan",
          workflowPath: ".github/workflows/security.yml",
          event: "schedule",
          headBranch: "main",
          createdAt: since + d * DAY + hour * 3_600_000 + 4 * 60_000,
          jobs: [
            {
              name: "scan",
              conclusion: fails ? "failure" : "success",
              steps: [
                SETUP,
                CHECKOUT,
                { name: "Run docker build -t webapp:scan .", sec: Math.round(between(220, 300)) },
                { name: "Run trivy image --exit-code 1 webapp:scan", sec: Math.round(between(240, 330)) },
                ...(fails ? [] : [COMPLETE]),
              ],
            },
          ],
        }),
      );
    }
  }

  runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return makeDataset(runs, { since: iso(since), until: iso(until), fetchedAt: iso(until) });
}
