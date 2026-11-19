<!-- ciburn-report -->
## 🔥 ciburn: CI cost report for `acme/webapp`

Nov 1 – Nov 15, 2026 (14 days) · 211 runs · 782 jobs

| Monthly CI spend | Wasted | Billing savings | Dev time saved | Queue time |
| ---: | ---: | ---: | ---: | ---: |
| **$244** | **19%** ($45.24/mo) | **$218/mo** | **10h/mo** | 5.3 h in window |

### Top fixes (10)

<details>
<summary><b>1. <code>CI</code> › <code>e2e</code> is flaky (11% of commits)</b> · 🔴 High · saves ~$1.97/mo + 5.4h dev time/mo</summary>

`CI` › `e2e` failed and then passed on the same commit in 14 of 126 commits (11% flake rate). The failed attempts burned 153 billable min ($0.92). Most flakes fail in step `Run npx playwright test` (14×). Developers then waited at least 2.5 h for the green retries (developer time, not GitHub billing); median time from red to green was 35.7 min.

**Fix:**

Find the flaky test: `gh run view 10028 --log-failed` (it fails in step `Run npx playwright test`). Quarantine or fix it; until then, retry inside the job instead of re-running the whole workflow:

```ts
// playwright.config.ts
export default defineConfig({
  retries: process.env.CI ? 2 : 0,
  use: { trace: "on-first-retry" },
});
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10028) · [run 2](https://github.com/acme/webapp/actions/runs/10060) · [run 3](https://github.com/acme/webapp/actions/runs/10041) · [run 4](https://github.com/acme/webapp/actions/runs/10094) · [run 5](https://github.com/acme/webapp/actions/runs/10043)

</details>

<details>
<summary><b>2. <code>Deploy</code> › <code>deploy</code> waits 11.5 min for a <code>self-hosted, linux, deploy</code> runner (p95)</b> · 🔴 High · saves ~4.6h dev time/mo</summary>

On push/PR runs, `Deploy` › `deploy` waited a median 84s and p95 11.5 min for a self-hosted runner over 30 job runs. This is developer waiting time, not GitHub billing: 2.1 h beyond a 30s baseline in 14 days (per run only the longest wait counts, parallel waits overlap).

**Fix:**

Your self-hosted pool (`self-hosted, linux, deploy`) is too small at peak. Autoscale it, e.g. with actions-runner-controller:

```yaml
# values for gha-runner-scale-set (actions-runner-controller)
minRunners: 2      # keep warm runners for the morning peak
maxRunners: 20
```

or route short jobs to GitHub-hosted runners with `runs-on: ubuntu-latest`.

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10102) · [run 2](https://github.com/acme/webapp/actions/runs/10134) · [run 3](https://github.com/acme/webapp/actions/runs/10152) · [run 4](https://github.com/acme/webapp/actions/runs/10156) · [run 5](https://github.com/acme/webapp/actions/runs/10123)

</details>

<details>
<summary><b>3. macOS matrix leg <code>CI</code> › <code>test (macos-latest)</code> runs on every PR</b> · 🔴 High · saves ~$129/mo</summary>

`CI` › `test (macos-latest)` cost $77.81 (68% of all spend) at $0.062/min — 10.3× the linux rate — and 107 of its 139 runs were on pull requests, where the linux leg `test (ubuntu-latest)` already runs the same job. Savings = dropping the macOS leg on PRs only.

**Fix:**

Run the full OS matrix on the default branch and nightly, linux only on PRs:

```yaml
strategy:
  matrix:
    os: ${{ github.event_name == 'pull_request' && fromJSON('["ubuntu-latest"]') || fromJSON('["ubuntu-latest", "macos-latest"]') }}
