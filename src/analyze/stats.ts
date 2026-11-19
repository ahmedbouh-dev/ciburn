// Small numeric helpers. Pure functions.

import type { Money } from "../types.ts";

/**
 * Percentile with linear interpolation between closest ranks (same as numpy's default).
 * p in [0, 100]. Empty input returns 0.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Money with usd rounded to cents and minutes to 0.1. */
export function money(minutes: number, usd: number): Money {
  return { minutes: round(minutes, 1), usd: round(usd, 2) };
}

export const ZERO: Money = { minutes: 0, usd: 0 };

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Format seconds for human-readable detail text: "45s", "3.2 min", "1.4 h". */
export function fmtDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${round(sec / 60, 1)} min`;
  return `${round(sec / 3600, 1)} h`;
}

/** Analysis window for prose: "7 days", "1.5 days", "8 h". */
export function fmtWindow(days: number): string {
  if (days < 1.5) return `${Math.max(1, Math.round(days * 24))} h`;
  return `${round(days, days < 10 ? 1 : 0)} days`;
}

export function fmtUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}

export function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
