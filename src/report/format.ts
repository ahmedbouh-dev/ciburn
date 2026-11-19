// Shared number/text formatting helpers for all renderers.
import type { Finding, Report } from "../types.ts";

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const centsFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234" (>= $100, whole dollars), "$12.40", "<$0.01", "$0". */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 0.01) return `${sign}<$0.01`;
  if (a >= 100) return `${sign}$${intFmt.format(Math.round(a))}`;
  return `${sign}$${centsFmt.format(a)}`;
}

/** "42s", "3m 10s", "1h 05m". */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "–";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m}m` : `${m}m ${String(r).padStart(2, "0")}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Ratio (0..1) to percent: "12%", "<1%", "0%". */
export function pct(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "–";
  const v = ratio * 100;
  if (v === 0) return "0%";
  const min = digits === 0 ? 1 : 10 ** -digits;
  if (Math.abs(v) < min) return `${v < 0 ? ">-" : "<"}${min}%`;
  return `${v.toFixed(digits)}%`;
}

/** Signed trend: "+18%", "-5%". */
export function trend(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "–";
  const p = Math.round(ratio * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

/** "12,345 min". */
export function minutes(n: number): string {
  return `${intFmt.format(Math.round(n))} min`;
}

/** Plain integer with thousands separators. */
export function int(n: number): string {
  return intFmt.format(Math.round(n));
}

/** "Nov 5 – Nov 19, 2026" from two ISO timestamps (UTC). */
export function dateRange(since: string, until: string): string {
  const a = new Date(since);
  const b = new Date(until);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${since} – ${until}`;
  const md = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = sameYear ? md(a) : `${md(a)}, ${a.getUTCFullYear()}`;
  return `${left} – ${md(b)}, ${b.getUTCFullYear()}`;
}

/** Factor that normalizes a window-cost to 30 days. */
export function monthlyFactor(report: Report): number {
  return report.days > 0 ? 30 / report.days : 1;
}

/** Developer hours: "38h", "2.5h", "<0.1h", "0h". */
export function hours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0h";
  if (h < 0.1) return "<0.1h";
  if (h < 10) return `${(Math.round(h * 10) / 10).toString()}h`;
  return `${intFmt.format(Math.round(h))}h`;
}

/** Ranking score: billing $ plus dev time valued at devHourlyUsd. Used for ORDER only, never displayed as $. */
export function impact(f: Finding, devHourlyUsd: number): number {
  return (f.monthlySavings?.usd ?? 0) + (f.devHoursSaved ?? 0) * devHourlyUsd;
}

/** Findings sorted by impact desc (stable for ties). */
export function sortFindings(report: Report): Finding[] {
  const rate = Number.isFinite(report.devHourlyUsd) ? report.devHourlyUsd : 100;
  return [...report.findings].sort((a, b) => impact(b, rate) - impact(a, rate));
}

/** Sum of all findings' monthly developer hours saved. */
export function totalDevHours(findings: Finding[]): number {
  return findings.reduce((s, f) => s + (f.devHoursSaved ?? 0), 0);
}

/** Per-finding savings parts, e.g. ["$281/mo", "2.5h dev time/mo"] (short: "2.5h dev"); empty if neither applies. */
export function savingsParts(f: Finding, short = false): string[] {
  const out: string[] = [];
  if ((f.monthlySavings?.usd ?? 0) > 0) out.push(`${usd(f.monthlySavings.usd)}/mo`);
  if ((f.devHoursSaved ?? 0) > 0) out.push(short ? `${hours(f.devHoursSaved)} dev` : `${hours(f.devHoursSaved)} dev time/mo`);
  return out;
}

/** Remove markdown emphasis markers (**bold**, __bold__) for plain-text output. */
export function stripEmphasis(s: string): string {
  return s.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
}

/** Sum of all findings' monthly billing savings (never includes dev time). */
export function totalSavings(findings: Finding[]): number {
  return findings.reduce((s, f) => s + (f.monthlySavings?.usd ?? 0), 0);
}

/** Share of the window cost that was wasted (0..1). */
export function wasteShare(report: Report): number {
  const c = report.totals.cost.usd;
  return c > 0 ? report.totals.wastedCost.usd / c : 0;
}

/** Split a markdown-ish string into prose and fenced code segments. */
export type FixSegment = { type: "text"; text: string } | { type: "code"; lang: string; code: string };

export function splitFences(src: string): FixSegment[] {
  const out: FixSegment[] = [];
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:\n?```|$)/g;
  let last = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m.index > last) out.push({ type: "text", text: src.slice(last, m.index) });
    out.push({ type: "code", lang: m[1] ?? "", code: (m[2] ?? "").replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", text: src.slice(last) });
  return out.filter((s) => (s.type === "text" ? s.text.trim() !== "" : true));
}
