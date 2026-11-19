// Compact terminal report: "get it in 5 seconds", then details.
import type { Finding, Report } from "../types.ts";
import {
  dateRange, duration, hours, int, monthlyFactor, pct, savingsParts, sortFindings, splitFences, stripEmphasis,
  totalDevHours, totalSavings, trend, usd, wasteShare,
} from "./format.ts";

export interface TerminalOptions {
  /** Emit ANSI colors. Callers should pass false for NO_COLOR / non-TTY. */
  color: boolean;
  /** Target width in columns (clamped to 60..120). Default 80. */
  width?: number;
}

const MAX_FIXES = 5;
const MAX_CODE_LINES = 6;
const MAX_WORKFLOWS = 6;
const MAX_FLAKY = 3;
const MAX_STEPS = 5;

type Style = (s: string) => string;
interface Palette {
  bold: Style; dim: Style; red: Style; yellow: Style; green: Style; cyan: Style; gray: Style;
}

function palette(color: boolean): Palette {
  // Close with the specific "off" code (not a full reset) so styles can nest.
  const wrap = (open: string, close: string): Style =>
    color ? (s) => (s === "" ? s : `\x1b[${open}m${s}\x1b[${close}m`) : (s) => s;
  return {
    bold: wrap("1", "22"), dim: wrap("2", "22"), red: wrap("31", "39"), yellow: wrap("33", "39"),
    green: wrap("32", "39"), cyan: wrap("36", "39"), gray: wrap("90", "39"),
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** Visible length of a string (ANSI stripped). */
export function visibleLength(s: string): number {
  return [...s.replace(ANSI_RE, "")].length;
}

/** Truncate plain text to `n` visible chars with an ellipsis. */
function trunc(s: string, n: number): string {
  const chars = [...s];
  if (chars.length <= n) return s;
  return n <= 1 ? "…" : chars.slice(0, n - 1).join("") + "…";
}
const padR = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleLength(s)));
const padL = (s: string, n: number) => " ".repeat(Math.max(0, n - visibleLength(s))) + s;

