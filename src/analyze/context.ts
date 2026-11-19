// Precomputed per-job records shared by all detectors.

import type { AnalyzeOptions, Dataset, Job, Money, Run, RunnerOs } from "../types.ts";
import { billableMinutes, jobDurationSec, jobPricePerMinute, runnerCores, runnerOs } from "../pricing.ts";
import { money } from "./stats.ts";

export interface JobRecord {
  job: Job;
  run: Run;
  workflowName: string;
  workflowPath: string;
  /** Billable minutes (rounded up per job). */
  minutes: number;
  usd: number;
  pricePerMin: number;
  durationSec: number | null;
  /** Queue time, see `effectiveQueueSec`. null if the job never started. */
  queueSec: number | null;
  os: RunnerOs;
  cores: number | null;
  /**
   * This execution's result is the one that counts: no later attempt of the same run re-executed a
   * job with the same name. false = its result was thrown away by a re-run (re-run waste).
   */
  isFinal: boolean;
}

export interface Ctx {
  ds: Dataset;
  opts: AnalyzeOptions;
  days: number;
  records: JobRecord[];
  recordsByRun: Map<number, JobRecord[]>;
  totalUsd: number;
  totalMinutes: number;
  /** Scale a value measured over the window to 30 days. */
  monthly(value: number): number;
  monthlyMoney(minutes: number, usd: number): Money;
}

export function workflowLabel(run: Run): string {
  return run.workflowName || run.workflowPath;
}

export function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Queue time = startedAt - queueStart, where queueStart = max(job.createdAt, latest completedAt of
 * any other job of the same run attempt that finished before this job started).
 * Why: for jobs with `needs:` GitHub's createdAt can predate the moment the job became runnable,
 * so naive startedAt - createdAt would count waiting on upstream jobs as queue time.
 * This is a conservative lower bound of real runner wait.
 */
function effectiveQueueSec(job: Job, siblings: readonly Job[]): number | null {
  const started = ms(job.startedAt);
  const created = ms(job.createdAt);
  if (started === null || created === null || job.conclusion === "skipped") return null;
  let queueStart = created;
  for (const s of siblings) {
    if (s === job || s.runAttempt !== job.runAttempt) continue;
    const done = ms(s.completedAt);
    if (done !== null && done <= started && done > queueStart) queueStart = done;
  }
  return Math.max(0, (started - queueStart) / 1000);
}

/**
 * "Re-run failed jobs" makes GitHub list the jobs that already passed again under the new attempt,
 * with a new job id but the ORIGINAL startedAt/completedAt (verified on vitejs/vite data). They did
 * not run again and are not billed again, so they are dropped from the analysis entirely —
 * otherwise cost, durations and re-run waste are double-counted.
 */
export function isCarriedOver(job: Job, runJobs: readonly Job[]): boolean {
  if (job.runAttempt <= 1 || !job.startedAt) return false;
  return runJobs.some(
    (o) =>
      o !== job &&
      o.runAttempt < job.runAttempt &&
      o.name === job.name &&
      o.startedAt === job.startedAt &&
      o.completedAt === job.completedAt,
  );
}

export function buildContext(ds: Dataset, opts: AnalyzeOptions): Ctx {
  const since = ms(ds.since);
  const until = ms(ds.until);
  const rawDays = since !== null && until !== null ? (until - since) / 86_400_000 : 30;
  // Floor at 1 hour (not 1 day): a capped fetch of a busy repo can cover only a few hours.
  const days = Math.max(1 / 24, rawDays);

  const records: JobRecord[] = [];
  const recordsByRun = new Map<number, JobRecord[]>();
  let totalUsd = 0;
  let totalMinutes = 0;
  for (const run of ds.runs) {
    const list: JobRecord[] = [];
    const executed = run.jobs.filter((j) => !isCarriedOver(j, run.jobs));
    for (const job of executed) {
      const minutes = billableMinutes(job);
      const pricePerMin = jobPricePerMinute(job.labels, opts.pricing);
      const rec: JobRecord = {
        job,
        run,
        workflowName: workflowLabel(run),
        workflowPath: run.workflowPath,
        minutes,
        usd: minutes * pricePerMin,
        pricePerMin,
        durationSec: jobDurationSec(job),
        queueSec: effectiveQueueSec(job, executed),
        os: runnerOs(job.labels),
        cores: runnerCores(job.labels),
        isFinal: !executed.some((o) => o.name === job.name && o.runAttempt > job.runAttempt),
      };
      totalUsd += rec.usd;
      totalMinutes += minutes;
      list.push(rec);
      records.push(rec);
    }
    recordsByRun.set(run.id, list);
  }

  const factor = 30 / days;
  return {
    ds,
    opts,
    days,
    records,
    recordsByRun,
    totalUsd,
    totalMinutes,
    monthly: (v) => v * factor,
    monthlyMoney: (minutes, usd) => money(minutes * factor, usd * factor),
  };
}
