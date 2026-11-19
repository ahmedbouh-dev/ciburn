// GitHub-flavored Markdown report for $GITHUB_STEP_SUMMARY and PR/issue comments.
import type { Finding, Report } from "../types.ts";
import {
  dateRange, duration, hours, int, minutes, monthlyFactor, pct, savingsParts, sortFindings, splitFences,
  totalDevHours, totalSavings, trend, usd, wasteShare,
} from "./format.ts";

/** Hidden marker so a bot can find and update its own comment. */
export const MARKDOWN_MARKER = "<!-- ciburn-report -->";

const MAX_JOBS = 15;

/** Escape text for a GFM table cell / inline position (pipes, HTML, newlines). */
export function mdCell(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/** Escape HTML-significant characters only. */
function htmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape prose but keep `code spans` intact (they render literally on GitHub). */
function mdInline(s: string): string {
  return s
    .split(/(`[^`\n]+`)/g)
    .map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part : htmlText(part)))
    .join("");
}

/** Re-emit a fix: prose escaped, code fences kept verbatim (fence length grown if needed). */
function mdFix(fix: string): string {
  return splitFences(fix)
    .map((seg) => {
      if (seg.type === "text") return mdInline(seg.text.trim());
      const ticks = "`".repeat(Math.max(3, ...[...seg.code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `${ticks}${seg.lang}\n${seg.code}\n${ticks}`;
    })
    .join("\n\n");
}

const oneLineText = (s: string) => s.replace(/\s+/g, " ").trim();

const SEV: Record<Finding["severity"], string> = { high: "🔴 High", medium: "🟠 Medium", low: "⚪ Low" };

