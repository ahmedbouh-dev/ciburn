# ciburn 🔥

**Find where your GitHub Actions money and minutes burn — and get the exact fix.**

```bash
npx ciburn owner/repo
```

ciburn reads your repo's GitHub Actions history and tells you, with numbers from *your* runs:

- **What CI costs** per workflow, job and runner OS, normalized to $/month at current GitHub list prices
- **Which jobs are flaky**: they failed, then passed on the same commit with no code change, plus what that cost
- **Where money is wasted**: superseded PR builds that keep running (missing `concurrency`), reruns that repeat already-paid work, jobs that hang until the 6-hour default timeout
- **What to change**: macOS/Windows matrix legs on every PR, oversized larger runners, dependency installs without caching, self-hosted pools that make developers wait
- **The fix**: each finding comes with a copy-pasteable YAML snippet and an estimated monthly saving

No SaaS, no agent to install, no data leaves your machine. It needs only a token with read-only `actions:read` and finishes in seconds to a few minutes. Repeat runs are fast because job data is cached locally.

## Try it without a token

```bash
npx ciburn --demo
```

## Real example: vitejs/vite (7 days, 1,024 runs)

```
  $296/mo            3% wasted          $165/mo            3.2h/mo
  monthly CI spend   $7.54/mo burned    billing, 3 fixes   dev time saved

TOP FIXES
   1 ● HIGH `CI` › `Build&Test: node-26, windows-latest` i…  $2.27/mo · 3.2h dev
   2 ● HIGH macOS matrix leg `CI` › `Build&Test: node-26, macos-latest…  $163/mo
   3 ○ LOW  Retrying failures without code changes, mostly in `CI`      $0.30/mo
```

Full HTML report: [`examples/vitejs-vite-report.html`](examples/vitejs-vite-report.html). Vite is a public repo, so its standard runners are free. Dollar figures for public repos are *list-price equivalents*.

## Usage

```
ciburn [owner/repo] [options]        repo defaults to the git "origin" remote

  -d, --days <n>          days of history (default 30)
  -w, --workflow <file>   only one workflow, e.g. ci.yml
      --html [file]       self-contained HTML report (offline, safe to email)
      --md [file]         Markdown, e.g. for $GITHUB_STEP_SUMMARY or a PR comment
      --json [file]       machine-readable report ("-" for stdout)
      --save / --from     save the raw dataset / analyze one offline
      --fail-on-waste <%> exit 2 when wasted spend exceeds this share (CI gate)
      --dev-rate <usd>    hourly developer cost used to rank waiting time (default 100)
      --price-linux/-windows/-macos/-self-hosted <usd/min>   override list prices
```

Auth: `GITHUB_TOKEN`, `GH_TOKEN`, or your `gh auth login` session. GitHub Enterprise Server works via `GITHUB_API_URL`.

## As a GitHub Action (weekly report)

```yaml
# .github/workflows/ci-cost.yml
name: CI cost report
on:
  schedule: [{ cron: "0 7 * * 1" }]
  workflow_dispatch:
permissions:
  actions: read
  contents: read
jobs:
  ciburn:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: ahmedbouh-dev/ciburn@v0
        with:
          days: 30
          # fail-on-waste: 15
```

The report lands in the job summary, and the HTML version is uploaded as an artifact.

## How the numbers are computed (and why you can trust them)

- **Billing math follows GitHub's rules.** Each job is rounded up to whole minutes and priced by runner type: standard, arm64, larger runners by core count, macOS sizes. Jobs skipped in a "Re-run failed jobs" attempt are carried-over copies, so they are not billed twice.
- **Dollars and hours are kept apart.** `$` is only what GitHub would bill. Developer time spent waiting for queues and retries is shown separately in hours. It is converted at `--dev-rate` only to rank findings, never added to dollar figures.
- **Fixes have to be backed by your data.** A Playwright retry snippet only appears when the failing step is Playwright. Cache advice for an install step that already uses `setup-*` is hedged ("check its cache"). iOS/Xcode jobs are never told to move to Linux.
- **Findings below the noise floor are dropped.** A finding must be worth at least $1/month, 60 minutes or 1 dev-hour.
- Prices come from [GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) (2026 rates). They can be overridden with flags.

## Development

```bash
pnpm install
pnpm test          # node:test, 120+ tests incl. regressions from real repos
pnpm typecheck
node src/cli.ts --demo
```

Zero runtime dependencies. Node ≥ 22.18 runs the TypeScript sources directly.

## License

MIT
