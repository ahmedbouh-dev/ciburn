// Manual live smoke test against the real GitHub API (not part of the test suite).
// Usage: node scripts/smoke-fetch.ts [owner/repo] [days]
// Uses GITHUB_TOKEN / GH_TOKEN / `gh auth token`. The token is never printed.

import { resolveToken } from "../src/github/client.ts";
import { fetchDataset } from "../src/github/fetch.ts";

const repo = process.argv[2] ?? "cli/cli";
const days = Number(process.argv[3] ?? 3);
const token = resolveToken();
console.log(`repo=${repo} days=${days} auth=${token ? "yes" : "no"}`);

const t0 = performance.now();
const ds = await fetchDataset(repo, {
  days,
  token,
  cacheDir: null,
  onProgress: (m) => console.log("  " + m),
});
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const jobs = ds.runs.flatMap((r) => r.jobs);
const steps = jobs.reduce((n, j) => n + j.steps.length, 0);
const reruns = ds.runs.filter((r) => r.runAttempt > 1).length;
const workflows = new Set(ds.runs.map((r) => r.workflowPath));
const labels = new Map<string, number>();
for (const j of jobs) {
  const k = j.labels.join(",") || "(none)";
  labels.set(k, (labels.get(k) ?? 0) + 1);
}

console.log(`\nwindow   ${ds.since} .. ${ds.until}`);
console.log(`runs     ${ds.runs.length} (reruns: ${reruns}) across ${workflows.size} workflows`);
console.log(`jobs     ${jobs.length} (steps: ${steps})`);
console.log(`labels   ${[...labels].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`missing  runs without jobs: ${ds.runs.filter((r) => r.jobs.length === 0).length}, jobs without startedAt: ${jobs.filter((j) => !j.startedAt).length}`);
console.log(`sample   ${JSON.stringify({ ...ds.runs[0], jobs: `[${ds.runs[0]?.jobs.length}]` })}`);
console.log(`time     ${secs}s`);