/** Collapse whitespace so multi-line prose fits on one terminal line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Highlight complete `inline code` spans (color mode) - text must already be truncated. */
function inline(s: string, p: Palette, color: boolean): string {
  return color ? s.replace(/`([^`]+)`/g, (_m, c: string) => p.cyan(c)) : s;
}

function bar(ratio: number, width: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  const eighths = Math.round(r * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  let s = "█".repeat(full) + (part > 0 ? partials[part] : "");
  if (s === "" && ratio > 0) s = "▏";
  return s;
}

function severityTag(f: Finding, p: Palette): string {
  if (f.severity === "high") return p.red("● HIGH");
  if (f.severity === "medium") return p.yellow("● MED ");
  return p.gray("○ LOW ");
}

export function renderTerminal(report: Report, opts: TerminalOptions): string {
  const width = Math.max(60, Math.min(120, Math.floor(opts.width ?? 80)));
  const p = palette(opts.color);
  const c = opts.color;
  const k = monthlyFactor(report);
  const out: string[] = [];
  const t = report.totals;

  // Header
  const head = `${report.repo} · ${dateRange(report.since, report.until)} (${report.days} days) · ${int(t.runs)} runs · ${int(t.jobs)} jobs`;
  out.push(`${p.bold("ciburn")}  ${trunc(head, width - 8)}`);
  out.push(p.dim("─".repeat(width)));

  // Big totals
  const savings = totalSavings(report.findings);
  const devHours = totalDevHours(report.findings);
  const waste = wasteShare(report);
  const nFix = report.findings.length;
  const big = [
    p.bold(`${usd(t.monthlyCost.usd)}/mo`),
    (waste >= 0.15 ? p.red : waste >= 0.05 ? p.yellow : p.green)(p.bold(`${pct(waste)} wasted`)),
    p.green(p.bold(`${usd(savings)}/mo`)),
  ];
  const small = [
    "monthly CI spend",
    `${usd(t.wastedCost.usd * k)}/mo burned`,
    `billing, ${nFix} fix${nFix === 1 ? "" : "es"}`,
  ];
  // Dev time is its own figure - never folded into $.
  if (devHours > 0) {
    big.push(p.green(p.bold(`${hours(devHours)}/mo`)));
    small.push("dev time saved");
  }
  const col = Math.floor((width - 2) / big.length);
  const last = big.length - 1;
  out.push("");
  out.push("  " + big.map((s, i) => (i < last ? padR(s, col) : s)).join(""));
  out.push("  " + small.map((s, i) => p.dim(i < last ? padR(trunc(s, col - 2), col) : trunc(s, width - 2 - last * col))).join(""));
  out.push("");

  // Top fixes
  const findings = sortFindings(report);
  if (findings.length > 0) {
    out.push(p.bold("TOP FIXES"));
    const indent = "            "; // aligns with title column
    const contentW = width - indent.length;
    findings.slice(0, MAX_FIXES).forEach((f, i) => {
      const save = savingsParts(f, true).join(" · ");
      const titleW = width - 12 - visibleLength(save) - 2;
      const title = trunc(oneLine(stripEmphasis(f.title)), titleW);
      out.push(
        `  ${padL(String(i + 1), 2)} ${severityTag(f, p)} ${padR(p.bold(inline(title, p, c)), titleW)}  ${p.green(save)}`,
      );
      out.push(indent + p.dim(inline(trunc(oneLine(stripEmphasis(f.detail)), contentW), p, c)));
      for (const seg of splitFences(f.fix)) {
        if (seg.type === "text") {
          const txt = trunc(oneLine(stripEmphasis(seg.text)), contentW - 2);
          out.push(`${indent}${p.cyan("→")} ${inline(txt, p, c)}`);
        } else {
          // Long snippets are capped: first lines + "… (+N lines)".
          const lines = seg.code.split("\n");
          const shown = lines.length > MAX_CODE_LINES ? lines.slice(0, MAX_CODE_LINES - 1) : lines;
          for (const line of shown) out.push(indent + "  " + p.dim(trunc(line, contentW - 2)));
          if (shown.length < lines.length) {
            out.push(indent + "  " + p.dim(`… (+${lines.length - shown.length} lines, see --html)`));
          }
        }
      }
    });
    if (findings.length > MAX_FIXES) {
      out.push(p.dim(`  +${findings.length - MAX_FIXES} more (see --html)`));
    }
    out.push("");
  }

  // Workflows by cost
  if (report.workflows.length > 0) {
    out.push(p.bold("WORKFLOWS BY COST") + p.dim("  (per month)"));
    const wfs = report.workflows.slice(0, MAX_WORKFLOWS);
    const maxCost = Math.max(...report.workflows.map((w) => w.cost.usd), 0.0001);
    const totalCost = t.cost.usd || 1;
    const showTrend = width >= 76;
    // fixed columns: indent 2 + gaps + cost 7 + share 4 + pass 9 + p50 11 (+ trend 7)
    const fixed = 2 + 1 + 1 + 7 + 1 + 4 + 1 + 9 + 1 + 11 + (showTrend ? 7 : 0);
    // Name column grows with the terminal; the bar keeps at least ~1/8 of the width.
    const minBar = Math.max(8, Math.floor(width / 8));
    const nameW = Math.max(8, Math.min(40, width - fixed - minBar, Math.max(...wfs.map((w) => [...w.workflowName].length))));
    const barW = Math.max(minBar, width - fixed - nameW);
    for (const w of wfs) {
      const cost = padL(usd(w.cost.usd * k), 7);
      const share = padL(pct(w.cost.usd / totalCost), 4);
      const passTxt = `${pct(w.successRate)} pass`;
      const pass = w.successRate < 0.8 ? p.yellow(padL(passTxt, 9)) : p.dim(padL(passTxt, 9));
      const p50 = p.dim(padL(`p50 ${duration(w.p50DurationSec)}`, 11));
      let line = `  ${padR(trunc(w.workflowName, nameW), nameW)} ${padR(p.cyan(bar(w.cost.usd / maxCost, barW)), barW)} ${cost} ${p.dim(share)} ${pass} ${p50}`;
      if (showTrend) {
        const tr = trend(w.costTrend);
        // Only flag growth on workflows that matter (>= 2% of spend); tiny ones swing wildly.
        const trC = w.costTrend !== null && w.costTrend >= 0.15 && w.cost.usd / totalCost >= 0.02 ? p.red : p.dim;
        line += " " + trC(padL(tr, 6));
      }
      out.push(line);
    }
    if (report.workflows.length > MAX_WORKFLOWS) {
      out.push(p.dim(`  +${report.workflows.length - MAX_WORKFLOWS} more (see --html)`));
    }
    out.push("");
  }

  // Flaky jobs
  if (report.flaky.length > 0) {
    out.push(p.bold("FLAKY JOBS") + p.dim("  (failed, then passed on the same commit)"));
    const rows = report.flaky.slice(0, MAX_FLAKY);
    const right = (f: (typeof rows)[number]) =>
      `${padL(`${f.flakyCount}/${f.occurrences}${width >= 76 ? " commits" : ""}`, width >= 76 ? 16 : 8)}  ${padL(pct(f.flakeRate), 4)}  ${padL(usd(f.wastedCost.usd * k), 7)}/mo`;
    const nameW = width - 2 - visibleLength(right(rows[0]!)) - 2;
    for (const f of rows) {
      const name = trunc(`${f.jobName} · ${f.workflowName}`, nameW);
      out.push(`  ${padR(name, nameW)}  ${p.yellow(right(f))}`);
    }
    if (report.flaky.length > MAX_FLAKY) out.push(p.dim(`  +${report.flaky.length - MAX_FLAKY} more (see --html)`));
    out.push("");
  }

  // Slowest steps
  if (report.slowSteps.length > 0) {
    out.push(p.bold("SLOWEST STEPS") + p.dim("  (total runner time in window)"));
    const rows = report.slowSteps.slice(0, MAX_STEPS);
    const rightW = 30;
    const nameW = width - 2 - rightW - 2;
    for (const s of rows) {
      const name = `${s.stepName} ${p.dim("·")} ${s.workflowName} / ${s.jobName}`;
      const plainLen = visibleLength(name);
      const shown = plainLen > nameW
        ? `${trunc(`${s.stepName} · ${s.workflowName} / ${s.jobName}`, nameW)}`
        : name;
      const right = `${padL(duration(s.totalSec), 8)}  ${p.dim(padL(`p50 ${duration(s.p50Sec)} × ${int(s.samples)}`, rightW - 10))}`;
      out.push(`  ${padR(shown, nameW)}  ${right}`);
    }
    if (report.slowSteps.length > MAX_STEPS) out.push(p.dim(`  +${report.slowSteps.length - MAX_STEPS} more (see --html)`));
    out.push("");
  }

  out.push(p.dim(trunc("$ = list price per minute; public repos on standard runners are free.", width)));
  if (devHours > 0) {
    out.push(p.dim(trunc(`Dev time is valued at ${usd(report.devHourlyUsd)}/h for ranking only, never added to $.`, width)));
  }
  return out.map((l) => l.replace(/\s+$/, "")).join("\n") + "\n";
}
