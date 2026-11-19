// Shared contract between fetcher (src/github), analysis (src/analyze) and reporters (src/report).
// Keep this file the single source of truth. Only `import type` from here.

/** Normalized job, flattened from GitHub's /actions/runs/{id}/jobs (all attempts). */
export interface Job {
  id: number;
  runId: number;
  runAttempt: number;
  name: string;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | skipped | timed_out | null
  createdAt: string; // ISO; when the job was queued
  startedAt: string | null;
  completedAt: string | null;
  labels: string[]; // runs-on labels, e.g. ["ubuntu-latest"] or ["self-hosted","linux"]
  runnerName: string | null;
  steps: Step[];
}

export interface Step {
  name: string;
  number: number;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** Normalized workflow run (one entry per run id; `runAttempt` is the latest attempt). */
export interface Run {
  id: number;
  workflowId: number;
  workflowName: string;
  workflowPath: string; // .github/workflows/ci.yml
  event: string; // push | pull_request | schedule | workflow_dispatch | ...
  headBranch: string | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  runAttempt: number;
  createdAt: string;
  runStartedAt: string | null;
  updatedAt: string;
  htmlUrl: string;
  /** All jobs across all attempts of this run. */
  jobs: Job[];
}

export interface Dataset {
  repo: string; // owner/name
  since: string; // ISO
  until: string; // ISO
  fetchedAt: string;
  /** True when --max-runs cut the window; `since` then is the oldest fetched run. */
  truncated?: boolean;
  runs: Run[];
}

export type RunnerOs = "linux" | "windows" | "macos" | "self-hosted";

/** USD per billable minute. Each job is rounded UP to whole minutes (GitHub billing rule). */
export interface Pricing {
  linux: number;
  linuxArm: number;
  windows: number;
  macos: number;
  selfHosted: number; // GitHub platform fee for self-hosted (0 if not applicable)
  /** Larger runners: per-minute by core count, matched from labels like "ubuntu-latest-8-cores" / "*-16core". */
  largerLinuxPerCore: number;
}

export interface AnalyzeOptions {
  pricing: Pricing;
  /** Developer hourly cost used to price waiting time (queue + slow feedback). Default 100. */
  devHourlyUsd: number;
}

export interface Money {
  minutes: number; // billable minutes (rounded-up per job)
  usd: number;
}

export interface WorkflowStats {
  workflowName: string;
  workflowPath: string;
  runs: number;
  jobs: number;
  cost: Money;
  successRate: number; // 0..1 over completed runs (success / (success+failure+timed_out))
  p50DurationSec: number; // wall-clock run duration (runStartedAt -> updatedAt), latest attempt
  p95DurationSec: number;
  /** Trend: cost of the 2nd half of the window vs the 1st half; +0.25 = 25% more. null if not enough data. */
  costTrend: number | null;
}

export interface JobStats {
  workflowName: string;
  jobName: string; // matrix-normalized is NOT done; raw job name
  runs: number;
  cost: Money;
  p50DurationSec: number;
  p95DurationSec: number;
  p50QueueSec: number;
  p95QueueSec: number;
  failureRate: number;
  os: RunnerOs;
}

export interface StepStats {
  workflowName: string;
  jobName: string;
  stepName: string;
  samples: number;
  p50Sec: number;
  totalSec: number;
}

/** A job that failed and then passed on the same commit without code changes. */
export interface FlakyJob {
  workflowName: string;
  jobName: string;
  flakyCount: number; // number of (sha) occurrences where fail -> pass happened
  occurrences: number; // total sha groups where the job ran
  flakeRate: number; // flakyCount / occurrences
  wastedCost: Money; // cost of the failed attempts that were retried
  examples: string[]; // run html urls
}

export type FindingKind =
  | "missing-concurrency" // superseded runs on same branch/PR kept running
  | "flaky-job"
  | "rerun-waste"
  | "cancelled-waste"
  | "expensive-runner" // macOS/windows where linux likely works, or oversized larger runner
  | "slow-step" // dependency install / setup steps dominating (cache candidates)
  | "long-queue"
  | "schedule-noise" // scheduled workflows that cost a lot / fail a lot
  | "timeout"; // jobs hitting timeouts (default 360min burns money)

export interface Finding {
  kind: FindingKind;
  severity: "high" | "medium" | "low";
  title: string; // short, specific: "PR builds keep running after new pushes in `CI`"
  detail: string; // 1-3 sentences, with numbers from the data
  fix: string; // concrete fix; may contain a YAML snippet in markdown code fence
  /** Estimated monthly GitHub BILLING savings if fixed (normalized to 30 days). Never includes developer time. */
  monthlySavings: Money;
  /** Estimated developer hours per month no longer spent waiting (queue, retries). 0 if not applicable. Kept separate from $ on purpose. */
  devHoursSaved: number;
  workflowName?: string;
  jobName?: string;
  evidence: string[]; // up to 5 run URLs
}

export interface Report {
  repo: string;
  since: string;
  until: string;
  days: number;
  totals: {
    runs: number;
    jobs: number;
    cost: Money;
    monthlyCost: Money; // normalized to 30 days
    wastedCost: Money; // flaky + rerun + cancelled + superseded
    queueHours: number; // total job queue time
    byOs: Record<RunnerOs, Money>;
  };
  workflows: WorkflowStats[]; // sorted by cost desc
  jobs: JobStats[]; // sorted by cost desc
  slowSteps: StepStats[]; // top 15 by totalSec
  flaky: FlakyJob[]; // sorted by flakyCount desc
  findings: Finding[]; // sorted by impact desc: monthlySavings.usd + devHoursSaved * devHourlyUsd
  pricing: Pricing;
  devHourlyUsd: number;
}
