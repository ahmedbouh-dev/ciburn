// Self-contained HTML report: inline CSS/JS/SVG, zero external requests, safe to email/attach.
// Every string that comes from the report is untrusted (job names, step names, fix text) -> esc().
import type { Finding, Report, RunnerOs } from "../types.ts";
import {
  dateRange, duration, hours, int, minutes, monthlyFactor, pct, sortFindings, splitFences, totalDevHours,
  totalSavings, trend, usd, wasteShare,
} from "./format.ts";

/** Escape text for HTML element content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only plain http(s) URLs may become link targets (blocks javascript:, data:, etc.). */
export function safeHref(u: string): string | null {
  return /^https?:\/\/[^\s<>"'`]+$/i.test(u) ? u : null;
}

/** Escape, then turn `inline code` into <code> and **bold** into <strong>. Backticks and * survive esc(). */
function inlineMd(s: string): string {
  return esc(s)
    .split(/(`[^`\n]+`)/g)
    .map((part) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? `<code>${part.slice(1, -1)}</code>`
        : part.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}

/** Minimal markdown for `fix`: fenced code blocks (with copy button) + paragraphs with inline code. */
export function fixToHtml(src: string): string {
  return splitFences(src)
    .map((seg) => {
      if (seg.type === "code") {
        const lang = seg.lang ? `<span class="code-lang">${esc(seg.lang)}</span>` : "";
        return `<div class="code">${lang}<button type="button" class="copy" aria-label="Copy code">${ICON_COPY}<span>Copy</span></button><pre><code>${esc(seg.code)}</code></pre></div>`;
      }
      return seg.text
        .trim()
        .split(/\n\s*\n/)
        .map((p) => `<p>${inlineMd(p.trim()).replace(/\n/g, "<br>")}</p>`)
        .join("");
    })
    .join("");
}

const ICON_COPY =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_FLAME =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2.5c.6 3.2-1.2 5-2.7 6.6C7.8 10.7 6.5 12.2 6.5 15a5.5 5.5 0 0 0 11 0c0-2.3-1-4-2.2-5.4.1 1.6-.5 2.8-1.6 3.3.4-3.6-.8-7.6-1.7-10.4Z" fill="currentColor"/></svg>';

const OS_LABEL: Record<RunnerOs, string> = { linux: "Linux", windows: "Windows", macos: "macOS", "self-hosted": "Self-hosted" };
const OS_ORDER: RunnerOs[] = ["linux", "macos", "windows", "self-hosted"];
const SEV_LABEL: Record<Finding["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

function kpi(label: string, value: string, sub: string, tone = ""): string {
  return `<div class="kpi${tone ? ` kpi-${tone}` : ""}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

function section(id: string, title: string, body: string, note = ""): string {
  return `<section id="${id}"><div class="section-head"><h2>${title}</h2>${note ? `<span class="note">${note}</span>` : ""}</div>${body}</section>`;
}

function findingCard(f: Finding, i: number): string {
  // Billing $ and dev hours are shown side by side, never summed.
  const hasUsd = f.monthlySavings.usd > 0;
  const hasHours = (f.devHoursSaved ?? 0) > 0;
  const usdPart = hasUsd ? `<div class="save-line"><span class="save-value">${esc(usd(f.monthlySavings.usd))}</span><span class="save-unit">/mo</span></div>` : "";
  const hoursPart = hasHours
    ? `<div class="save-line save-hours"><span class="save-value">${esc(hours(f.devHoursSaved))}</span><span class="save-unit"> dev time/mo</span></div>`
    : "";
  const save = hasUsd || hasHours ? `<div class="save${hasUsd ? "" : " only-hours"}">${usdPart}${hoursPart}</div>` : "";
  const scope = [f.workflowName, f.jobName].filter((x): x is string => !!x).map(esc).join(" › ");
  const links = f.evidence
    .map(safeHref)
    .filter((u): u is string => u !== null)
    .slice(0, 5)
    .map((u, n) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(runLabel(u, n))}</a>`)
    .join("");
  return `<article class="finding sev-${esc(f.severity)}">
  <div class="finding-top">
    <div class="finding-meta"><span class="idx">${i + 1}</span><span class="sev"><i></i>${SEV_LABEL[f.severity] ?? esc(f.severity)}</span><span class="kind">${esc(f.kind)}</span>${scope ? `<span class="scope">${scope}</span>` : ""}</div>
    ${save}
  </div>
  <h3>${inlineMd(f.title)}</h3>
  <p class="detail">${inlineMd(f.detail)}</p>
  <div class="fix"><div class="fix-label">Fix</div>${fixToHtml(f.fix)}</div>
  ${links ? `<div class="evidence"><span>Evidence</span>${links}</div>` : ""}
</article>`;
}

/** "Show N more" toggle for a .collapsible container; empty when nothing is hidden. */
function moreButton(hidden: number, noun: string, cost?: number): string {
  if (hidden <= 0) return "";
  const label = `Show ${hidden} more ${noun}${cost === undefined ? "" : ` (${usd(cost)}/mo)`}`;
  return `<button type="button" class="more" data-more="${esc(label)}" data-less="Show fewer">${esc(label)}</button>`;
}

const restCost = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function runLabel(u: string, n: number): string {
  const m = /\/runs\/(\d+)/.exec(u);
  return m ? `#${m[1]}` : `link ${n + 1}`;
}

export function renderHtml(report: Report): string {
  const k = monthlyFactor(report);
  const t = report.totals;
  const savings = totalSavings(report.findings);
  const waste = wasteShare(report);
  const findings = sortFindings(report);
  const devHours = totalDevHours(report.findings);
  const range = dateRange(report.since, report.until);

  // KPI cards
  const kpis = `<div class="kpis">
${kpi("Monthly CI spend", esc(usd(t.monthlyCost.usd)), `${esc(usd(t.cost.usd))} in ${report.days} days · ${esc(minutes(t.cost.minutes))}`)}
${kpi("Wasted", esc(pct(waste)), `${esc(usd(t.wastedCost.usd * k))}/mo on reruns, flakes &amp; superseded runs`, waste >= 0.15 ? "bad" : "")}
${kpi("Potential savings", `${esc(usd(savings))}<small>/mo</small>`, `GitHub billing, from ${findings.length} fix${findings.length === 1 ? "" : "es"} below`, "good")}
${devHours > 0 ? kpi("Dev time saved", `${esc(hours(devHours))}<small>/mo</small>`, "developer hours no longer spent waiting", "good") : ""}
${kpi("Queue time", `${esc(t.queueHours.toFixed(1))}<small> h</small>`, `jobs waiting for a runner in ${report.days} days`)}
</div>`;

  // Cost by OS: one stacked bar + legend
  const osTotal = OS_ORDER.reduce((s, os) => s + (t.byOs[os]?.usd ?? 0), 0);
  const osParts = OS_ORDER.filter((os) => (t.byOs[os]?.usd ?? 0) > 0);
  const osBar = osParts
    .map((os) => {
      const v = t.byOs[os]!.usd;
      const share = osTotal > 0 ? v / osTotal : 0;
      return `<span class="seg os-${os}" style="flex-grow:${share.toFixed(4)}" title="${esc(`${OS_LABEL[os]}: ${usd(v * k)}/mo (${pct(share)})`)}"></span>`;
    })
    .join("");
  const osLegend = osParts
    .map((os) => {
      const m = t.byOs[os]!;
      return `<li><span class="sw os-${os}"></span><span class="lg-name">${OS_LABEL[os]}</span><span class="lg-val">${esc(usd(m.usd * k))}<small>/mo</small></span><span class="lg-sub">${esc(pct(osTotal > 0 ? m.usd / osTotal : 0))} · ${esc(minutes(m.minutes))}</span></li>`;
    })
    .join("");
  const osSection = osTotal > 0
    ? section("os", "Cost by runner", `<div class="card"><div class="stack" role="img" aria-label="Cost share by runner OS">${osBar}</div><ul class="legend">${osLegend}</ul></div>`, "per month")
    : "";

  // Findings
  const findingsSection = findings.length > 0
    ? section("fixes", "Top fixes", `<div class="findings">${findings.map(findingCard).join("\n")}</div>`, "ranked by billing savings + dev time")
    : section("fixes", "Top fixes", `<div class="card empty">No findings. This pipeline looks lean.</div>`);

  // Workflows: horizontal bars
  const maxWf = Math.max(0.0001, ...report.workflows.map((w) => w.cost.usd));
  const WF_VISIBLE = 8;
  const wfRows = report.workflows
    .map((w, idx) => {
      const share = t.cost.usd > 0 ? w.cost.usd / t.cost.usd : 0;
      const tr = w.costTrend;
      // Tiny workflows swing wildly in % terms; only color trends where spend matters.
      const big = share >= 0.02;
      const trCls = tr === null || !big ? "" : tr >= 0.15 ? " up" : tr <= -0.05 ? " down" : "";
      return `<div class="wf${idx >= WF_VISIBLE ? " extra" : ""}" title="${esc(`${w.workflowName}: ${usd(w.cost.usd * k)}/mo, ${int(w.runs)} runs`)}">
  <div class="wf-name"><span>${esc(w.workflowName)}</span><code>${esc(w.workflowPath)}</code></div>
  <div class="wf-bar"><span style="width:${((w.cost.usd / maxWf) * 100).toFixed(2)}%"></span></div>
  <div class="wf-cost">${esc(usd(w.cost.usd * k))}</div>
  <div class="wf-meta"><span>${esc(pct(share))} of spend</span><span${w.successRate < 0.8 ? ' class="warn"' : ""}>${esc(pct(w.successRate))} pass</span><span>p50 ${esc(duration(w.p50DurationSec))}</span><span class="trend${trCls}">${esc(trend(tr))}</span></div>
</div>`;
    })
    .join("\n");
  const wfSection = report.workflows.length > 0
    ? section("workflows", "Workflows by cost", `<div class="card wfs collapsible">${wfRows}${moreButton(report.workflows.length - WF_VISIBLE, "workflows", restCost(report.workflows.slice(WF_VISIBLE).map((w) => w.cost.usd * k)))}</div>`, "per month · trend = 2nd half vs 1st half of window")
    : "";

  // Jobs: sortable table
  const JOBS_VISIBLE = 12;
  const jobsSorted = [...report.jobs].sort((a, b) => b.cost.usd - a.cost.usd);
  const jobRows = jobsSorted
    .map((j, idx) => `<tr${idx >= JOBS_VISIBLE ? ' class="extra"' : ""}>
<td data-v="${esc(j.jobName.toLowerCase())}"><span class="strong">${esc(j.jobName)}</span><span class="muted">${esc(j.workflowName)}</span></td>
<td data-v="${esc(j.os)}"><span class="os-chip"><span class="sw os-${esc(j.os)}"></span>${esc(OS_LABEL[j.os] ?? j.os)}</span></td>
<td class="num" data-v="${j.cost.usd}">${esc(usd(j.cost.usd * k))}</td>
<td class="num" data-v="${j.runs}">${esc(int(j.runs))}</td>
<td class="num" data-v="${j.p50DurationSec}">${esc(duration(j.p50DurationSec))}</td>
<td class="num" data-v="${j.p95DurationSec}">${esc(duration(j.p95DurationSec))}</td>
<td class="num" data-v="${j.p95QueueSec}">${esc(duration(j.p95QueueSec))}</td>
<td class="num${j.failureRate >= 0.1 ? " warn" : ""}" data-v="${j.failureRate}">${esc(pct(j.failureRate))}</td>
</tr>`)
    .join("\n");
  const th = (label: string, type: "num" | "text", cls = "") =>
    `<th scope="col" class="${cls}" data-type="${type}"><button type="button">${label}<span class="arrow" aria-hidden="true"></span></button></th>`;
  const jobsSection = report.jobs.length > 0
    ? section("jobs", "Jobs", `<div class="card flush collapsible" data-visible="${JOBS_VISIBLE}"><div class="table-wrap"><table class="sortable">
<thead><tr>${th("Job", "text")}${th("Runner", "text")}${th("Cost/mo", "num", "num sorted-desc")}${th("Runs", "num", "num")}${th("p50", "num", "num")}${th("p95", "num", "num")}${th("p95 queue", "num", "num")}${th("Fail rate", "num", "num")}</tr></thead>
<tbody>${jobRows}</tbody></table></div>${moreButton(jobsSorted.length - JOBS_VISIBLE, "jobs")}</div>`, "click a column to sort")
    : "";

  // Flaky jobs
  const flakyRows = report.flaky
    .map((f) => {
      const ex = f.examples.map(safeHref).filter((u): u is string => u !== null).slice(0, 3)
        .map((u, n) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(runLabel(u, n))}</a>`).join(" ");
      return `<tr><td><span class="strong">${esc(f.jobName)}</span><span class="muted">${esc(f.workflowName)}</span></td>
<td class="num">${esc(int(f.flakyCount))}<span class="muted-inline"> / ${esc(int(f.occurrences))}</span></td>
<td class="num"><span class="rate"><span style="width:${Math.min(100, f.flakeRate * 100 * 4).toFixed(1)}%"></span></span>${esc(pct(f.flakeRate))}</td>
<td class="num">${esc(usd(f.wastedCost.usd * k))}</td>
<td class="links">${ex}</td></tr>`;
    })
    .join("\n");
  const flakySection = report.flaky.length > 0
    ? section("flaky", "Flaky jobs", `<div class="card flush"><div class="table-wrap"><table>
<thead><tr><th scope="col">Job</th><th scope="col" class="num">Flaky commits</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Wasted/mo</th><th scope="col">Examples</th></tr></thead>
<tbody>${flakyRows}</tbody></table></div></div>`, "failed, then passed on the same commit")
    : "";

  // Slow steps
  const maxStep = Math.max(1, ...report.slowSteps.map((s) => s.totalSec));
  const stepRows = report.slowSteps
    .map((s) => `<tr><td><span class="strong">${esc(s.stepName)}</span><span class="muted">${esc(s.workflowName)} › ${esc(s.jobName)}</span></td>
<td class="num total"><span class="rate"><span style="width:${((s.totalSec / maxStep) * 100).toFixed(1)}%"></span></span>${esc(duration(s.totalSec))}</td>
<td class="num">${esc(duration(s.p50Sec))}</td>
<td class="num">${esc(int(s.samples))}</td></tr>`)
    .join("\n");
  const stepsSection = report.slowSteps.length > 0
    ? section("steps", "Slowest steps", `<div class="card flush"><div class="table-wrap"><table>
<thead><tr><th scope="col">Step</th><th scope="col" class="num">Total time</th><th scope="col" class="num">p50</th><th scope="col" class="num">Samples</th></tr></thead>
<tbody>${stepRows}</tbody></table></div></div>`, "total runner time in window")
    : "";

  const pr = report.pricing;
  const price = (n: number) => `$${esc(String(n))}`;
  const footer = `<footer>
<p><strong>Pricing assumptions</strong> (USD per billable minute, each job rounded up to whole minutes): Linux ${price(pr.linux)} · Linux ARM ${price(pr.linuxArm)} · Windows ${price(pr.windows)} · macOS ${price(pr.macos)} · larger Linux runners ${price(pr.largerLinuxPerCore)}/core · self-hosted ${price(pr.selfHosted)}. Monthly figures are the ${report.days}-day window scaled to 30 days.</p>
<p>Developer time is valued at ${esc(usd(report.devHourlyUsd))}/h <em>only to rank findings</em>; it is never added to dollar amounts, which are GitHub billing only.</p>
<p>Public repositories on standard GitHub-hosted runners are free; dollar amounts are the <em>list-price equivalent</em> of the compute used. Included free minutes of paid plans are not deducted.</p>
<p class="gen">Generated by ciburn from ${esc(int(t.runs))} runs of <span class="strong">${esc(report.repo)}</span>, ${esc(range)}.</p>
</footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(report.repo)} · CI cost report · ciburn</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
  <div class="brand">${ICON_FLAME}<span>ciburn</span></div>
  <h1>${esc(report.repo)}</h1>
  <p class="sub">${esc(range)} · ${report.days} days · ${esc(int(t.runs))} runs · ${esc(int(t.jobs))} jobs</p>
</header>
${kpis}
${osSection}
${findingsSection}
${wfSection}
${jobsSection}
<div class="two">
${flakySection}
${stepsSection}
</div>
${footer}
</main>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{
  color-scheme:light;
  --bg:#f7f7f5;--surface:#ffffff;--surface-2:#f2f2ef;--border:#e6e5e0;--border-strong:#d6d5cf;
  --text:#18181a;--text-2:#55554f;--text-3:#8a8983;
  --accent:#e2591b;--series:#2a78d6;--series-soft:#d9e7f9;
  --good:#16794a;--good-bg:#e7f4ec;--bad:#c2362f;--bad-bg:#fbeceb;--warn:#a86400;--warn-bg:#fdf3e1;--low:#6f6e68;--low-bg:#efeeea;
  --os-linux:#2a78d6;--os-macos:#1baf7a;--os-windows:#eb6834;--os-self-hosted:#eda100;
  --code-bg:#f4f4f1;--shadow:0 1px 2px rgba(20,20,15,.04),0 1px 1px rgba(20,20,15,.03);
  --radius:10px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --bg:#111112;--surface:#19191b;--surface-2:#202023;--border:#2a2a2e;--border-strong:#38383d;
    --text:#ededeb;--text-2:#b4b3ad;--text-3:#7d7c77;
    --accent:#f0743a;--series:#3987e5;--series-soft:#1d2d44;
    --good:#4cc38a;--good-bg:#14291f;--bad:#f07b72;--bad-bg:#3a1b19;--warn:#e9a93a;--warn-bg:#33270f;--low:#9b9a94;--low-bg:#26262a;
    --os-linux:#3987e5;--os-macos:#199e70;--os-windows:#d95926;--os-self-hosted:#c98500;
    --code-bg:#141416;--shadow:none;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:40px 24px 56px}
a{color:var(--series);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.88em;background:var(--surface-2);border:1px solid var(--border);padding:.05em .35em;border-radius:5px;overflow-wrap:break-word}
.num,.kpi-value,.save,.wf-cost,.lg-val{font-variant-numeric:tabular-nums}
.strong{font-weight:550;color:var(--text)}
.muted{display:block;color:var(--text-3);font-size:12px;margin-top:1px}
.muted-inline{color:var(--text-3)}

.top{margin-bottom:28px}
.brand{display:inline-flex;align-items:center;gap:6px;color:var(--accent);font-weight:650;font-size:13px;letter-spacing:.01em}
.brand span{color:var(--text-2)}
h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:10px 0 4px;font-weight:650;overflow-wrap:anywhere}
.sub{margin:0;color:var(--text-2)}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:36px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow);min-width:0}
.kpi-label{color:var(--text-2);font-size:12.5px;font-weight:500}
.kpi-value{font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-.025em;margin:6px 0 4px}
.kpi-value small{font-size:15px;font-weight:500;color:var(--text-3);letter-spacing:0}
.kpi-sub{color:var(--text-3);font-size:12.5px}
.kpi-bad .kpi-value{color:var(--bad)}
.kpi-good .kpi-value{color:var(--good)}

section{margin-bottom:36px;min-width:0}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
h2{font-size:15px;font-weight:620;margin:0;letter-spacing:-.005em}
.note{color:var(--text-3);font-size:12.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.empty{color:var(--text-2)}

.stack{display:flex;gap:2px;height:12px;border-radius:4px;overflow:hidden;background:var(--surface-2)}
.seg{display:block;min-width:3px}
.os-linux{background:var(--os-linux)}.os-macos{background:var(--os-macos)}.os-windows{background:var(--os-windows)}.os-self-hosted{background:var(--os-self-hosted)}
.legend{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.legend li{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:center}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.lg-name{color:var(--text-2);font-size:12.5px}
.lg-val{grid-column:2;font-size:17px;font-weight:620;letter-spacing:-.01em}
.lg-val small{font-size:12px;color:var(--text-3);font-weight:500}
.lg-sub{grid-column:2;color:var(--text-3);font-size:12px}

.findings{display:grid;gap:12px}
.finding{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow);position:relative;min-width:0}
.finding::before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--sev)}
.sev-high{--sev:var(--bad);--sev-bg:var(--bad-bg)}
.sev-medium{--sev:var(--warn);--sev-bg:var(--warn-bg)}
.sev-low{--sev:var(--low);--sev-bg:var(--low-bg)}
.finding-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.finding-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:12px;color:var(--text-3);min-width:0}
.idx{font-weight:600;color:var(--text-2);font-variant-numeric:tabular-nums}
.sev{display:inline-flex;align-items:center;gap:5px;font-weight:600;color:var(--sev);background:var(--sev-bg);padding:1px 8px 1px 7px;border-radius:999px}
.sev i{width:6px;height:6px;border-radius:50%;background:currentColor}
.kind{font-family:var(--mono);font-size:11.5px}
.scope{color:var(--text-2)}
.save{white-space:nowrap;text-align:right;color:var(--good);font-weight:650;display:flex;flex-direction:column;align-items:flex-end;gap:1px}
.save-hours{color:var(--text-2)}
.save-hours .save-value{font-size:15px}
.save.only-hours .save-hours .save-value{font-size:20px}
.save-value{font-size:20px;letter-spacing:-.015em}
.save-unit{font-size:12.5px;font-weight:500;margin-left:1px}
.finding h3{font-size:16px;line-height:1.35;margin:10px 0 4px;font-weight:620;letter-spacing:-.01em}
.detail{margin:0 0 14px;color:var(--text-2);max-width:78ch}
.fix{border-top:1px solid var(--border);padding-top:12px}
.fix-label{font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin-bottom:6px}
.fix p{margin:0 0 10px;max-width:78ch}
.fix p:last-child{margin-bottom:0}
.code{position:relative;margin:4px 0 10px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px}
.code:last-child{margin-bottom:0}
.code pre{margin:0;padding:14px 16px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.6}
.code pre code{background:none;border:0;padding:0;font-size:inherit;overflow-wrap:normal}
.code-lang{position:absolute;right:76px;top:9px;font-family:var(--mono);font-size:11px;color:var(--text-3)}
.copy{position:absolute;top:6px;right:6px;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;color:var(--text-2);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer}
.copy:hover{color:var(--text);border-color:var(--border-strong)}
.copy.done{color:var(--good)}
.evidence{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:12px;font-size:12.5px;align-items:center}
.evidence span{color:var(--text-3)}
.evidence a{font-family:var(--mono);font-size:12px}

.wfs{display:grid;gap:4px;padding:10px 18px}
.wf{display:grid;grid-template-columns:minmax(150px,220px) 1fr 80px;grid-template-areas:"name bar cost" "name meta meta";column-gap:16px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.wf:last-child{border-bottom:0}
.wf-name{grid-area:name;min-width:0}
.wf-name span{display:block;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-name code{background:none;border:0;padding:0;color:var(--text-3);font-size:11.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-bar{grid-area:bar;height:10px;background:var(--surface-2);border-radius:4px;overflow:hidden}
.wf-bar span{display:block;height:100%;background:var(--series);border-radius:0 4px 4px 0;min-width:2px}
.wf-cost{grid-area:cost;text-align:right;font-weight:620}
.wf-meta{grid-area:meta;display:flex;gap:2px 14px;font-size:12px;color:var(--text-3);margin-top:4px;flex-wrap:wrap}
.wf-meta .warn{color:var(--warn);font-weight:550}
.trend.up{color:var(--bad)}.trend.down{color:var(--good)}
.trend::before{content:"trend "}

.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface-2)}
th{font-size:12px;font-weight:550;color:var(--text-2);background:var(--surface);white-space:nowrap;position:sticky;top:0}
th.num,td.num{text-align:right;white-space:nowrap}
td.warn{color:var(--warn);font-weight:550}
tbody td:first-child{min-width:190px}
th button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
th button:focus-visible{outline:2px solid var(--series);outline-offset:2px;border-radius:3px}
th.num button{flex-direction:row-reverse}
.arrow{width:8px;opacity:0;font-size:10px}
th.sorted-asc .arrow,th.sorted-desc .arrow{opacity:1}
th.sorted-asc .arrow::after{content:"▲"}th.sorted-desc .arrow::after{content:"▼"}
th.sorted-asc,th.sorted-desc{color:var(--text)}
.os-chip{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;color:var(--text-2)}
.rate{display:inline-block;width:44px;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin-right:8px;vertical-align:middle}
.rate span{display:block;height:100%;background:var(--series)}
#flaky .rate span{background:var(--warn)}
td.links{white-space:nowrap}
td.links a{font-family:var(--mono);font-size:12px;margin-right:8px}

.collapsible:not(.expanded) .extra{display:none}
.more{display:block;width:100%;font:inherit;font-size:12.5px;color:var(--text-2);background:none;border:0;border-top:1px solid var(--border);padding:10px;cursor:pointer;text-align:center}
.more:hover{color:var(--text);background:var(--surface-2)}
.wfs .more{margin-top:-1px;border-top:0}
.two{display:grid;grid-template-columns:1fr;gap:0}
footer{border-top:1px solid var(--border);padding-top:20px;color:var(--text-3);font-size:12.5px}
footer p{margin:0 0 8px;max-width:90ch}
footer strong,footer .strong{color:var(--text-2);font-weight:600}
footer .gen{margin-top:14px}

@media (max-width:820px){
  .legend{grid-template-columns:repeat(2,1fr)}
}
@media (max-width:560px){
  main{padding:24px 16px 40px}
  h1{font-size:21px}
  .kpis{gap:8px;grid-template-columns:repeat(2,1fr)}
  .kpi:last-child:nth-child(odd){grid-column:1/-1}
  .kpi{padding:12px 14px}
  .kpi-value{font-size:23px}
  .finding{padding:16px}
  .finding-top{flex-direction:column-reverse;gap:6px}
  .save{text-align:left;align-items:flex-start;flex-direction:row;gap:12px;align-items:baseline}
  .wfs{padding:6px 14px}
  .wf{grid-template-columns:1fr auto;grid-template-areas:"name cost" "bar bar" "meta meta";row-gap:6px}
  .wf-meta{margin-top:0;column-gap:10px}
  .trend::before{content:""}
  th,td{padding:9px 12px}
}
@media print{
  body{background:#fff}
  .copy{display:none}
  .finding,.card,.kpi{box-shadow:none;break-inside:avoid}
}
`;

const JS = `
(function(){
  function copyText(text){
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function(resolve, reject){
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  document.querySelectorAll(".copy").forEach(function(btn){
    btn.addEventListener("click", function(){
      var code = btn.parentElement.querySelector("code");
      var label = btn.querySelector("span");
      copyText(code.textContent).then(function(){
        btn.classList.add("done"); label.textContent = "Copied";
        setTimeout(function(){ btn.classList.remove("done"); label.textContent = "Copy"; }, 1500);
      }, function(){
        // Clipboard blocked (e.g. sandboxed viewer): select the code so the user can copy it manually.
        var range = document.createRange(); range.selectNodeContents(code);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        label.textContent = "Selected";
      });
    });
  });
  document.querySelectorAll(".collapsible .more").forEach(function(btn){
    btn.addEventListener("click", function(){
      var box = btn.closest(".collapsible");
      var open = box.classList.toggle("expanded");
      btn.textContent = open ? btn.dataset.less : btn.dataset.more;
    });
  });
  document.querySelectorAll("table.sortable").forEach(function(table){
    var heads = table.querySelectorAll("th");
    heads.forEach(function(th, col){
      th.querySelector("button").addEventListener("click", function(){
        var num = th.dataset.type === "num";
        var desc = th.classList.contains("sorted-desc") ? false : th.classList.contains("sorted-asc") ? true : num;
        heads.forEach(function(h){ h.classList.remove("sorted-asc", "sorted-desc"); h.removeAttribute("aria-sort"); });
        th.classList.add(desc ? "sorted-desc" : "sorted-asc");
        th.setAttribute("aria-sort", desc ? "descending" : "ascending");
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function(a, b){
          var x = a.cells[col].dataset.v, y = b.cells[col].dataset.v;
          var r = num ? (parseFloat(x) - parseFloat(y)) : x.localeCompare(y);
          return desc ? -r : r;
        });
        var box = table.closest(".collapsible");
        var limit = box ? parseInt(box.dataset.visible || "0", 10) : 0;
        rows.forEach(function(r, i){
          if (limit) r.classList.toggle("extra", i >= limit);
          body.appendChild(r);
        });
      });
    });
  });
})();
`;
