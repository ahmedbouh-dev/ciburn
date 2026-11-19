// Flaky job detection.
//
// Rule: group job executions by (workflowPath, jobName, headSha) across ALL runs and attempts.
// Order them by (run.createdAt, runAttempt, job.startedAt). A group is a flaky occurrence when a
// job concluded `failure`/`timed_out` and a LATER execution of the same job on the same commit
// concluded `success` — same code, different outcome. The failed executions preceding that
// success are the wasted cost. `occurrences` counts sha groups with at least one conclusive
// (success/failure/timed_out) execution, so flakeRate = flakyCount / occurrences.

import type { FlakyJob } from "../types.ts";
import type { Ctx, JobRecord } from "./context.ts";
import { ms } from "./context.ts";
import { costOf } from "./aggregate.ts";
import { groupBy, round } from "./stats.ts";

const FAILED = new Set(["failure", "timed_out"]);

export interface FlakyDetail {
  workflowPath: string;
  flaky: FlakyJob;
  /** Failed executions that were later followed by a success on the same sha. */
  failedRecs: JobRecord[];
  /** Name of the first failed step in each flaky failure -> count. */
  failingSteps: Map<string, number>;
  /** Time from the flaky failure completing to the green execution completing, per occurrence. */
  recoveryDelaysSec: number[];
  /** Duration of the execution that turned green, per occurrence (the minimum a developer waits). */
  retryDurationsSec: number[];
  /** All executions of this job (for snippet heuristics). */
  allRecs: JobRecord[];
}

function order(a: JobRecord, b: JobRecord): number {
  return (
    (ms(a.run.createdAt) ?? 0) - (ms(b.run.createdAt) ?? 0) ||
    a.job.runAttempt - b.job.runAttempt ||
    (ms(a.job.startedAt) ?? 0) - (ms(b.job.startedAt) ?? 0)
  );
}

export function detectFlaky(ctx: Ctx): FlakyDetail[] {
  const byJob = groupBy(ctx.records, (r) => `${r.workflowPath}\u0000${r.job.name}`);
  const out: FlakyDetail[] = [];
  for (const recs of byJob.values()) {
    let occurrences = 0;
    let flakyCount = 0;
    const failedRecs: JobRecord[] = [];
    const failingSteps = new Map<string, number>();
    const delays: number[] = [];
    const retries: number[] = [];
    const examples: string[] = [];

    for (const group of groupBy(recs, (r) => r.run.headSha).values()) {
      const seq = group.filter((r) => r.job.conclusion !== null && (FAILED.has(r.job.conclusion) || r.job.conclusion === "success"));
      if (seq.length === 0) continue;
      occurrences++;
      seq.sort(order);
      let pending: JobRecord[] = [];
      let isFlaky = false;
      for (const r of seq) {
        if (FAILED.has(r.job.conclusion!)) {
          pending.push(r);
          continue;
        }
        // success
        if (pending.length > 0) {
          isFlaky = true;
          failedRecs.push(...pending);
          for (const f of pending) {
            const step = f.job.steps.find((s) => s.conclusion !== null && FAILED.has(s.conclusion));
            if (step) failingSteps.set(step.name, (failingSteps.get(step.name) ?? 0) + 1);
          }
          const failedAt = ms(pending[0]!.job.completedAt);
          const greenAt = ms(r.job.completedAt);
          if (failedAt !== null && greenAt !== null && greenAt > failedAt) delays.push((greenAt - failedAt) / 1000);
          if (r.durationSec !== null) retries.push(r.durationSec);
          if (examples.length < 5) examples.push(pending[0]!.run.htmlUrl);
          pending = [];
        }
      }
      if (isFlaky) flakyCount++;
    }

    if (flakyCount === 0) continue;
    const first = recs[0]!;
    out.push({
      workflowPath: first.workflowPath,
      flaky: {
        workflowName: first.workflowName,
        jobName: first.job.name,
        flakyCount,
        occurrences,
        flakeRate: round(flakyCount / occurrences, 4),
        wastedCost: costOf(failedRecs),
        examples,
      },
      failedRecs,
      failingSteps,
      recoveryDelaysSec: delays,
      retryDurationsSec: retries,
      allRecs: recs,
    });
  }
  return out.sort((a, b) => b.flaky.flakyCount - a.flaky.flakyCount || b.flaky.wastedCost.usd - a.flaky.wastedCost.usd);
}
