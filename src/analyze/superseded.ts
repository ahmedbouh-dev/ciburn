// Superseded-run detection (basis of the missing-concurrency finding).
//
// Rule: for push / pull_request runs, group by (workflowPath, event, headBranch) — this mirrors a
// `concurrency.group` of `${{ github.workflow }}-${{ github.ref }}` (push and PR refs differ).
// Within a group, sorted by createdAt, run A is SUPERSEDED when a newer run B in the same group was
// created while A's first attempt was still running (B.createdAt < last completedAt of A's
// attempt-1 jobs). If A was then cancelled, concurrency (or a human) did its job. If A was NOT
// cancelled, every billable minute after B was created is waste:
//   waste(job) = billable(job) - ceil(max(0, B.createdAt - job.startedAt) / 60)
// i.e. what GitHub would have stopped billing had the job been cancelled at that moment.
// Only attempt 1 is considered: re-runs are deliberate and not superseded by new pushes.

import type { Run } from "../types.ts";
import type { Ctx, JobRecord } from "./context.ts";
import { ms } from "./context.ts";
import { groupBy } from "./stats.ts";

export interface SupersededRun {
  run: Run;
  newer: Run;
  cancelled: boolean;
  /** Per-job billable waste (only for non-cancelled runs). */
  jobWaste: Array<{ rec: JobRecord; minutes: number; usd: number }>;
  /** Running time after the newer run was created (wall clock). */
  overlapSec: number;
  branchKind: "pr" | "feature-push" | "default-push";
}

function firstAttemptJobs(ctx: Ctx, run: Run): JobRecord[] {
  return (ctx.recordsByRun.get(run.id) ?? []).filter((r) => r.job.runAttempt === 1);
}

function runEnd(recs: readonly JobRecord[], run: Run): number | null {
  let end: number | null = null;
  for (const r of recs) {
    const t = ms(r.job.completedAt);
    if (t !== null && (end === null || t > end)) end = t;
  }
  return end ?? (run.runAttempt === 1 ? ms(run.updatedAt) : null);
}

/**
 * Best guess of the default branch: the branch scheduled runs use (schedules always run on the
 * default branch), else "main"/"master" if seen in pushes, else the most pushed-to branch.
 */
export function guessDefaultBranch(runs: readonly Run[]): string {
  const counts = (rs: readonly Run[]) => {
    const m = new Map<string, number>();
    for (const r of rs) if (r.headBranch) m.set(r.headBranch, (m.get(r.headBranch) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const sched = counts(runs.filter((r) => r.event === "schedule"));
  if (sched.length) return sched[0]![0];
  const pushes = counts(runs.filter((r) => r.event === "push"));
  for (const name of ["main", "master"]) if (pushes.some(([b]) => b === name)) return name;
  return pushes[0]?.[0] ?? "main";
}

export function detectSuperseded(ctx: Ctx): SupersededRun[] {
  const defaultBranch = guessDefaultBranch(ctx.ds.runs);
  const candidates = ctx.ds.runs.filter((r) => (r.event === "push" || r.event === "pull_request") && r.headBranch);
  const out: SupersededRun[] = [];
  for (const group of groupBy(candidates, (r) => `${r.workflowPath}\u0000${r.event}\u0000${r.headBranch}`).values()) {
    group.sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
    for (let i = 0; i < group.length - 1; i++) {
      const run = group[i]!;
      const recs = firstAttemptJobs(ctx, run);
      const start = ms(run.createdAt);
      const end = runEnd(recs, run);
      if (start === null || end === null) continue;
      const newer = group.slice(i + 1).find((n) => {
        const t = ms(n.createdAt);
        return t !== null && t > start && t < end;
      });
      if (!newer) continue;
      const cut = ms(newer.createdAt)!;
      const cancelled =
        recs.some((r) => r.job.conclusion === "cancelled") || (run.runAttempt === 1 && run.conclusion === "cancelled");
      const jobWaste: SupersededRun["jobWaste"] = [];
      if (!cancelled) {
        for (const rec of recs) {
          if (rec.minutes === 0) continue;
          const started = ms(rec.job.startedAt)!;
          const keptMinutes = started >= cut ? 0 : Math.ceil((cut - started) / 60_000);
          const minutes = Math.max(0, rec.minutes - keptMinutes);
          if (minutes > 0) jobWaste.push({ rec, minutes, usd: minutes * rec.pricePerMin });
        }
      }
      out.push({
        run,
        newer,
        cancelled,
        jobWaste,
        overlapSec: Math.max(0, (end - cut) / 1000),
        branchKind: run.event === "pull_request" ? "pr" : run.headBranch === defaultBranch ? "default-push" : "feature-push",
      });
    }
  }
  return out;
}
