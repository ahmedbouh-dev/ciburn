#!/usr/bin/env node
// ciburn — find where your GitHub Actions money and minutes burn.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveToken } from "./github/client.ts";
import { fetchDataset, loadDataset, saveDataset } from "./github/fetch.ts";
import { analyze } from "./analyze/index.ts";
import { DEFAULT_PRICING } from "./pricing.ts";
import { renderTerminal } from "./report/terminal.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { renderHtml } from "./report/html.ts";
import { renderJson } from "./report/json.ts";
import type { Dataset, Pricing } from "./types.ts";

const VERSION = "0.1.0";

const HELP = `ciburn ${VERSION} — find where your GitHub Actions money and minutes burn

Usage
  ciburn [owner/repo] [options]        (repo defaults to the git remote "origin")

Data
  -d, --days <n>          Days of history to analyze (default 30)
  -w, --workflow <file>   Only one workflow, e.g. ci.yml
      --max-runs <n>      Cap on runs fetched, newest first (default 3000)
      --no-cache          Don't cache job data in .ciburn-cache/
      --save <file>       Save the raw dataset as JSON (share/re-analyze offline)
      --from <file>       Analyze a saved dataset instead of calling the API
      --demo              Try it on a built-in sample repo (no token, no network)

Output (terminal summary is always printed unless --quiet)
      --html [file]       Self-contained HTML report (default ciburn-report.html)
      --md [file]         Markdown report, e.g. for $GITHUB_STEP_SUMMARY
      --json [file]       Machine-readable report ("-" for stdout)
  -q, --quiet             No terminal summary

Pricing
      --dev-rate <usd>    Developer hourly cost for waiting time (default 100)
      --price-linux / --price-windows / --price-macos / --price-self-hosted <usd per min>

CI gate
      --fail-on-waste <pct>   Exit 2 if wasted spend exceeds this % of total

Auth: GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`. Read-only "actions:read" is enough.
`;

function die(msg: string, code = 1): never {
  process.stderr.write(`ciburn: ${msg}\n`);
  process.exit(code);
}

function repoFromGit(): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) die(`--${name} expects a non-negative number, got "${v}"`);
  return n;
}

/** Optional-value flags (--html, --md, --json) — parseArgs can't express "string or bare", so pre-process argv. */
function splitOptionalValueFlags(argv: string[], flags: string[]): { argv: string[]; values: Record<string, string> } {
  const out: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2).split("=")[0] : "";
    if (flags.includes(name)) {
      if (a.includes("=")) values[name] = a.slice(a.indexOf("=") + 1);
      else if (argv[i + 1] !== undefined && (!argv[i + 1].startsWith("-") || argv[i + 1] === "-")) values[name] = argv[++i];
      else values[name] = "";
      continue;
    }
    out.push(a);
  }
  return { argv: out, values };
}

async function main(): Promise<void> {
  const pre = splitOptionalValueFlags(process.argv.slice(2), ["html", "md", "json"]);
  const { values: o, positionals } = parseArgs({
    args: pre.argv,
    allowPositionals: true,
    options: {
      days: { type: "string", short: "d" },
      workflow: { type: "string", short: "w" },
      "max-runs": { type: "string" },
      "no-cache": { type: "boolean" },
      save: { type: "string" },
      from: { type: "string" },
      demo: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      "dev-rate": { type: "string" },
      "price-linux": { type: "string" },
      "price-windows": { type: "string" },
      "price-macos": { type: "string" },
      "price-self-hosted": { type: "string" },
      "fail-on-waste": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (o.help) return void process.stdout.write(HELP);
  if (o.version) return void process.stdout.write(`${VERSION}\n`);

  const days = num(o.days, "days") ?? 30;
  const pricing: Pricing = {
    ...DEFAULT_PRICING,
    ...(o["price-linux"] !== undefined && { linux: num(o["price-linux"], "price-linux")! }),
    ...(o["price-windows"] !== undefined && { windows: num(o["price-windows"], "price-windows")! }),
    ...(o["price-macos"] !== undefined && { macos: num(o["price-macos"], "price-macos")! }),
    ...(o["price-self-hosted"] !== undefined && { selfHosted: num(o["price-self-hosted"], "price-self-hosted")! }),
  };
  const progress = (msg: string) => {
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${msg}`);
  };

  let ds: Dataset;
  if (o.demo || o.from) {
    // examples/ sits one level above both src/ and dist/
    ds = loadDataset(o.demo ? fileURLToPath(new URL("../examples/demo-dataset.json", import.meta.url)) : o.from!);
  } else {
    const repo = positionals[0] ?? repoFromGit();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die(repo ? `"${repo}" is not owner/repo` : "no repo given and no GitHub origin remote found. Try: ciburn owner/repo");
    const token = resolveToken();
    if (!token) process.stderr.write("ciburn: no token found (GITHUB_TOKEN / gh auth login) — unauthenticated API limit is 60 req/h\n");
    const t0 = Date.now();
    ds = await fetchDataset(repo, {
      days,
      token,
      workflow: o.workflow,
      maxRuns: num(o["max-runs"], "max-runs"),
      cacheDir: o["no-cache"] ? null : undefined,
      onProgress: progress,
    });
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2Kfetched ${ds.runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }
  if (ds.truncated) {
    const hours = (Date.parse(ds.until) - Date.parse(ds.since)) / 3_600_000;
    process.stderr.write(
      `ciburn: hit --max-runs; analyzing only the newest ${hours < 48 ? hours.toFixed(1) + " h" : (hours / 24).toFixed(1) + " days"} (monthly figures are extrapolated from that)\n`,
    );
  }
  if (o.save) saveDataset(ds, o.save);
  if (ds.runs.length === 0) die(`no completed workflow runs in ${ds.repo} for the selected window`, 0);

  const report = analyze(ds, { pricing, devHourlyUsd: num(o["dev-rate"], "dev-rate") ?? 100 });

  const write = (flag: string, def: string, content: string) => {
    const target = pre.values[flag] || def;
    if (target === "-") return void process.stdout.write(content + "\n");
    writeFileSync(target, content);
    process.stderr.write(`wrote ${target}\n`);
  };
  if ("html" in pre.values) write("html", "ciburn-report.html", renderHtml(report));
  if ("md" in pre.values) write("md", "ciburn-report.md", renderMarkdown(report));
  if ("json" in pre.values) write("json", "ciburn-report.json", renderJson(report));

  if (!o.quiet && pre.values.json !== "-") {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    process.stdout.write(renderTerminal(report, { color, width: process.stdout.columns }) + "\n");
  }

  const limit = num(o["fail-on-waste"], "fail-on-waste");
  if (limit !== undefined && report.totals.cost.usd > 0) {
    const pct = (report.totals.wastedCost.usd / report.totals.cost.usd) * 100;
    if (pct > limit) die(`wasted spend ${pct.toFixed(1)}% exceeds --fail-on-waste ${limit}%`, 2);
  }
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
