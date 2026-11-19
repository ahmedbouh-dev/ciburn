// Finding detectors. Every detector documents its rule, gates on volume to avoid noise, and
// computes savings from the data (normalized to 30 days via ctx.monthlyMoney).

import type { Finding, Money } from "../types.ts";
import type { Ctx, JobRecord } from "./context.ts";
import type { FlakyDetail } from "./flaky.ts";
import type { SupersededRun } from "./superseded.ts";
import { ms } from "./context.ts";
import { costOf, groupJobs, stepSamples } from "./aggregate.ts";
import type { StepSample } from "./aggregate.ts";
import { jobPricePerMinute } from "../pricing.ts";
import { fmtDuration, fmtPct, fmtUsd, fmtWindow, groupBy, money, percentile, round, sum } from "./stats.ts";

// ---------------------------------------------------------------------------
// Shared helpers

const FAILED = new Set(["failure", "timed_out"]);
const HUMAN_EVENTS = new Set(["push", "pull_request"]);

/**
 * Severity from monthly IMPACT (billing usd + devHoursSaved * devHourlyUsd), both absolute and
 * relative to the monthly CI bill:
 *   high:   >= $200, or >= $50 and >= 5% of spend, or >= $10 and >= 15% of spend
 *   medium: >= $20, or >= $5 and >= 3% of spend
 *   low:    everything else that passed the detector's gate
 */
export function severityFor(ctx: Ctx, monthlyUsd: number): Finding["severity"] {
  const monthlySpend = ctx.monthly(ctx.totalUsd);
  const share = monthlySpend > 0 ? monthlyUsd / monthlySpend : 0;
  if (monthlyUsd >= 200 || (monthlyUsd >= 50 && share >= 0.05) || (monthlyUsd >= 10 && share >= 0.15)) return "high";
  if (monthlyUsd >= 20 || (monthlyUsd >= 5 && share >= 0.03)) return "medium";
  return "low";
}

/** Minimum monthly impact to be worth showing: $1 billed, 1 developer hour, or 60 billable minutes. */
export function worthReporting(m: Money, devHours = 0): boolean {
  return m.usd >= 1 || devHours >= 1 || m.minutes >= 60;
}

/** Monthly impact used for ranking and severity: billing $ plus developer time priced at devHourlyUsd. */
export function impactUsd(f: Pick<Finding, "monthlySavings" | "devHoursSaved">, devHourlyUsd: number): number {
  return f.monthlySavings.usd + f.devHoursSaved * devHourlyUsd;
}

function evidence(recsOrUrls: ReadonlyArray<JobRecord | string>): string[] {
  const urls = recsOrUrls.map((x) => (typeof x === "string" ? x : x.run.htmlUrl));
  return [...new Set(urls)].slice(0, 5);
}

function code(s: string): string {
  return "`" + s.replace(/`/g, "'") + "`";
}

function jobRef(workflowName: string, jobName: string): string {
  return `${code(workflowName)} › ${code(jobName)}`;
}

/** Best guess of the YAML job id from a display name (matrix suffix dropped). */
function jobIdGuess(jobName: string): string {
  const base = baseJobName(jobName);
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "build";
}

/** "test (macos-latest, 20)" -> "test". Matrix jobs carry their parameters in parentheses. */
function baseJobName(jobName: string): string {
  return jobName.replace(/\s*\(.*\)\s*$/, "").trim() || jobName;
}

function yaml(body: string): string {
  return "```yaml\n" + body.trim() + "\n```";
}

type FindingInput = Omit<Finding, "severity" | "devHoursSaved"> & {
  severity?: Finding["severity"];
  devHoursSaved?: number;
};

function finding(ctx: Ctx, f: FindingInput): Finding {
  const full = { ...f, devHoursSaved: round(f.devHoursSaved ?? 0, 1) };
  return { ...full, severity: f.severity ?? severityFor(ctx, impactUsd(full, ctx.opts.devHourlyUsd)) };
}

// ---------------------------------------------------------------------------
// missing-concurrency

const CONCURRENCY_PR_ONLY = `
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const CONCURRENCY_ALL_BUT_DEFAULT = `
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.ref != format('refs/heads/{0}', github.event.repository.default_branch) }}
`;

/**
 * Rule (see superseded.ts for how a run is "superseded"): per workflow, ignore pushes to the
 * default branch (those usually must finish, and the suggested snippet never cancels them).
 * Skip the workflow if >= 50% of its superseded non-default-branch runs were cancelled — it already has concurrency.
 * Flag when >= 3 superseded runs kept running. Savings = billable minutes after the newer run
 * started. If superseded feature-branch PUSH runs exist, suggest the variant that cancels on every
 * non-default ref (the PR-only snippet would not save those).
 */
export function missingConcurrency(ctx: Ctx, superseded: readonly SupersededRun[]): Finding[] {
  const out: Finding[] = [];
  for (const all of groupBy(superseded, (s) => s.run.workflowPath).values()) {
    // Concurrency evidence only from refs it would apply to: default-branch pushes usually finish
    // on purpose (react-native: 6/6 superseded PR runs cancelled, 10 main pushes not).
    const inScope = all.filter((s) => s.branchKind !== "default-push");
    const cancelled = inScope.filter((s) => s.cancelled).length;
    if (inScope.length === 0 || cancelled / inScope.length >= 0.5) continue;
    const countable = all.filter((s) => !s.cancelled && s.branchKind !== "default-push");
    if (countable.length < 3) continue;
    const featurePush = countable.filter((s) => s.branchKind === "feature-push");
    const pr = countable.filter((s) => s.branchKind === "pr");
    const waste = countable.flatMap((s) => s.jobWaste);
    const minutes = sum(waste.map((w) => w.minutes));
    const usd = sum(waste.map((w) => w.usd));
    const monthlySavings = ctx.monthlyMoney(minutes, usd);
    if (!worthReporting(monthlySavings)) continue;

    const wf = countable[0]!.run;
    const name = wf.workflowName || wf.workflowPath;
    const runsInScope = ctx.ds.runs.filter(
      (r) => r.workflowPath === wf.workflowPath && HUMAN_EVENTS.has(r.event),
    ).length;
    const overlap = percentile(countable.map((s) => s.overlapSec), 50);
    const defaultPush = all.filter((s) => !s.cancelled && s.branchKind === "default-push").length;
    const what = pr.length >= featurePush.length ? "PR builds" : "branch builds";
    const snippet = featurePush.length > 0 ? CONCURRENCY_ALL_BUT_DEFAULT : CONCURRENCY_PR_ONLY;

    let detail =
      `${countable.length} of ${runsInScope} push/PR runs of ${code(name)} kept running after a newer commit landed on the same ` +
      `branch/PR (${pr.length} PR, ${featurePush.length} branch push; median ${fmtDuration(overlap)} of overlap). ` +
      `That burned ${round(minutes, 0)} billable min (${fmtUsd(usd)}) in ${fmtWindow(ctx.days)} on results nobody looks at.`;
    if (defaultPush > 0) {
      detail += ` ${defaultPush} overlapping push${defaultPush === 1 ? "" : "es"} to the default branch ${defaultPush === 1 ? "was" : "were"} excluded on purpose.`;
    }

    out.push(
      finding(ctx, {
        kind: "missing-concurrency",
        title: `Superseded ${what} keep running in ${code(name)}`,
        detail,
        fix:
          `Add a top-level \`concurrency\` block to \`${wf.workflowPath}\` so a new push cancels the outdated run of the ` +
          `same ref (runs on the default branch still complete):\n\n${yaml(snippet)}`,
        monthlySavings,
        workflowName: name,
        evidence: evidence(countable.map((s) => s.run.htmlUrl)),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// flaky-job