runs-on: ${{ matrix.os }}
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10026) · [run 2](https://github.com/acme/webapp/actions/runs/10072) · [run 3](https://github.com/acme/webapp/actions/runs/10073) · [run 4](https://github.com/acme/webapp/actions/runs/10074) · [run 5](https://github.com/acme/webapp/actions/runs/10027)

</details>

<details>
<summary><b>4. Superseded PR builds keep running in <code>CI</code></b> · 🟠 Medium · saves ~$24.06/mo</summary>

38 of 131 push/PR runs of `CI` kept running after a newer commit landed on the same branch/PR (38 PR, 0 branch push; median 6.1 min of overlap). That burned 471 billable min ($11.23) in 14 days on results nobody looks at. 1 overlapping push to the default branch was excluded on purpose.

**Fix:**

Add a top-level `concurrency` block to `.github/workflows/ci.yml` so a new push cancels the outdated run of the same ref (runs on the default branch still complete):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10027) · [run 2](https://github.com/acme/webapp/actions/runs/10063) · [run 3](https://github.com/acme/webapp/actions/runs/10065) · [run 4](https://github.com/acme/webapp/actions/runs/10066) · [run 5](https://github.com/acme/webapp/actions/runs/10059)

</details>

<details>
<summary><b>5. <code>Run pnpm install --frozen-lockfile</code> runs uncached in 4 jobs of <code>CI</code> (p50 82s)</b> · 🟠 Medium · saves ~$18.87/mo</summary>

`Run pnpm install --frozen-lockfile` takes a median 82s per run in 4 jobs of `CI` (p50: `e2e` 82s, `lint` 82s, `test (ubuntu-latest)` 82s, `test (macos-latest)` 81s) and no cache step was detected. Over 14 days these steps took 12.4 h across 548 job runs. Savings assume a warm cache cuts them by 60%.

**Fix:**

Cache dependencies between runs (in each of: `e2e`, `lint`, `test (ubuntu-latest)`, `test (macos-latest)`):

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
- run: pnpm install --frozen-lockfile
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10151) · [run 2](https://github.com/acme/webapp/actions/runs/10026) · [run 3](https://github.com/acme/webapp/actions/runs/10072) · [run 4](https://github.com/acme/webapp/actions/runs/10128) · [run 5](https://github.com/acme/webapp/actions/runs/10074)

</details>

<details>
<summary><b>6. <code>CI</code> › <code>build</code> uses a 16-core runner for a 71s job</b> · 🟠 Medium · saves ~$17.19/mo</summary>

`CI` › `build` runs on `ubuntu-latest-16-cores` ($0.042/min) but its median duration is 71s over 139 runs — every job is billed at least a full minute. Even at twice the duration a standard 2-core runner would cost $2.31 instead of $10.33.

**Fix:**

Use a standard runner for short jobs; keep larger runners for builds that actually saturate the cores:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10151) · [run 2](https://github.com/acme/webapp/actions/runs/10026) · [run 3](https://github.com/acme/webapp/actions/runs/10072) · [run 4](https://github.com/acme/webapp/actions/runs/10128) · [run 5](https://github.com/acme/webapp/actions/runs/10073)

</details>

<details>
<summary><b>7. Re-runs repeat jobs that already passed, mostly in <code>CI</code></b> · 🟠 Medium · saves ~$12.36/mo</summary>

15 runs were re-run; 47 job executions (340 billable min, $6.69) were thrown away by a later attempt, 100% of it in `CI`. 153 min of that are flaky failures counted in their own findings; the remaining 187 min ($5.77) are counted here. 32 re-executions were of jobs that had already passed ("Re-run all jobs"): 182 min ($5.76).

**Fix:**

Re-run only what failed: use **Re-run failed jobs** in the UI or `gh run rerun 10028 --failed` instead of re-running all jobs. A re-run without a code change only helps when the failure is flaky: find the unstable job (see the flaky-job findings) and fix it, or retry just the unstable step in-job instead of re-running the job:

```yaml
- uses: nick-fields/retry@v3
  with:
    timeout_minutes: 15
    max_attempts: 2
    command: <unstable command>
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10028) · [run 2](https://github.com/acme/webapp/actions/runs/10060) · [run 3](https://github.com/acme/webapp/actions/runs/10041) · [run 4](https://github.com/acme/webapp/actions/runs/10108) · [run 5](https://github.com/acme/webapp/actions/runs/10094)

</details>

<details>
<summary><b>8. <code>Docs</code> › <code>link-check</code> hangs until the timeout</b> · 🟠 Medium · saves ~$9.00/mo</summary>

`Docs` › `link-check` timed out 2×, running a median 6 h each time while successful runs take p95 3.1 min. A 10-minute limit would have saved 700 billable min ($4.20).

**Fix:**

Set an explicit job timeout (the default is 360 minutes of billed runner time):

```yaml
jobs:
  link-check:
    timeout-minutes: 10
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10148) · [run 2](https://github.com/acme/webapp/actions/runs/10112)

</details>

<details>
<summary><b>9. Scheduled <code>Security Scan</code> fails 60% of the time</b> · ⚪ Low · saves ~$3.97/mo</summary>

`Security Scan` runs on a schedule ~3×/day (42 runs, $2.45, 2% of all spend), and 60% of the runs failed — a permanently red schedule gets ignored. Most failures are in `scan › Run trivy image --exit-code 1 webapp:scan` (25×).

**Fix:**

Run it once per weekday instead of ~3×/day:

```yaml
on:
  schedule:
    - cron: "17 4 * * 1-5"   # 04:17 UTC Mon-Fri (off the top of the hour to avoid GitHub's cron congestion)
```

Fix `scan › Run trivy image --exit-code 1 webapp:scan` or pause the workflow until someone owns it: `gh workflow disable "Security Scan"`. Add a failure notification so red runs get noticed.

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10169) · [run 2](https://github.com/acme/webapp/actions/runs/10170) · [run 3](https://github.com/acme/webapp/actions/runs/10171) · [run 4](https://github.com/acme/webapp/actions/runs/10172) · [run 5](https://github.com/acme/webapp/actions/runs/10173)

</details>

<details>
<summary><b>10. <code>Run docker build -t webapp:scan .</code> runs uncached in <code>Security Scan</code> › <code>scan</code> (p50 4.5 min)</b> · ⚪ Low · saves ~$1.42/mo</summary>

`Run docker build -t webapp:scan .` takes a median 4.5 min per run in `Security Scan` › `scan` and no cache step was detected. Over 14 days these steps took 3.1 h across 42 job runs. Savings assume a warm cache cuts them by 60%.

**Fix:**

Cache image layers between runs:

```yaml
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

Evidence: [run 1](https://github.com/acme/webapp/actions/runs/10169) · [run 2](https://github.com/acme/webapp/actions/runs/10170) · [run 3](https://github.com/acme/webapp/actions/runs/10171) · [run 4](https://github.com/acme/webapp/actions/runs/10172) · [run 5](https://github.com/acme/webapp/actions/runs/10173)

</details>

### Workflows by cost

| Workflow | Cost / mo | Share | Runs | Pass rate | p50 | p95 | Trend |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| CI<br><sub>.github/workflows/ci.yml</sub> | $229 | 94% | 131 | 96% | 10m 46s | 11m 52s | -10% |
| Docs<br><sub>.github/workflows/docs.yml</sub> | $9.49 | 4% | 8 | 75% | 2m 44s | 6h 00m | – |
| Security Scan<br><sub>.github/workflows/security.yml</sub> | $5.25 | 2% | 42 | 40% | 9m 18s | 10m 10s | +3% |
| Deploy<br><sub>.github/workflows/deploy.yml</sub> | $0 | 0% | 30 | 100% | 4m 50s | 14m 49s | – |

<details>
<summary><b>Jobs by cost</b> (top 8 of 8)</summary>

| Job | Workflow | Runner | Cost / mo | p50 | p95 queue | Fail rate |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: |
| test (macos-latest) | CI | macos | $167 | 8m 43s | 58s | 0% |
| build | CI | linux | $22.14 | 1m 11s | 15s | 0% |
| e2e | CI | linux | $20.44 | 10m 34s | 15s | 14% |
| test (ubuntu-latest) | CI | linux | $14.64 | 7m 46s | 15s | 0% |
| link-check | Docs | linux | $9.49 | 2m 39s | 5s | 25% |
| lint | CI | linux | $5.27 | 2m 14s | 14s | 0% |
| scan | Security Scan | linux | $5.25 | 9m 13s | 5s | 60% |
| deploy | Deploy | self-hosted | $0 | 3m 06s | 11m 27s | 0% |

</details>

### Flaky jobs

| Job | Workflow | Flaky commits | Flake rate | Wasted / mo | Examples |
| :--- | :--- | ---: | ---: | ---: | :--- |
| e2e | CI | 14 / 126 | 11% | $1.97 | [1](https://github.com/acme/webapp/actions/runs/10028) [2](https://github.com/acme/webapp/actions/runs/10060) [3](https://github.com/acme/webapp/actions/runs/10041) |

<details>
<summary><b>Slowest steps</b> (total runner time in window)</summary>

| Step | Job | Workflow | Total | p50 | Samples |
| :--- | :--- | :--- | ---: | ---: | ---: |
| Run npx playwright test | e2e | CI | 19h 20m | 8m 13s | 141 |
| Run pnpm test | test (macos-latest) | CI | 15h 55m | 7m 09s | 134 |
| Run pnpm test | test (ubuntu-latest) | CI | 13h 53m | 6m 12s | 134 |
| Run lychee --no-progress './**/*.md' | link-check | Docs | 12h 14m | 2m 49s | 8 |
| Run trivy image --exit-code 1 webapp:scan | scan | Security Scan | 3h 17m | 4m 41s | 42 |
| Run pnpm install --frozen-lockfile | e2e | CI | 3h 11m | 1m 22s | 141 |
| Run pnpm install --frozen-lockfile | lint | CI | 3h 10m | 1m 22s | 139 |
| Run docker build -t webapp:scan . | scan | Security Scan | 3h 03m | 4m 28s | 42 |
| Run pnpm install --frozen-lockfile | test (ubuntu-latest) | CI | 3h 02m | 1m 22s | 134 |
| Run pnpm install --frozen-lockfile | test (macos-latest) | CI | 3h 02m | 1m 21s | 134 |
| Run pnpm build | build | CI | 2h 28m | 1m 05s | 139 |
| Run npx playwright install --with-deps | e2e | CI | 1h 58m | 51s | 141 |
| Run ./scripts/deploy.sh | deploy | Deploy | 1h 35m | 3m | 30 |
| Run pnpm lint | lint | CI | 1h 32m | 40s | 139 |
| Run pnpm/action-setup@v4 | e2e | CI | 14m 06s | 6s | 141 |

</details>

<sub>Generated by ciburn · 5,895 min billed in window · pricing per minute: Linux $0.006, Windows $0.01, macOS $0.062. $ figures are list-price equivalents; public repos on standard runners are free. Dev time is valued at $100/h only to rank findings and is never added to $.</sub>
