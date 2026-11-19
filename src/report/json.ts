// Machine-readable report: pretty-printed, with stable (sorted) object keys.
import type { Report } from "../types.ts";

/** Recursively sort object keys so output is stable across runs and diff-friendly. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function renderJson(report: Report): string {
  return JSON.stringify(sortKeys({ schema: "ciburn/report@1", ...report }), null, 2) + "\n";
}