/**
 * Framework-specific retry snippets only when the FAILING step names (where the flakes actually
 * happen) name the framework. Other steps of the job are not evidence: vite's Windows job installs
 * Playwright but flakes in `Test serve`, which says nothing about the test runner.
 */
export function flakyFixFor(d: FlakyDetail, topStep: string | null): string {
  const names = [...d.failingSteps.keys()].join(" ").toLowerCase();
  const exampleRunId = /\/runs\/(\d+)/.exec(d.flaky.examples[0] ?? "")?.[1] ?? "<run-id>";
  const triage =
    `Find the flaky test: \`gh run view ${exampleRunId} --log-failed\`` +
    (topStep ? ` (it fails in step ${code(topStep)}).` : ".") +
    " Quarantine or fix it; until then, retry inside the job instead of re-running the whole workflow:";
  if (names.includes("playwright")) {
    return `${triage}\n\n\`\`\`ts\n// playwright.config.ts\nexport default defineConfig({\n  retries: process.env.CI ? 2 : 0,\n  use: { trace: "on-first-retry" },\n});\n\`\`\``;
  }
  if (names.includes("cypress")) {
    return `${triage}\n\n\`\`\`ts\n// cypress.config.ts\nexport default defineConfig({ retries: { runMode: 2, openMode: 0 } });\n\`\`\``;
  }
  if (names.includes("pytest")) {
    return `${triage}\n\n${yaml(`
- run: uv run --with pytest-rerunfailures pytest --reruns 2 --reruns-delay 5
`)}`;
  }
  if (/\bvitest\b/.test(names)) return `${triage}\n\n${yaml(`- run: npx vitest run --retry=2`)}`;
  if (/\bjest\b/.test(names)) {
    return `${triage}\n\n\`\`\`ts\n// a file listed in jest's setupFilesAfterEnv\njest.retryTimes(2, { logErrorsBeforeRetry: true });\n\`\`\``;
  }
  return `${triage}\n\n${yaml(`
- uses: nick-fields/retry@v3
  with:
    timeout_minutes: 20
    max_attempts: 2
    command: <the command of step "${topStep ?? "tests"}">
`)}`;
}

/**
 * Rule: report flaky jobs (see flaky.ts) with flakeRate >= 5% AND >= 2 flaky occurrences.
 * monthlySavings = billable cost of the failed executions that were retried into green (billing only).
 * devHoursSaved  = developer time waiting for the green retry, per month (its duration: a
 *                  conservative lower bound; the full red->green delay is shown in the detail).
 */
