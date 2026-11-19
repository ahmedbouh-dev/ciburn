// Descriptive statistics: per-workflow, per-job and per-step aggregates.

import type { JobStats, Money, RunnerOs, StepStats, WorkflowStats } from "../types.ts";
import type { Ctx, JobRecord } from "./context.ts";
import { ms, workflowLabel } from "./context.ts";
import { groupBy, money, percentile, round, sum } from "./stats.ts";

const FAILED = new Set(["failure", "timed_out"]);
const CONCLUSIVE = new Set(["success", "failure", "timed_out"]);

export function costOf(recs: readonly JobRecord[]): Money {
  return money(sum(recs.map((r) => r.minutes)), sum(recs.map((r) => r.usd)));
}

export function byOs(ctx: Ctx): Record<RunnerOs, Money> {
  const out: Record<RunnerOs, Money> = {
    linux: { minutes: 0, usd: 0 },
    windows: { minutes: 0, usd: 0 },
    macos: { minutes: 0, usd: 0 },
    "self-hosted": { minutes: 0, usd: 0 },
  };
  const groups = groupBy(ctx.records, (r) => r.os);
  for (const [os, recs] of groups) out[os as RunnerOs] = costOf(recs);
  return out;
}

/** Total queue hours over all jobs that started. */
export function queueHours(ctx: Ctx): number {
  return round(sum(ctx.records.map((r) => r.queueSec ?? 0)) / 3600, 2);
}

/**
 * Cost trend: cost of runs created in the 2nd half of the window vs the 1st half.
 * null unless both halves have >= 3 runs and the 1st half cost > 0.
 */
function costTrend(ctx: Ctx, recs: readonly JobRecord[]): number | null {
  const since = ms(ctx.ds.since);
  const until = ms(ctx.ds.until);
  if (since === null || until === null || until <= since) return null;
  const mid = since + (until - since) / 2;
  const firstRuns = new Set<number>();
  const secondRuns = new Set<number>();
  let first = 0;
  let second = 0;
  for (const r of recs) {
    const t = ms(r.run.createdAt) ?? 0;
    if (t < mid) {
      first += r.usd;
      firstRuns.add(r.run.id);
    } else {
      second += r.usd;
      secondRuns.add(r.run.id);
    }
  }
  if (firstRuns.size < 3 || secondRuns.size < 3 || first <= 0) return null;
  return round(second / first - 1, 3);
}

export function workflowStats(ctx: Ctx): WorkflowStats[] {
  const out: WorkflowStats[] = [];
  for (const runs of groupBy(ctx.ds.runs, (r) => r.workflowPath).values()) {
    const recs = runs.flatMap((r) => ctx.recordsByRun.get(r.id) ?? []);
    const concluded = runs.filter((r) => r.conclusion !== null && CONCLUSIVE.has(r.conclusion));
    const successes = concluded.filter((r) => r.conclusion === "success").length;
    // Wall-clock duration of the latest attempt: runStartedAt -> updatedAt.
    const durations: number[] = [];
    for (const r of runs) {
      const start = ms(r.runStartedAt);
      const end = ms(r.updatedAt);
      if (start !== null && end !== null && end > start && r.status === "completed") durations.push((end - start) / 1000);
    }
    const latest = runs.reduce((a, b) => ((ms(b.createdAt) ?? 0) > (ms(a.createdAt) ?? 0) ? b : a));
    out.push({
      workflowName: workflowLabel(latest),
      workflowPath: latest.workflowPath,
      runs: runs.length,
      jobs: recs.length,
      cost: costOf(recs),
      successRate: concluded.length ? round(successes / concluded.length, 4) : 0,
      p50DurationSec: round(percentile(durations, 50), 1),
      p95DurationSec: round(percentile(durations, 95), 1),
      costTrend: costTrend(ctx, recs),
    });
  }
  return out.sort((a, b) => b.cost.usd - a.cost.usd || b.runs - a.runs);
}

/** Records grouped by (workflowPath, jobName). */
export function groupJobs(ctx: Ctx): Map<string, JobRecord[]> {
  return groupBy(ctx.records, (r) => `${r.workflowPath}\u0000${r.job.name}`);
}

export function jobStats(ctx: Ctx): JobStats[] {
  const out: JobStats[] = [];
  for (const recs of groupJobs(ctx).values()) {
    const first = recs[0]!;
    const durations = recs.flatMap((r) => (r.durationSec === null ? [] : [r.durationSec]));
    const queues = recs.flatMap((r) => (r.queueSec === null ? [] : [r.queueSec]));
    const conclusive = recs.filter((r) => r.job.conclusion !== null && CONCLUSIVE.has(r.job.conclusion));
    const failed = conclusive.filter((r) => FAILED.has(r.job.conclusion!)).length;
    // OS of the most recently created instance with labels (labels can change over time; skipped
    // jobs report labels [] which would misclassify as linux).
    const labelled = recs.filter((r) => r.job.labels.length > 0);
    const newest = (labelled.length ? labelled : recs).reduce((a, b) =>
      (ms(b.job.createdAt) ?? 0) > (ms(a.job.createdAt) ?? 0) ? b : a,
    );
    out.push({
      workflowName: first.workflowName,
      jobName: first.job.name,
      runs: recs.length,
      cost: costOf(recs),
      p50DurationSec: round(percentile(durations, 50), 1),
      p95DurationSec: round(percentile(durations, 95), 1),
      p50QueueSec: round(percentile(queues, 50), 1),
      p95QueueSec: round(percentile(queues, 95), 1),
      failureRate: conclusive.length ? round(failed / conclusive.length, 4) : 0,
      os: newest.os,
    });
  }
  return out.sort((a, b) => b.cost.usd - a.cost.usd || b.runs - a.runs);
}

export interface StepSample {
  rec: JobRecord;
  stepName: string;
  sec: number;
}

/** Step duration samples for steps that actually ran. */
export function stepSamples(ctx: Ctx): StepSample[] {
  const out: StepSample[] = [];
  for (const rec of ctx.records) {
    for (const step of rec.job.steps) {
      if (step.conclusion === "skipped") continue;
      const s = ms(step.startedAt);
      const e = ms(step.completedAt);
      if (s === null || e === null || e < s) continue;
      out.push({ rec, stepName: step.name, sec: (e - s) / 1000 });
    }
  }
  return out;
}

export function stepStats(ctx: Ctx, limit = 15): StepStats[] {
  const groups = groupBy(stepSamples(ctx), (s) => `${s.rec.workflowPath}\u0000${s.rec.job.name}\u0000${s.stepName}`);
  const out: StepStats[] = [];
  for (const samples of groups.values()) {
    const first = samples[0]!;
    const secs = samples.map((s) => s.sec);
    out.push({
      workflowName: first.rec.workflowName,
      jobName: first.rec.job.name,
      stepName: first.stepName,
      samples: samples.length,
      p50Sec: round(percentile(secs, 50), 1),
      totalSec: round(sum(secs), 1),
    });
  }
  return out.sort((a, b) => b.totalSec - a.totalSec).slice(0, limit);
}
