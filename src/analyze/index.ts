// Analysis entry point: Dataset -> Report. Pure, no I/O.

import type { AnalyzeOptions, Dataset, Finding, Report } from "../types.ts";
import { DEFAULT_PRICING } from "../pricing.ts";
import { buildContext } from "./context.ts";
import type { Ctx } from "./context.ts";
import { byOs, costOf, jobStats, queueHours, stepStats, workflowStats } from "./aggregate.ts";
import { detectFlaky } from "./flaky.ts";
import type { FlakyDetail } from "./flaky.ts";
import { detectSuperseded } from "./superseded.ts";
import type { SupersededRun } from "./superseded.ts";
import {
  cancelledWaste,
  expensiveRunners,
  flakyFindings,
  impactUsd,
  longQueue,
  missingConcurrency,
  rerunWaste,
  scheduleNoise,
  slowSteps,
  timeouts,
} from "./findings.ts";
import { money, round, sum } from "./stats.ts";

export const DEFAULT_OPTIONS: AnalyzeOptions = { pricing: DEFAULT_PRICING, devHourlyUsd: 100 };

/**
 * Total waste = flaky failed attempts + re-executed (non-final) executions + cancelled jobs + the
 * superseded part of non-cancelled superseded runs. A job counted by several categories is
 * counted once, with its largest waste amount.
 */
function wastedCost(ctx: Ctx, flaky: readonly FlakyDetail[], superseded: readonly SupersededRun[]) {
  const perJob = new Map<number, { minutes: number; usd: number }>();
  const add = (id: number, minutes: number, usd: number) => {
    const cur = perJob.get(id);
    if (!cur || usd > cur.usd || (usd === cur.usd && minutes > cur.minutes)) perJob.set(id, { minutes, usd });
  };
  for (const d of flaky) for (const r of d.failedRecs) add(r.job.id, r.minutes, r.usd);
  for (const r of ctx.records) {
    if (r.minutes === 0) continue;
    if (!r.isFinal || r.job.conclusion === "cancelled") add(r.job.id, r.minutes, r.usd);
  }
  for (const s of superseded) for (const w of s.jobWaste) add(w.rec.job.id, w.minutes, w.usd);
  const values = [...perJob.values()];
  return money(sum(values.map((v) => v.minutes)), sum(values.map((v) => v.usd)));
}

export function analyze(ds: Dataset, opts: AnalyzeOptions = DEFAULT_OPTIONS): Report {
  const ctx = buildContext(ds, opts);
  const flaky = detectFlaky(ctx);
  const superseded = detectSuperseded(ctx);

  const findings: Finding[] = [
    ...missingConcurrency(ctx, superseded),
    ...flakyFindings(ctx, flaky),
    ...rerunWaste(ctx, flaky),
    ...cancelledWaste(ctx, superseded),
    ...expensiveRunners(ctx),
    ...slowSteps(ctx),
    ...longQueue(ctx),
    ...timeouts(ctx),
    ...scheduleNoise(ctx),
  ].sort(
    (a, b) =>
      impactUsd(b, opts.devHourlyUsd) - impactUsd(a, opts.devHourlyUsd) ||
      b.monthlySavings.minutes - a.monthlySavings.minutes,
  );

  const cost = costOf(ctx.records);
  return {
    repo: ds.repo,
    since: ds.since,
    until: ds.until,
    days: round(ctx.days, 2),
    totals: {
      runs: ds.runs.length,
      jobs: ctx.records.length,
      cost,
      monthlyCost: ctx.monthlyMoney(ctx.totalMinutes, ctx.totalUsd),
      wastedCost: wastedCost(ctx, flaky, superseded),
      queueHours: queueHours(ctx),
      byOs: byOs(ctx),
    },
    workflows: workflowStats(ctx),
    jobs: jobStats(ctx),
    slowSteps: stepStats(ctx),
    flaky: flaky.map((d) => d.flaky),
    findings,
    pricing: opts.pricing,
    devHourlyUsd: opts.devHourlyUsd,
  };
}