export function flakyFindings(ctx: Ctx, flaky: readonly FlakyDetail[]): Finding[] {
  const out: Finding[] = [];
  for (const d of flaky) {
    const f = d.flaky;
    if (f.flakeRate < 0.05 || f.flakyCount < 2) continue;
    const waitHours = sum(d.retryDurationsSec) / 3600;
    const devHoursSaved = ctx.monthly(waitHours);
    const monthlySavings = ctx.monthlyMoney(f.wastedCost.minutes, f.wastedCost.usd);
    if (!worthReporting(monthlySavings, devHoursSaved)) continue;
    const top = [...d.failingSteps.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const delay = percentile(d.recoveryDelaysSec, 50);
    let detail =
      `${jobRef(f.workflowName, f.jobName)} failed and then passed on the same commit in ${f.flakyCount} of ${f.occurrences} ` +
      `commits (${fmtPct(f.flakeRate)} flake rate). The failed attempts burned ${f.wastedCost.minutes} billable min (${fmtUsd(f.wastedCost.usd)}).`;
    if (top) detail += ` Most flakes fail in step ${code(top[0])} (${top[1]}×).`;
    if (waitHours > 0) {
      detail +=
        ` Developers then waited at least ${round(waitHours, 1)} h for the green retries (developer time, not GitHub billing)` +
        (delay > 0 ? `; median time from red to green was ${fmtDuration(delay)}.` : ".");
    }
    out.push(
      finding(ctx, {
        kind: "flaky-job",
        title: `${jobRef(f.workflowName, f.jobName)} is flaky (${fmtPct(f.flakeRate)} of commits)`,
        detail,
        fix: flakyFixFor(d, top?.[0] ?? null),
        monthlySavings,
        devHoursSaved,
        workflowName: f.workflowName,
        jobName: f.jobName,
        evidence: f.examples.slice(0, 5),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// rerun-waste

/**
 * Rule: every job execution whose result was thrown away because a later attempt of the same run
 * re-executed that job (record.isFinal === false) is re-run waste. Jobs carried over unchanged by
 * "Re-run failed jobs" are not re-executed and not billed again (see context.isCarriedOver).
 * One aggregated finding when >= 3 runs were re-run. Savings exclude failed executions already
 * counted by flaky-job findings (no double counting). The detail also quantifies re-executions of
 * jobs that had ALREADY PASSED in the previous attempt ("Re-run all jobs" instead of "failed jobs").
 */
export function rerunWaste(ctx: Ctx, flaky: readonly FlakyDetail[]): Finding[] {
  const earlier = ctx.records.filter((r) => !r.isFinal && r.minutes > 0);
  const rerunRuns = ctx.ds.runs.filter((r) => r.runAttempt > 1);
  if (rerunRuns.length < 3 || earlier.length === 0) return [];
  const claimed = new Set(flaky.flatMap((d) => d.failedRecs.map((r) => r.job.id)));
  const unclaimed = earlier.filter((r) => !claimed.has(r.job.id));
  const total = costOf(earlier);
  const savingsRaw = costOf(unclaimed);
  const monthlySavings = ctx.monthlyMoney(savingsRaw.minutes, savingsRaw.usd);
  if (!worthReporting(monthlySavings)) return [];

  // Jobs re-executed although they had passed in the previous attempt.
  const passedAgain: JobRecord[] = [];
  for (const run of rerunRuns) {
    const recs = ctx.recordsByRun.get(run.id) ?? [];
    for (const r of recs) {
      if (r.job.runAttempt < 2 || r.minutes === 0) continue;
      // Nearest earlier execution of the same job (copies were already dropped in context.ts).
      const prev = recs
        .filter((p) => p.job.runAttempt < r.job.runAttempt && p.job.name === r.job.name)
        .sort((a, b) => b.job.runAttempt - a.job.runAttempt)[0];
      if (prev && prev.job.conclusion === "success") passedAgain.push(r);
    }
  }
  const passedCost = costOf(passedAgain);
  const byWf = [...groupBy(earlier, (r) => r.workflowName).entries()]
    .map(([wf, recs]) => ({ wf, usd: sum(recs.map((r) => r.usd)) }))
    .sort((a, b) => b.usd - a.usd);
  const top = byWf[0]!;

  const claimedCost = costOf(earlier.filter((r) => claimed.has(r.job.id)));
  let detail =
    `${rerunRuns.length} runs were re-run; ${earlier.length} job executions (${total.minutes} billable min, ${fmtUsd(total.usd)}) ` +
    `were thrown away by a later attempt, ${fmtPct(top.usd / Math.max(total.usd, 1e-9))} of it in ${code(top.wf)}.`;
  if (claimedCost.minutes > 0) {
    detail += ` ${claimedCost.minutes} min of that are flaky failures counted in their own findings; the remaining ${savingsRaw.minutes} min (${fmtUsd(savingsRaw.usd)}) are counted here.`;
  }
  const mostlyRerunAll = passedCost.usd >= savingsRaw.usd / 2 && passedAgain.length > 0;
  if (passedAgain.length > 0) {
    detail += ` ${passedAgain.length} re-executions were of jobs that had already passed ("Re-run all jobs"): ${passedCost.minutes} min (${fmtUsd(passedCost.usd)}).`;
  }

  const exampleId = /\/runs\/(\d+)/.exec(rerunRuns[0]!.htmlUrl)?.[1] ?? "<run-id>";
  const rerunFailedHint =
    passedAgain.length > 0
      ? `Re-run only what failed: use **Re-run failed jobs** in the UI or \`gh run rerun ${exampleId} --failed\` instead of re-running all jobs. `
      : "";
  return [
    finding(ctx, {
      kind: "rerun-waste",
      title: mostlyRerunAll
        ? `Re-runs repeat jobs that already passed, mostly in ${code(top.wf)}`
        : `Retrying failures without code changes, mostly in ${code(top.wf)}`,
      detail,
      fix:
        rerunFailedHint +
        `A re-run without a code change only helps when the failure is flaky: find the unstable job (see the flaky-job ` +
        `findings) and fix it, or retry just the unstable step in-job instead of re-running the job:\n\n${yaml(`
- uses: nick-fields/retry@v3
  with:
    timeout_minutes: 15
    max_attempts: 2
    command: <unstable command>
`)}`,
      monthlySavings,
      workflowName: top.wf,
      evidence: evidence(rerunRuns.map((r) => r.htmlUrl)),
    }),
  ];
}

// ---------------------------------------------------------------------------
// cancelled-waste

/**
 * Rule: billable minutes of jobs that concluded `cancelled`, EXCLUDING superseded runs that were
 * cancelled (that is concurrency working as intended). Flag only when this is >= 10% of total
 * spend. Savings assume half is avoidable (conservative: some cancellations are legitimate).
 * Cancelled jobs in runs that concluded `failure` are attributed to fail-fast (a sibling failed).
 */
export function cancelledWaste(ctx: Ctx, superseded: readonly SupersededRun[]): Finding[] {
  const concurrencyCancelled = new Set(superseded.filter((s) => s.cancelled).map((s) => s.run.id));
  const recs = ctx.records.filter(
    (r) => r.job.conclusion === "cancelled" && r.minutes > 0 && !concurrencyCancelled.has(r.run.id),
  );
  if (recs.length === 0 || ctx.totalUsd <= 0) return [];
  const cost = costOf(recs);
  const share = cost.usd / ctx.totalUsd;
  if (share < 0.1) return [];
  const monthlySavings = ctx.monthlyMoney(cost.minutes * 0.5, cost.usd * 0.5);
  if (!worthReporting(monthlySavings)) return [];

  const failFast = recs.filter((r) => r.run.conclusion === "failure");
  const byWf = [...groupBy(recs, (r) => r.workflowName).entries()]
    .map(([wf, rs]) => ({ wf, usd: sum(rs.map((r) => r.usd)), jobs: rs }))
    .sort((a, b) => b.usd - a.usd);
  const top = byWf[0]!;
  const runs = new Set(recs.map((r) => r.run.id)).size;
  const mostlyFailFast = failFast.length >= recs.length / 2;
  const cheapJob = top.jobs[0]!.job.name;

  const detail =
    `${recs.length} cancelled jobs in ${runs} runs burned ${cost.minutes} billable min (${fmtUsd(cost.usd)}, ` +
    `${fmtPct(share)} of all spend) before being stopped; ${fmtPct(top.usd / cost.usd)} of it in ${code(top.wf)}. ` +
    `${failFast.length} were cancelled because a sibling job failed, ${recs.length - failFast.length} by hand or by other means. ` +
    `Savings assume half of this is avoidable.`;
  const fix = mostlyFailFast
    ? `Expensive jobs run in parallel with jobs that fail first. Gate them behind the cheap checks so a lint/type error ` +
      `stops the run before the expensive minutes start:\n\n${yaml(`
jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps: [...]
  ${jobIdGuess(cheapJob)}:
    needs: lint   # starts only after lint passed
`)}`
    : `Runs are being stopped by hand after burning minutes. Cancel outdated runs automatically and fail faster:\n\n${yaml(`
${CONCURRENCY_PR_ONLY.trim()}
`)}\n\nand set \`timeout-minutes\` on long jobs so hung jobs don't need manual cancellation.`;

  return [
    finding(ctx, {
      kind: "cancelled-waste",
      title: `Cancelled jobs burn ${fmtPct(share)} of CI spend, mostly in ${code(top.wf)}`,
      detail,
      fix,
      monthlySavings,
      workflowName: top.wf,
      evidence: evidence(recs),
    }),
  ];
}

// ---------------------------------------------------------------------------
// expensive-runner

// Words that mean the work needs macOS/Windows. Matched on TOKENS (see platformSpecific), because
// job ids like "test_e2e_ios_rntester" defeat \b (underscore is a word character).
const PLATFORM_WORDS = new Set([
  "ios", "ipados", "tvos", "watchos", "visionos", "macos", "osx", "mac", "catalyst", "apple", "xcode",
  "xcodebuild", "xcframework", "xcresult", "swift", "swiftpm", "spm", "cocoapods", "pod", "pods",
  "podfile", "fastlane", "testflight", "notarize", "notarization", "notarytool", "codesign", "dmg",
  "homebrew", "brew", "windows", "win", "win32", "win64", "msvc", "msbuild", "nuget", "powershell",
  "pwsh", "choco", "chocolatey", "wix", "signtool", "msi", "msix", "appx", "uwp", "winui", "vcpkg",
]);

/** True when the text names macOS/Windows-only tooling. "(non-windows)" labels are ignored. */
export function platformSpecific(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/\bnon-?\s?[a-z]+\b/g, " ")
    .split(/[^a-z0-9]+/);
  return tokens.some((t) => PLATFORM_WORDS.has(t));
}
const GENERIC_STEPS = /^(set up job|complete job|post .*|run actions\/checkout.*|checkout.*)$/i;
// Hosted runner labels as they appear in matrix job names: "macos-latest", "windows-2022", "ubuntu-24.04-arm".
const OS_TOKEN_G = /\b(?:macos|windows|ubuntu)-[a-z0-9.]+(?:-[a-z0-9]+)*/gi;

/**
 * Key that is identical for all OS legs of one matrix job, or null for non-matrix names:
 * "test (macos-latest)" and "test (ubuntu-latest)" -> "test (<os>)";
 * "Build&Test: node-26, windows-latest" -> "Build&Test: node-26, <os>".
 */
export function matrixKey(jobName: string): string | null {
  // Only runner-label tokens count. A bare "(Debug, ios-simulator)" suffix is a build variant, not
  // an OS leg (react-native's build-rn-slice matrix runs every variant on macOS).
  if (new RegExp(OS_TOKEN_G.source, "i").test(jobName)) return jobName.replace(OS_TOKEN_G, "<os>");
  return null;
}

/**
 * Rules:
 * (a) macOS/Windows jobs costing >= 10% of total spend (or >= $50/month). Skipped when the job name
 *     or step names look platform-specific (xcode, swift, msbuild, ...). Matrix legs such as
 *     "test (macos-latest)" are never skipped: if a linux leg of the same job exists, suggest running
 *     the non-linux legs only outside PRs (savings = cost of the non-linux leg on pull_request runs);
 *     otherwise savings = cost - same minutes at the linux rate.
 * (b) Larger linux runners (> 2 cores) with p50 duration < 2 min over >= 5 runs are oversized.
 *     Savings = cost - cost on a 2-core runner assuming it takes 2x as long (conservative).
 */
export function expensiveRunners(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  const groups = groupJobs(ctx);
  // matrix key -> name of the linux leg, e.g. "Build&Test: node-26, <os>" -> "Build&Test: node-26, ubuntu-latest"
  const linuxLeg = new Map<string, string>();
  for (const recs of groups.values()) {
    for (const r of recs) {
      const key = matrixKey(r.job.name);
      // Only executed jobs with real labels: skipped jobs have labels [] which classify as linux.
      if (r.os === "linux" && r.minutes > 0 && r.job.labels.length > 0 && key !== null) {
        linuxLeg.set(`${r.workflowPath}\u0000${key}`, r.job.name);
      }
    }
  }

  for (const recs of groups.values()) {
    const billed = recs.filter((r) => r.minutes > 0);
    if (billed.length === 0) continue;
    const first = billed[billed.length - 1]!;
    const { workflowName, workflowPath } = first;
    const jobName = first.job.name;
    const cost = costOf(billed);

    if (first.os === "macos" || first.os === "windows") {
      const share = ctx.totalUsd > 0 ? cost.usd / ctx.totalUsd : 0;
      if (share < 0.1 && ctx.monthly(cost.usd) < 50) continue;
      const key = matrixKey(jobName);
      // Evidence of platform-specific work = steps that actually ran on this runner. Steps skipped by
      // an `if: runner.os == 'Windows'` guard, "(non-windows) ..." labels and runner tokens in matrix
      // names ("..., macos-latest") are not evidence (all seen in vitejs/vite).
      const stepText = first.job.steps
        .filter((s) => s.conclusion !== "skipped" && !GENERIC_STEPS.test(s.name))
        .map((s) => s.name)
        .join(" ");
      if (platformSpecific(`${workflowName} ${jobName.replace(OS_TOKEN_G, " ")} ${stepText}`)) continue;
      const osLabel = first.os === "macos" ? "macOS" : "Windows";
      const rate = first.pricePerMin;
      const linuxSibling = key === null ? undefined : linuxLeg.get(`${workflowPath}\u0000${key}`);

      if (linuxSibling !== undefined) {
        const prRecs = billed.filter((r) => r.run.event === "pull_request");
        const saved = costOf(prRecs);
        const monthlySavings = ctx.monthlyMoney(saved.minutes, saved.usd);
        if (!worthReporting(monthlySavings)) continue;
        out.push(
          finding(ctx, {
            kind: "expensive-runner",
            title: `${osLabel} matrix leg ${jobRef(workflowName, jobName)} runs on every PR`,
            detail:
              `${jobRef(workflowName, jobName)} cost ${fmtUsd(cost.usd)} (${fmtPct(share)} of all spend) at $${round(rate, 3)}/min — ` +
              `${round(rate / ctx.opts.pricing.linux, 1)}× the linux rate — and ${prRecs.length} of its ${billed.length} runs were on pull requests, ` +
              `where the linux leg ${code(linuxSibling)} already runs the same job. Savings = dropping the ${osLabel} leg on PRs only.`,
            fix:
              `Run the full OS matrix on the default branch and nightly, linux only on PRs:\n\n${yaml(`
strategy:
  matrix:
    os: \${{ github.event_name == 'pull_request' && fromJSON('["ubuntu-latest"]') || fromJSON('["ubuntu-latest", "${first.os === "macos" ? "macos-latest" : "windows-latest"}"]') }}
runs-on: \${{ matrix.os }}
`)}`,
            monthlySavings,
            workflowName,
            jobName,
            evidence: evidence(prRecs),
          }),
        );
        continue;
      }

      const linuxUsd = sum(billed.map((r) => r.minutes * ctx.opts.pricing.linux));
      const monthlySavings = ctx.monthlyMoney(0, cost.usd - linuxUsd);
      if (!worthReporting(monthlySavings)) continue;
      out.push(
        finding(ctx, {
          kind: "expensive-runner",
          title: `${jobRef(workflowName, jobName)} runs on ${osLabel} at ${round(rate / ctx.opts.pricing.linux, 1)}× the linux price`,
          detail:
            `${jobRef(workflowName, jobName)} used ${cost.minutes} min on ${osLabel} (${fmtUsd(cost.usd)}, ${fmtPct(share)} of all spend). ` +
            `None of its step names look ${osLabel}-specific. The same minutes on ubuntu-latest would cost ${fmtUsd(linuxUsd)} ` +
            `(assuming equal duration; linux runners are usually as fast or faster for platform-independent work).`,
          fix:
            `Check whether any step really needs ${osLabel}. If not, switch the runner — and keep a ${osLabel} smoke test on the ` +
            `default branch if you ship for that platform:\n\n${yaml(`
jobs:
  ${jobIdGuess(jobName)}:
    runs-on: ubuntu-latest
`)}`,
          monthlySavings,
          workflowName,
          jobName,
          evidence: evidence(billed),
        }),
      );
      continue;
    }

    // (b) oversized larger linux runners
    if (first.os === "linux" && first.cores !== null && first.cores > 2) {
      const durs = billed.flatMap((r) => (r.durationSec === null ? [] : [r.durationSec]));
      if (durs.length < 5) continue;
      const p50 = percentile(durs, 50);
      if (p50 >= 120) continue;
      const stdUsd = sum(
        billed.map((r) => Math.ceil((2 * (r.durationSec ?? 0)) / 60) * jobPricePerMinute(["ubuntu-latest"], ctx.opts.pricing)),
      );
      const saved = cost.usd - stdUsd;
      const monthlySavings = ctx.monthlyMoney(0, saved);
      if (saved <= 0 || !worthReporting(monthlySavings)) continue;
      out.push(
        finding(ctx, {
          kind: "expensive-runner",
          title: `${jobRef(workflowName, jobName)} uses a ${first.cores}-core runner for a ${fmtDuration(p50)} job`,
          detail:
            `${jobRef(workflowName, jobName)} runs on ${code(first.job.labels.join(", "))} ($${round(first.pricePerMin, 3)}/min) but its median ` +
            `duration is ${fmtDuration(p50)} over ${durs.length} runs — every job is billed at least a full minute. Even at twice the ` +
            `duration a standard 2-core runner would cost ${fmtUsd(stdUsd)} instead of ${fmtUsd(cost.usd)}.`,
          fix: `Use a standard runner for short jobs; keep larger runners for builds that actually saturate the cores:\n\n${yaml(`
jobs:
  ${jobIdGuess(jobName)}:
    runs-on: ubuntu-latest
`)}`,
          monthlySavings,
          workflowName,
          jobName,
          evidence: evidence(billed),
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// slow-step

type Eco =
  | "pnpm" | "npm" | "yarn" | "uv" | "pip" | "bundler" | "gradle" | "maven" | "cargo" | "go"
  | "docker" | "apt" | "cocoapods" | "generic";

// Order matters: first match wins. Specific tools come before the generic "dependencies" rule
// ("Install the CocoaPods dependencies" is CocoaPods, not the job's JS package manager).
const INSTALL_PATTERNS: Array<[RegExp, Eco]> = [
  [/\bpod (install|update)\b|\binstall\b.*\bcocoapods\b|\bcocoapods\b.*\b(install|dependencies)\b/i, "cocoapods"],
  [/\bpnpm (i|install|fetch)\b/i, "pnpm"],
  [/\byarn install\b|\byarn(\s+--[\w-]+)*\s*$/i, "yarn"],
  [/\bnpm (ci|install|i)\b/i, "npm"],
  [/\buv (sync|pip install)\b/i, "uv"],
  [/\b(pip3? install|poetry install|pipenv install)\b/i, "pip"],
  [/\bbundle install\b/i, "bundler"],
  [/\bgradlew?\b/i, "gradle"],
  [/\b(mvn|maven)\b/i, "maven"],
  [/\bcargo (build|fetch|install|test)\b/i, "cargo"],
  [/\bgo (mod download|build|test)\b/i, "go"],
  [/\bdocker (build|buildx)\b|build-push-action/i, "docker"],
  [/\bapt(-get)? (install|update)\b/i, "apt"],
  [/^(run )?install\b|\binstall (dependencies|deps|packages)\b|\bdependencies\b/i, "generic"],
  [/^(set ?up|setup)\b/i, "generic"],
];

// GitHub's own bookkeeping steps — never cache candidates.
const NON_CANDIDATE = /^(set up job|complete job|post .*|.*checkout.*)$/i;
// A step that restores a cache: anything named "cache", or actions that cache by default.
const CACHE_STEP = /cache|actions\/setup-go|setup-gradle|rust-cache|bundler-cache/i;

function classifyStep(name: string): Eco | null {
  if (NON_CANDIDATE.test(name)) return null;
  for (const [re, eco] of INSTALL_PATTERNS) if (re.test(name)) return eco;
  return null;
}

/** Resolve a generic install step to an ecosystem using other step names of the same job. */
/**
 * Resolve a generic install step ("Install dependencies") to an ecosystem, but only when another
 * step of the same job names the package manager explicitly. "Set up Node" alone is not enough to
 * pick npm over pnpm/yarn, so that stays generic (actions/cache snippet).
 */
export function inferEco(eco: Eco, jobStepNames: readonly string[]): Eco {
  if (eco !== "generic") return eco;
  const all = jobStepNames.join(" \n ");
  const rules: Array<[RegExp, Eco]> = [
    [/\bpnpm\b/i, "pnpm"],
    [/\byarn\b/i, "yarn"],
    [/\bnpm\b/i, "npm"],
    [/\bsetup-uv\b|\buv (sync|run|pip)\b/i, "uv"],
    [/\b(pip3?|poetry|pipenv)\b/i, "pip"],
    [/\bbundler?\b|setup-ruby/i, "bundler"],
    [/\bgradlew?\b/i, "gradle"],
    [/\b(mvn|maven)\b/i, "maven"],
    [/\bcargo\b/i, "cargo"],
    [/setup-go\b|\bgo (mod|build|test)\b/i, "go"],
  ];
  const hits = rules.filter(([re]) => re.test(all)).map(([, e]) => e);
  // Exactly one candidate (pnpm and npm can co-occur: "npm i -g pnpm" -> prefer pnpm).
  if (hits.includes("pnpm")) return "pnpm";
  if (hits.includes("yarn")) return "yarn";
  return hits.length === 1 ? hits[0]! : "generic";
}

const CACHE_SNIPPETS: Record<Eco, string> = {
  pnpm: `
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
- run: pnpm install --frozen-lockfile
`,
  npm: `
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: npm
- run: npm ci
`,
  yarn: `
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: yarn
- run: yarn install --frozen-lockfile
`,
  uv: `
- uses: astral-sh/setup-uv@v6
  with:
    enable-cache: true
- run: uv sync --locked
`,
  pip: `
- uses: actions/setup-python@v5
  with:
    python-version: "3.13"
    cache: pip
- run: pip install -r requirements.txt
`,
  bundler: `
- uses: ruby/setup-ruby@v1
  with:
    bundler-cache: true   # runs bundle install and caches gems
`,
  gradle: `
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: 21
- uses: gradle/actions/setup-gradle@v4   # caches ~/.gradle
`,
  maven: `
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: 21
    cache: maven
`,
  cargo: `
- uses: Swatinem/rust-cache@v2
`,
  go: `
- uses: actions/setup-go@v5
  with:
    go-version-file: go.mod
    cache: true
`,
  docker: `
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
`,
  cocoapods: `
- uses: actions/cache@v4
  with:
    path: ios/Pods   # adjust to your Podfile directory
    key: \${{ runner.os }}-pods-\${{ hashFiles('**/Podfile.lock') }}
    restore-keys: \${{ runner.os }}-pods-
- run: pod install --project-directory=ios
`,
  apt: `
- uses: awalsh128/cache-apt-pkgs-action@v1
  with:
    packages: <your packages>
    version: 1.0
`,
  generic: `
- uses: actions/cache@v4
  with:
    path: <dependency directory>
    key: \${{ runner.os }}-deps-\${{ hashFiles('<lockfile>') }}
    restore-keys: \${{ runner.os }}-deps-
`,
};

interface SlowCandidate {
  jobName: string;
  name: string;
  eco: Eco;
  samples: StepSample[];
  p50: number;
  totalSec: number;
  /** A step that may cache internally (setup action of this ecosystem / local composite action). */
  opaqueCacheStep: string | null;
}

// Setup actions that have a `cache:` input we cannot see in step names, per ecosystem.
const SETUP_WITH_CACHE: Partial<Record<Eco, RegExp>> = {
  pnpm: /setup[- ]?node|node\.?js|install .*\bnode\b|\bnode\b.*(setup|install)/i,
  npm: /setup[- ]?node|node\.?js|install .*\bnode\b|\bnode\b.*(setup|install)/i,
  yarn: /setup[- ]?node|node\.?js|install .*\bnode\b|\bnode\b.*(setup|install)/i,
  pip: /setup[- ]?python|python.*setup/i,
  uv: /setup[- ]?uv/i,
  maven: /setup[- ]?java|java.*setup/i,
  gradle: /setup[- ]?java|java.*setup/i,
  bundler: /setup[- ]?ruby|ruby.*setup/i,
};
const LOCAL_COMPOSITE = /^run \.\/\.github\/actions\//i;
const ANY_SETUP_WITH_CACHE = /setup[- ]?(node|python|java|ruby|uv)|node\.?js/i;

/**
 * Rule: steps whose name matches an install/setup/dependency pattern, with >= 3 samples and a
 * p50 >= 45s, in a job where NO step looks like a cache (name contains "cache", or an action that
 * caches by default). Candidates are merged into ONE finding per (workflow, ecosystem) so the same
 * uncached `pnpm install` in 4 jobs is one fix, not 4 findings.
 * Savings = 60% of the matching steps' time (conservative cache-hit speedup), priced at each
 * job's per-minute rate.
 * Hedge: when the job has a setup action of that ecosystem ("Setup node.js") or a local composite
 * action, caching may already be on via a `cache:` input we can't see (facebook/react-native). The
 * finding then says so and assumes only 30% savings (install/link time remains even with a cache).
 */
export function slowSteps(ctx: Ctx): Finding[] {
  const candidates: Array<SlowCandidate & { workflowPath: string }> = [];
  const byJob = groupBy(stepSamples(ctx), (s) => `${s.rec.workflowPath}\u0000${s.rec.job.name}`);
  for (const jobSamples of byJob.values()) {
    const allNames = [...new Set(jobSamples.map((s) => s.stepName))];
    if (allNames.some((n) => CACHE_STEP.test(n))) continue;
    for (const [name, ss] of groupBy(jobSamples, (s) => s.stepName)) {
      const eco = classifyStep(name);
      if (!eco || ss.length < 3) continue;
      const p50 = percentile(ss.map((s) => s.sec), 50);
      if (p50 < 45) continue;
      const rec = ss[0]!.rec;
      const resolved = inferEco(eco, allNames);
      // Generic "Install dependencies": any setup action with a cache input could be caching it.
      const setupRe = SETUP_WITH_CACHE[resolved] ?? (resolved === "generic" ? ANY_SETUP_WITH_CACHE : undefined);
      const opaqueCacheStep =
        allNames.find((n) => n !== name && !/^post /i.test(n) && ((setupRe?.test(n) ?? false) || LOCAL_COMPOSITE.test(n))) ?? null;
      candidates.push({
        workflowPath: rec.workflowPath,
        jobName: rec.job.name,
        name,
        eco: resolved,
        samples: ss,
        p50,
        totalSec: sum(ss.map((s) => s.sec)),
        opaqueCacheStep,
      });
    }
  }

  const out: Finding[] = [];
  for (const group of groupBy(candidates, (c) => `${c.workflowPath}\u0000${c.eco}`).values()) {
    const all = group.flatMap((c) => c.samples);
    const totalSec = sum(all.map((s) => s.sec));
    const opaque = group.find((c) => c.opaqueCacheStep !== null)?.opaqueCacheStep ?? null;
    const factor = opaque ? 0.3 : 0.6;
    const savedMin = (factor * totalSec) / 60;
    const savedUsd = sum(all.map((s) => ((factor * s.sec) / 60) * s.rec.pricePerMin));
    const monthlySavings = ctx.monthlyMoney(savedMin, savedUsd);
    if (!worthReporting(monthlySavings)) continue;

    group.sort((a, b) => b.totalSec - a.totalSec);
    const top = group[0]!;
    const wfName = top.samples[0]!.rec.workflowName;
    const jobs = [...new Set(group.map((c) => c.jobName))];
    const where = jobs.length === 1 ? jobRef(wfName, jobs[0]!) : `${jobs.length} jobs of ${code(wfName)}`;
    const steps = new Set(group.map((c) => c.name));
    const perJob = group
      .slice(0, 6)
      .map((c) => `${code(c.jobName)}${steps.size > 1 ? ` ${code(c.name)}` : ""} ${fmtDuration(c.p50)}`)
      .join(", ");
    let detail =
      `${code(top.name)} takes a median ${fmtDuration(top.p50)} per run in ${where}` +
      (group.length > 1 ? ` (p50: ${perJob}${group.length > 6 ? ", …" : ""})` : "") +
      ` and no cache step was detected. Over ${fmtWindow(ctx.days)} these steps took ${fmtDuration(totalSec)} ` +
      `across ${all.length} job runs.`;
    detail += opaque
      ? ` The job also runs ${code(opaque)}, which may already cache via a \`cache:\` input this tool can't see — ` +
        `check it first; savings assume only 30% because install time remains even with a cache.`
      : " Savings assume a warm cache cuts them by 60%.";
    const what = top.eco === "docker" ? "Cache image layers" : top.eco === "apt" ? "Cache system packages" : "Cache dependencies";
    out.push(
      finding(ctx, {
        kind: "slow-step",
        title: opaque
          ? `${code(top.name)} takes ${fmtDuration(top.p50)} in ${where} — check its cache`
          : `${code(top.name)} runs uncached in ${where} (p50 ${fmtDuration(top.p50)})`,
        detail,
        fix: `${what} between runs${jobs.length > 1 ? ` (in each of: ${jobs.slice(0, 8).map(code).join(", ")}${jobs.length > 8 ? ", …" : ""})` : ""}:\n\n${yaml(CACHE_SNIPPETS[top.eco])}`,
        monthlySavings,
        workflowName: wfName,
        ...(jobs.length === 1 ? { jobName: jobs[0]! } : {}),
        evidence: evidence(top.samples.map((s) => s.rec)),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// long-queue

/**
 * Rule: only push / pull_request runs (a human is waiting). Per job: >= 5 samples and p95 queue
 * > 120s. Cost is DEVELOPER time, not GitHub billing: per run only the job with the longest queue
 * is counted (parallel waits overlap), minus a 30s baseline, priced at devHourlyUsd.
 */
export function longQueue(ctx: Ctx): Finding[] {
  const human = ctx.records.filter((r) => HUMAN_EVENTS.has(r.run.event) && r.queueSec !== null);
  // Per run: the record with the longest queue gets the run's waiting time.
  const runMax = new Map<number, JobRecord>();
  for (const r of human) {
    const cur = runMax.get(r.run.id);
    if (!cur || r.queueSec! > cur.queueSec!) runMax.set(r.run.id, r);
  }
  // Qualifying jobs, then ONE finding per (workflow, runner labels): five jobs waiting for the same
  // runner pool is one capacity problem (seen in facebook/react-native with `4-core-ubuntu`).
  const qualifying: JobRecord[][] = [];
  for (const recs of groupBy(human, (r) => `${r.workflowPath}\u0000${r.job.name}`).values()) {
    if (recs.length < 5) continue;
    if (percentile(recs.map((r) => r.queueSec!), 95) <= 120) continue;
    qualifying.push(recs);
  }
  const out: Finding[] = [];
  const pools = groupBy(qualifying, (g) => `${g[0]!.workflowPath}\u0000${[...g[g.length - 1]!.job.labels].sort().join(",")}`);
  for (const jobGroups of pools.values()) {
    const recs = jobGroups.flat();
    const queues = recs.map((r) => r.queueSec!);
    const p95 = percentile(queues, 95);
    const p50 = percentile(queues, 50);
    const waitSec = sum(recs.filter((r) => runMax.get(r.run.id) === r).map((r) => Math.max(0, r.queueSec! - 30)));
    // Queue time is not billed by GitHub: billing savings are zero, the impact is developer time.
    const monthlySavings = money(0, 0);
    const devHoursSaved = ctx.monthly(waitSec / 3600);
    if (!worthReporting(monthlySavings, devHoursSaved)) continue;
    const first = jobGroups[0]![jobGroups[0]!.length - 1]!;
    const jobNames = jobGroups.map((g) => g[0]!.job.name);
    const who = jobNames.length === 1 ? jobRef(first.workflowName, first.job.name) : `${jobNames.length} jobs of ${code(first.workflowName)}`;
    const labels = first.job.labels.join(", ");
    const runnerKind =
      first.os === "self-hosted" ? "self-hosted" : first.cores !== null && first.cores > 2 ? "larger" : first.os === "macos" ? "macOS" : "standard";
    const fix =
      runnerKind === "self-hosted"
        ? `Your self-hosted pool (${code(labels)}) is too small at peak. Autoscale it, e.g. with actions-runner-controller:\n\n${yaml(`
# values for gha-runner-scale-set (actions-runner-controller)
minRunners: 2      # keep warm runners for the morning peak
maxRunners: 20
`)}\n\nor route short jobs to GitHub-hosted runners with \`runs-on: ubuntu-latest\`.`
        : runnerKind === "larger"
          ? `Raise the maximum concurrency of the larger-runner group behind ${code(labels)} (Org settings → Actions → Runners → the runner → Auto-scaling), or move short jobs to \`ubuntu-latest\`.`
          : runnerKind === "macOS"
            ? `macOS runners have a much lower concurrency limit than linux. Run macOS jobs only where needed (e.g. default branch / nightly) so PR jobs don't queue.`
            : `Jobs are hitting the plan's concurrent-job limit. Cancel superseded runs with \`concurrency\` (see that finding), reduce matrix fan-out on PRs, or move to larger runners with a dedicated concurrency limit.`;
    out.push(
      finding(ctx, {
        kind: "long-queue",
        title: `${who} wait${jobNames.length === 1 ? "s" : ""} ${fmtDuration(p95)} for a ${code(labels)} runner (p95)`,
        detail:
          `On push/PR runs, ${who}${jobNames.length > 1 ? ` (${jobNames.slice(0, 4).map(code).join(", ")}${jobNames.length > 4 ? ", …" : ""})` : ""} ` +
          `waited a median ${fmtDuration(p50)} and p95 ${fmtDuration(p95)} for a ${runnerKind} runner over ${recs.length} job runs. ` +
          `This is developer waiting time, not GitHub billing: ${round(waitSec / 3600, 1)} h beyond a 30s baseline in ${fmtWindow(ctx.days)} ` +
          `(per run only the longest wait counts, parallel waits overlap).`,
        fix,
        monthlySavings,
        devHoursSaved,
        workflowName: first.workflowName,
        ...(jobNames.length === 1 ? { jobName: first.job.name } : {}),
        evidence: evidence([...recs].sort((a, b) => b.queueSec! - a.queueSec!)),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// timeout

const DEFAULT_TIMEOUT_MIN = 360;

/**
 * Rule: jobs that concluded `timed_out`, or ran >= 340 min (close to the 360 min default limit).
 * Suggested `timeout-minutes` = 2x the p95 duration of successful runs, rounded up to 5, min 10
 * (30 if the job never succeeded). Savings = billable minutes beyond that limit on the offending
 * runs. Flag if savings are worth reporting, or the job timed out >= 2 times (hangs).
 */
export function timeouts(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  for (const recs of groupJobs(ctx).values()) {
    const timedOut = recs.filter((r) => r.job.conclusion === "timed_out");
    const nearLimit = recs.filter(
      (r) => r.job.conclusion !== "timed_out" && (r.durationSec ?? 0) >= (DEFAULT_TIMEOUT_MIN - 20) * 60,
    );
    const offenders = [...timedOut, ...nearLimit];
    if (offenders.length === 0) continue;
    const okDur = recs.flatMap((r) => (r.job.conclusion === "success" && r.durationSec !== null ? [r.durationSec] : []));
    const suggested = okDur.length ? Math.max(10, Math.ceil((2 * percentile(okDur, 95)) / 60 / 5) * 5) : 30;
    const wasteMin = sum(offenders.map((r) => Math.max(0, r.minutes - suggested)));
    const wasteUsd = sum(offenders.map((r) => Math.max(0, r.minutes - suggested) * r.pricePerMin));
    const monthlySavings = ctx.monthlyMoney(wasteMin, wasteUsd);
    if (!worthReporting(monthlySavings) && timedOut.length < 2) continue;
    const first = recs[0]!;
    const offenderP50 = percentile(offenders.flatMap((r) => (r.durationSec === null ? [] : [r.durationSec])), 50);
    let detail =
      `${jobRef(first.workflowName, first.job.name)} ${timedOut.length ? `timed out ${timedOut.length}×` : ""}` +
      `${timedOut.length && nearLimit.length ? " and " : ""}${nearLimit.length ? `ran close to the 6 h default limit ${nearLimit.length}×` : ""}, ` +
      `running a median ${fmtDuration(offenderP50)} each time`;
    detail += okDur.length
      ? ` while successful runs take p95 ${fmtDuration(percentile(okDur, 95))}.`
      : `; it never succeeded in this window.`;
    if (wasteMin > 0) detail += ` A ${suggested}-minute limit would have saved ${round(wasteMin, 0)} billable min (${fmtUsd(wasteUsd)}).`;
    else detail += " The job already stops early, but it keeps hanging — investigate the step that stalls.";
    out.push(
      finding(ctx, {
        kind: "timeout",
        title: `${jobRef(first.workflowName, first.job.name)} hangs until the timeout`,
        detail,
        fix: `Set an explicit job timeout (the default is 360 minutes of billed runner time):\n\n${yaml(`
jobs:
  ${jobIdGuess(first.job.name)}:
    timeout-minutes: ${suggested}
`)}`,
        monthlySavings,
        workflowName: first.workflowName,
        jobName: first.job.name,
        evidence: evidence(offenders),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// schedule-noise

/**
 * Rule: per workflow, look at `schedule`-triggered runs only (>= 3 runs). Flag when the failure
 * rate is > 50% (nobody acts on a permanently red schedule) or the scheduled runs cost >= 15% of
 * total spend. Savings = max of:
 *   - frequency: if it runs > 1.1×/day, reducing to once per weekday (22 runs/month)
 *   - failures: cost of the failed scheduled runs (if failure rate > 50%)
 */
export function scheduleNoise(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  const sched = ctx.ds.runs.filter((r) => r.event === "schedule");
  for (const runs of groupBy(sched, (r) => r.workflowPath).values()) {
    if (runs.length < 3) continue;
    const recs = runs.flatMap((r) => ctx.recordsByRun.get(r.id) ?? []);
    const cost = costOf(recs);
    const concluded = runs.filter((r) => r.conclusion === "success" || (r.conclusion !== null && FAILED.has(r.conclusion)));
    const failedRuns = concluded.filter((r) => FAILED.has(r.conclusion!));
    const failureRate = concluded.length ? failedRuns.length / concluded.length : 0;
    const share = ctx.totalUsd > 0 ? cost.usd / ctx.totalUsd : 0;
    const failing = failureRate > 0.5;
    if (!failing && share < 0.15) continue;

    const perDay = runs.length / ctx.days;
    const monthlyRuns = ctx.monthly(runs.length);
    const perRun = { minutes: cost.minutes / runs.length, usd: cost.usd / runs.length };
    const freqSave = perDay > 1.1 ? Math.max(0, monthlyRuns - 22) : 0;
    const freqMoney = money(perRun.minutes * freqSave, perRun.usd * freqSave);
    const failedCost = costOf(failedRuns.flatMap((r) => ctx.recordsByRun.get(r.id) ?? []));
    const failMoney = failing ? ctx.monthlyMoney(failedCost.minutes, failedCost.usd) : money(0, 0);
    const monthlySavings = freqMoney.usd >= failMoney.usd ? freqMoney : failMoney;
    if (!worthReporting(monthlySavings)) continue;

    const wf = runs[0]!;
    const name = wf.workflowName || wf.workflowPath;
    // Most common first failing step among failed scheduled runs.
    const stepCounts = new Map<string, number>();
    for (const r of failedRuns) {
      for (const rec of ctx.recordsByRun.get(r.id) ?? []) {
        if (!rec.isFinal || !rec.job.conclusion || !FAILED.has(rec.job.conclusion)) continue;
        const st = rec.job.steps.find((s) => s.conclusion !== null && FAILED.has(s.conclusion));
        if (st) {
          const key = `${rec.job.name} › ${st.name}`;
          stepCounts.set(key, (stepCounts.get(key) ?? 0) + 1);
        }
      }
    }
    const topStep = [...stepCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    let detail =
      `${code(name)} runs on a schedule ~${round(perDay, 1)}×/day (${runs.length} runs, ${fmtUsd(cost.usd)}, ${fmtPct(share)} of all spend)`;
    detail += failing ? `, and ${fmtPct(failureRate)} of the runs failed — a permanently red schedule gets ignored.` : ".";
    if (topStep) detail += ` Most failures are in ${code(topStep[0])} (${topStep[1]}×).`;

    const parts: string[] = [];
    if (perDay > 1.1) {
      parts.push(`Run it once per weekday instead of ~${round(perDay, 1)}×/day:\n\n${yaml(`
on:
  schedule:
    - cron: "17 4 * * 1-5"   # 04:17 UTC Mon-Fri (off the top of the hour to avoid GitHub's cron congestion)
`)}`);
    }
    if (failing) {
      parts.push(
        `Fix${topStep ? ` ${code(topStep[0])}` : " the failing job"} or pause the workflow until someone owns it: ` +
          `\`gh workflow disable "${name}"\`. Add a failure notification so red runs get noticed.`,
      );
    }

    out.push(
      finding(ctx, {
        kind: "schedule-noise",
        title: failing ? `Scheduled ${code(name)} fails ${fmtPct(failureRate)} of the time` : `Scheduled ${code(name)} costs ${fmtPct(share)} of CI spend`,
        detail,
        fix: parts.join("\n\n"),
        monthlySavings,
        workflowName: name,
        evidence: evidence((failing ? failedRuns : runs).map((r) => r.htmlUrl)),
      }),
    );
  }
  return out;
}