function table(head: string[], align: ("l" | "r")[], rows: string[][]): string {
  const sep = align.map((a) => (a === "r" ? "---:" : ":---"));
  return [head, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** Only allow plain http(s) URLs as link targets. */
function safeUrl(u: string): string | null {
  return /^https?:\/\/[^\s<>"()]+$/i.test(u) ? u : null;
}

export function renderMarkdown(report: Report): string {
  const k = monthlyFactor(report);
  const t = report.totals;
  const savings = totalSavings(report.findings);
  const devHours = totalDevHours(report.findings);
  const out: string[] = [];

  out.push(MARKDOWN_MARKER);
  out.push(`## 🔥 ciburn: CI cost report for \`${report.repo.replace(/[`\r\n]/g, "")}\``);
  out.push("");
  out.push(
    `${dateRange(report.since, report.until)} (${report.days} days) · ${int(t.runs)} runs · ${int(t.jobs)} jobs`,
  );
  out.push("");
  out.push(
    table(
      ["Monthly CI spend", "Wasted", "Billing savings", ...(devHours > 0 ? ["Dev time saved"] : []), "Queue time"],
      ["r", "r", "r", ...(devHours > 0 ? (["r"] as const) : []), "r"],
      [[
        `**${usd(t.monthlyCost.usd)}**`,
        `**${pct(wasteShare(report))}** (${usd(t.wastedCost.usd * k)}/mo)`,
        `**${usd(savings)}/mo**`,
        ...(devHours > 0 ? [`**${hours(devHours)}/mo**`] : []),
        `${t.queueHours.toFixed(1)} h in window`,
      ]],
    ),
  );
  out.push("");

  // Findings
  const findings = sortFindings(report);
  if (findings.length > 0) {
    out.push(`### Top fixes (${findings.length})`);
    out.push("");
    for (const [i, f] of findings.entries()) {
      const parts = savingsParts(f);
      const save = parts.length > 0 ? ` · saves ~${parts.join(" + ")}` : "";
      out.push("<details>");
      out.push(`<summary><b>${i + 1}. ${htmlText(oneLineText(f.title)).replace(/`([^`]+)`/g, "<code>$1</code>")}</b> · ${SEV[f.severity]}${save}</summary>`);
      out.push("");
      out.push(mdInline(f.detail));
      out.push("");
      out.push("**Fix:**");
      out.push("");
      out.push(mdFix(f.fix));
      const links = f.evidence.map(safeUrl).filter((u): u is string => u !== null).slice(0, 5);
      if (links.length > 0) {
        out.push("");
        out.push(`Evidence: ${links.map((u, n) => `[run ${n + 1}](${u})`).join(" · ")}`);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
  }

  // Workflows
  if (report.workflows.length > 0) {
    out.push("### Workflows by cost");
    out.push("");
    out.push(
      table(
        ["Workflow", "Cost / mo", "Share", "Runs", "Pass rate", "p50", "p95", "Trend"],
        ["l", "r", "r", "r", "r", "r", "r", "r"],
        report.workflows.map((w) => [
          `${mdCell(w.workflowName)}<br><sub>${mdCell(w.workflowPath)}</sub>`,
          usd(w.cost.usd * k),
          pct(t.cost.usd > 0 ? w.cost.usd / t.cost.usd : 0),
          int(w.runs),
          pct(w.successRate),
          duration(w.p50DurationSec),
          duration(w.p95DurationSec),
          trend(w.costTrend),
        ]),
      ),
    );
    out.push("");
  }

  // Jobs
  if (report.jobs.length > 0) {
    out.push("<details>");
    out.push(`<summary><b>Jobs by cost</b> (top ${Math.min(MAX_JOBS, report.jobs.length)} of ${report.jobs.length})</summary>`);
    out.push("");
    out.push(
      table(
        ["Job", "Workflow", "Runner", "Cost / mo", "p50", "p95 queue", "Fail rate"],
        ["l", "l", "l", "r", "r", "r", "r"],
        report.jobs.slice(0, MAX_JOBS).map((j) => [
          mdCell(j.jobName),
          mdCell(j.workflowName),
          j.os,
          usd(j.cost.usd * k),
          duration(j.p50DurationSec),
          duration(j.p95QueueSec),
          pct(j.failureRate),
        ]),
      ),
    );
    out.push("");
    out.push("</details>");
    out.push("");
  }

  // Flaky
  if (report.flaky.length > 0) {
    out.push("### Flaky jobs");
    out.push("");
    out.push(
      table(
        ["Job", "Workflow", "Flaky commits", "Flake rate", "Wasted / mo", "Examples"],
        ["l", "l", "r", "r", "r", "l"],
        report.flaky.map((f) => [
          mdCell(f.jobName),
          mdCell(f.workflowName),
          `${f.flakyCount} / ${f.occurrences}`,
          pct(f.flakeRate),
          usd(f.wastedCost.usd * k),
          f.examples.map(safeUrl).filter((u): u is string => u !== null).slice(0, 3)
            .map((u, n) => `[${n + 1}](${u})`).join(" "),
        ]),
      ),
    );
    out.push("");
  }

  // Steps
  if (report.slowSteps.length > 0) {
    out.push("<details>");
    out.push("<summary><b>Slowest steps</b> (total runner time in window)</summary>");
    out.push("");
    out.push(
      table(
        ["Step", "Job", "Workflow", "Total", "p50", "Samples"],
        ["l", "l", "l", "r", "r", "r"],
        report.slowSteps.map((s) => [
          mdCell(s.stepName),
          mdCell(s.jobName),
          mdCell(s.workflowName),
          duration(s.totalSec),
          duration(s.p50Sec),
          int(s.samples),
        ]),
      ),
    );
    out.push("");
    out.push("</details>");
    out.push("");
  }

  const pr = report.pricing;
  out.push(
    `<sub>Generated by ciburn · ${minutes(t.cost.minutes)} billed in window · pricing per minute: Linux $${pr.linux}, Windows $${pr.windows}, macOS $${pr.macos}. ` +
      "$ figures are list-price equivalents; public repos on standard runners are free. " +
      `Dev time is valued at ${usd(report.devHourlyUsd)}/h only to rank findings and is never added to $.</sub>`,
  );
  return out.join("\n") + "\n";
}
