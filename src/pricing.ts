// GitHub Actions runner pricing and billing helpers.
//
// Source: https://docs.github.com/en/billing/reference/actions-runner-pricing
// (checked 2026-11-19). GitHub cut hosted-runner prices on 2026-01-01 (up to -39%) and
// folded a $0.002/min "platform charge" into every hosted rate:
// https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/
// The announced $0.002/min fee for SELF-HOSTED runners (planned for 2026-03-01) was postponed
// and is not listed in the billing docs as of 2026-11-19, so `selfHosted` defaults to 0.
//
// List prices only: standard runners in public repos are free; the report layer notes that.

import type { Job, Pricing, RunnerOs } from "./types.ts";

/** Platform charge that is part of every hosted per-minute rate (x64 larger runner = fee + cores * perCore). */
export const PLATFORM_FEE_PER_MIN = 0.002;

export const DEFAULT_PRICING: Pricing = {
  linux: 0.006, // Linux 2-core x64
  linuxArm: 0.005, // Linux 2-core arm64
  windows: 0.01, // Windows 2-core (x64 and arm64)
  macos: 0.062, // macOS 3/4-core (M1 or Intel)
  selfHosted: 0, // fee postponed, see header
  // Linux x64 larger runners: 4c $0.012, 8c $0.022, 16c $0.042, 32c $0.082, 64c $0.162, 96c $0.252
  // => exactly PLATFORM_FEE_PER_MIN + cores * 0.0025.
  largerLinuxPerCore: 0.0025,
};

// Ratios against `largerLinuxPerCore`, derived from the same price table:
//   Windows x64 larger: 0.002 + cores * 0.005   (2x)
//   Windows arm64 larger: 0.002 + cores * 0.003 (1.2x)
//   Linux arm64 larger: 0.002 + cores * 0.0015  (0.6x)
const WINDOWS_X64_CORE_FACTOR = 2;
const WINDOWS_ARM_CORE_FACTOR = 1.2;
const LINUX_ARM_CORE_FACTOR = 0.6;
// macOS larger runners relative to the standard macOS rate: 12-core Intel ("-large") $0.077,
// M2 Pro 5-core ("-xlarge") $0.102.
const MACOS_LARGE_FACTOR = 0.077 / 0.062;
const MACOS_XLARGE_FACTOR = 0.102 / 0.062;
// Linux 1-core "ubuntu-slim" is $0.002 = one third of the 2-core rate.
const LINUX_SLIM_FACTOR = 0.002 / 0.006;
// Linux 4-core GPU runner, flat.
const LINUX_GPU_PER_MIN = 0.052;

function lower(labels: string[]): string[] {
  return labels.map((l) => l.toLowerCase());
}

/** Classify a job's runner from its runs-on labels. Unknown hosted labels default to linux. */
export function runnerOs(labels: string[]): RunnerOs {
  const ls = lower(labels);
  if (ls.includes("self-hosted")) return "self-hosted";
  // "xcode-27"-style custom labels (seen in facebook/react-native) only exist on macOS runners.
  if (ls.some((l) => /mac(os)?|osx|xcode|(^|[-_])(ios|apple)([-_]|$)/.test(l))) return "macos";
  if (ls.some((l) => /windows|^win-|-win-|^win\d/.test(l))) return "windows";
  return "linux";
}

/**
 * Best-effort core count from larger-runner labels:
 * "ubuntu-latest-8-cores", "ubuntu-22.04-16core", "linux-4-core", "windows_32_cores".
 * Returns null when no core count is present (standard runner).
 */
export function runnerCores(labels: string[]): number | null {
  for (const l of lower(labels)) {
    const m = /(\d+)[-_ ]?cores?\b/.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}

/** arm64 runner: "ubuntu-24.04-arm", "linux-arm64", "*-aarch64", "windows-11-arm", macOS "-xlarge" (Apple silicon). */
export function isArmRunner(labels: string[]): boolean {
  return lower(labels).some((l) => /(^|[-_])(arm|arm64|aarch64)($|[-_])/.test(l) || /^macos-.*-xlarge$/.test(l));
}

/** USD per billable minute for a job running on the given labels. */
export function jobPricePerMinute(labels: string[], pricing: Pricing): number {
  const os = runnerOs(labels);
  if (os === "self-hosted") return pricing.selfHosted;
  const ls = lower(labels);
  const cores = runnerCores(labels);
  const arm = isArmRunner(labels);

  if (os === "macos") {
    if (ls.some((l) => /-xlarge$/.test(l))) return pricing.macos * MACOS_XLARGE_FACTOR;
    if (ls.some((l) => /-large$/.test(l))) return pricing.macos * MACOS_LARGE_FACTOR;
    return pricing.macos;
  }
  if (os === "windows") {
    if (cores !== null && cores > 2) {
      const factor = arm ? WINDOWS_ARM_CORE_FACTOR : WINDOWS_X64_CORE_FACTOR;
      return PLATFORM_FEE_PER_MIN + cores * pricing.largerLinuxPerCore * factor;
    }
    return pricing.windows;
  }
  // linux (also the fallback for unknown hosted labels)
  if (ls.some((l) => l.includes("gpu"))) return LINUX_GPU_PER_MIN;
  if (ls.includes("ubuntu-slim") || cores === 1) return pricing.linux * LINUX_SLIM_FACTOR;
  if (cores !== null && cores > 2) {
    const perCore = pricing.largerLinuxPerCore * (arm ? LINUX_ARM_CORE_FACTOR : 1);
    return PLATFORM_FEE_PER_MIN + cores * perCore;
  }
  return arm ? pricing.linuxArm : pricing.linux;
}

/** Job duration in seconds (startedAt -> completedAt), null if it never ran. */
export function jobDurationSec(job: Job): number | null {
  if (job.conclusion === "skipped" || !job.startedAt || !job.completedAt) return null;
  const sec = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** GitHub bills each job rounded UP to the whole minute; skipped / never-started jobs cost 0. */
export function billableMinutes(job: Job): number {
  const sec = jobDurationSec(job);
  return sec === null ? 0 : Math.ceil(sec / 60);
}
