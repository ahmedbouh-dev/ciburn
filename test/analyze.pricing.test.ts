import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICING,
  billableMinutes,
  isArmRunner,
  jobPricePerMinute,
  runnerCores,
  runnerOs,
} from "../src/pricing.ts";
import { makeJob } from "./fixtures/build.ts";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const price = (labels: string[]) => jobPricePerMinute(labels, DEFAULT_PRICING);
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

test("runnerOs classifies labels", () => {
  assert.equal(runnerOs(["ubuntu-latest"]), "linux");
  assert.equal(runnerOs(["ubuntu-24.04-arm"]), "linux");
  assert.equal(runnerOs(["self-hosted", "linux", "x64"]), "self-hosted");
  assert.equal(runnerOs(["self-hosted", "macOS"]), "self-hosted");
  assert.equal(runnerOs(["macos-14"]), "macos");
  assert.equal(runnerOs(["macos-latest-xlarge"]), "macos");
  assert.equal(runnerOs(["windows-2022"]), "windows");
  assert.equal(runnerOs(["windows-latest-8-cores"]), "windows");
  assert.equal(runnerOs(["acme-custom-runner"]), "linux", "unknown hosted labels default to linux");
  assert.equal(runnerOs([]), "linux");
});

test("runnerCores parses larger-runner labels", () => {
  assert.equal(runnerCores(["ubuntu-latest-4-cores"]), 4);
  assert.equal(runnerCores(["ubuntu-22.04-16core"]), 16);
  assert.equal(runnerCores(["linux-8-core"]), 8);
  assert.equal(runnerCores(["windows_32_cores"]), 32);
  assert.equal(runnerCores(["ubuntu-latest"]), null);
});

test("isArmRunner", () => {
  assert.equal(isArmRunner(["ubuntu-24.04-arm"]), true);
  assert.equal(isArmRunner(["linux-arm64-4-cores"]), true);
  assert.equal(isArmRunner(["ubuntu-latest"]), false);
  assert.equal(isArmRunner(["ubuntu-latest-harmony"]), false);
});

test("standard runner prices (2026 list prices)", () => {
  near(price(["ubuntu-latest"]), 0.006);
  near(price(["ubuntu-24.04-arm"]), 0.005);
  near(price(["ubuntu-slim"]), 0.002);
  near(price(["windows-latest"]), 0.01);
  near(price(["macos-latest"]), 0.062);
  near(price(["self-hosted", "linux"]), 0);
  near(price(["acme-custom-runner"]), 0.006);
});

test("larger runner prices match GitHub's table", () => {
  near(price(["ubuntu-latest-4-cores"]), 0.012);
  near(price(["ubuntu-latest-8-cores"]), 0.022);
  near(price(["ubuntu-22.04-16core"]), 0.042);
  near(price(["linux-64-cores"]), 0.162);
  near(price(["ubuntu-24.04-arm-4-cores"]), 0.008);
  near(price(["linux-arm64-16-cores"]), 0.026);
  near(price(["windows-latest-8-cores"]), 0.042);
  near(price(["windows-11-arm-8-cores"]), 0.026);
  near(price(["macos-14-large"]), 0.077);
  near(price(["macos-14-xlarge"]), 0.102);
  near(price(["ubuntu-latest-2-cores"]), 0.006);
});

test("self-hosted price follows the pricing table", () => {
  near(jobPricePerMinute(["self-hosted"], { ...DEFAULT_PRICING, selfHosted: 0.002 }), 0.002);
});

test("billableMinutes rounds each job up to whole minutes", () => {
  const job = (durationSec: number, extra: object = {}) => makeJob(1, T0, { name: "j", durationSec, ...extra });
  assert.equal(billableMinutes(job(1)), 1);
  assert.equal(billableMinutes(job(60)), 1);
  assert.equal(billableMinutes(job(61)), 2);
  assert.equal(billableMinutes(job(359.5 * 60)), 360);
  assert.equal(billableMinutes(job(0)), 0);
  assert.equal(billableMinutes(job(120, { conclusion: "skipped" })), 0);
  assert.equal(billableMinutes(job(120, { notStarted: true, conclusion: null })), 0);
  assert.equal(billableMinutes(job(300, { conclusion: "cancelled" })), 5, "cancelled jobs are billed for time run");
});
