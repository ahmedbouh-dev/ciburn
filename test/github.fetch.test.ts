import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDataset, loadDataset, saveDataset } from "../src/github/fetch.ts";

// ---- Recorded-style fixtures (trimmed real API shapes) ----

function ghRun(id: number, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "CI",
    workflow_id: 42,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "feat/x",
    head_sha: "abc123",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    created_at: createdAt,
    run_started_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    ...extra,
  };
}

function ghJob(id: number, runId: number, attempt: number, conclusion = "success") {
  return {
    id,
    run_id: runId,
    run_attempt: attempt,
    name: "test (ubuntu)",
    status: "completed",
    conclusion,
    created_at: "2026-11-18T10:00:00Z",
    started_at: "2026-11-18T10:00:20Z",
    completed_at: "2026-11-18T10:05:20Z",
    labels: ["ubuntu-latest"],
    runner_name: "GitHub Actions 12",
    steps: [
      { name: "Set up job", number: 1, status: "completed", conclusion: "success", started_at: "2026-11-18T10:00:20Z", completed_at: "2026-11-18T10:00:22Z" },
      { name: "Run tests", number: 2, status: "completed", conclusion, started_at: "2026-11-18T10:00:22Z", completed_at: "2026-11-18T10:05:20Z" },
    ],
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Handler = (url: URL) => Response;
const realFetch = globalThis.fetch;
let calls: URL[] = [];
function mockFetch(handler: Handler) {
  calls = [];
  globalThis.fetch = (async (u: string) => {
    const url = new URL(u);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

const NOW = new Date("2026-11-19T12:00:00Z");
const base = { token: "t", cacheDir: null, sleep: async () => {}, now: NOW } as const;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ciburn-test-"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

describe("fetchDataset", () => {
  it("maps runs and jobs (all attempts), strips @ref from path, skips non-completed", async () => {
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        assert.equal(url.searchParams.get("status"), "completed");
        assert.equal(url.searchParams.get("created"), "2026-11-12T12:00:00Z..2026-11-19T12:00:00Z");
        return json({
          total_count: 2,
          workflow_runs: [
            ghRun(1, "2026-11-18T10:00:00Z", { run_attempt: 2, path: ".github/workflows/ci.yml@refs/heads/main" }),
            ghRun(2, "2026-11-18T11:00:00Z", { status: "in_progress", conclusion: null }),
          ],
        });
      }
      if (url.pathname === "/repos/o/r/actions/runs/1/jobs") {
        assert.equal(url.searchParams.get("filter"), "all");
        return json({ total_count: 2, jobs: [ghJob(11, 1, 1, "failure"), ghJob(12, 1, 2)] });
      }
      throw new Error("unexpected " + url);
    });
    const ds = await fetchDataset("o/r", { ...base, days: 7 });
    assert.equal(ds.repo, "o/r");
    assert.equal(ds.since, "2026-11-12T12:00:00.000Z");
    assert.equal(ds.until, "2026-11-19T12:00:00.000Z");
    assert.equal(ds.runs.length, 1);
    const run = ds.runs[0];
    assert.equal(run.workflowPath, ".github/workflows/ci.yml");
    assert.equal(run.workflowName, "CI");
    assert.equal(run.runAttempt, 2);
    assert.equal(run.headBranch, "feat/x");
    assert.equal(run.jobs.length, 2);
    assert.deepEqual(
      run.jobs.map((j) => [j.runAttempt, j.conclusion]),
      [[1, "failure"], [2, "success"]],
    );
    const job = run.jobs[1];
    assert.deepEqual(job.labels, ["ubuntu-latest"]);
    assert.equal(job.runnerName, "GitHub Actions 12");
    assert.equal(job.createdAt, "2026-11-18T10:00:00Z");
    assert.equal(job.steps.length, 2);
    assert.deepEqual(Object.keys(job.steps[0]).sort(), ["completedAt", "conclusion", "name", "number", "startedAt"]);
  });

  it("follows Link pagination for runs", async () => {
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const runs = Array.from({ length: page === 1 ? 100 : 50 }, (_, i) => ghRun(page * 1000 + i, "2026-11-18T10:00:00Z"));
        const headers: Record<string, string> =
          page === 1 ? { link: '<https://api.github.com/repos/o/r/actions/runs?page=2&per_page=100>; rel="next"' } : {};
        return json({ total_count: 150, workflow_runs: runs }, 200, headers);
      }
      return json({ total_count: 0, jobs: [] });
    });
    const ds = await fetchDataset("o/r", { ...base, days: 3 });
    assert.equal(ds.runs.length, 150);
  });

  it("bisects the date window when total_count > 1000", async () => {
    // 2500 runs spread over 3 days; the fake API honors the created range and caps at 1000.
    const start = Date.parse("2026-11-16T12:00:00Z");
    const all = Array.from({ length: 2500 }, (_, i) =>
      ghRun(i + 1, new Date(start + Math.floor((i * 3 * 86_400_000) / 2500)).toISOString().replace(".000", "")),
    );
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        const [from, to] = url.searchParams.get("created")!.split("..").map((s) => Date.parse(s));
        const inRange = all
          .filter((r) => {
            const t = Date.parse(r.created_at);
            return t >= from && t <= to;
          })
          .reverse(); // newest first like GitHub
        const page = Number(url.searchParams.get("page") ?? "1");
        const capped = inRange.slice(0, 1000);
        const slice = capped.slice((page - 1) * 100, page * 100);
        const headers: Record<string, string> = {};
        if (page * 100 < capped.length) {
          const next = new URL(url);
          next.searchParams.set("page", String(page + 1));
          headers.link = `<${next}>; rel="next"`;
        }
        return json({ total_count: inRange.length, workflow_runs: slice }, 200, headers);
      }
      return json({ total_count: 0, jobs: [] });
    });
    const ds = await fetchDataset("o/r", { ...base, days: 3, maxRuns: 10_000 });
    assert.equal(ds.runs.length, 2500);
    assert.equal(new Set(ds.runs.map((r) => r.id)).size, 2500);
    // newest first
    assert.ok(ds.runs[0].createdAt >= ds.runs[ds.runs.length - 1].createdAt);
  });

  it("respects maxRuns keeping the newest", async () => {
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        const runs = Array.from({ length: 100 }, (_, i) => ghRun(100 - i, `2026-11-18T10:${String(59 - (i % 60)).padStart(2, "0")}:00Z`));
        return json({ total_count: 100, workflow_runs: runs });
      }
      return json({ total_count: 0, jobs: [] });
    });
    const ds = await fetchDataset("o/r", { ...base, days: 3, maxRuns: 10 });
    assert.equal(ds.runs.length, 10);
    const jobCalls = calls.filter((c) => c.pathname.endsWith("/jobs"));
    assert.equal(jobCalls.length, 10);
  });

  it("uses the workflow endpoint when workflow is given", async () => {
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/workflows/ci.yml/runs") return json({ total_count: 0, workflow_runs: [] });
      throw new Error("unexpected " + url);
    });
    const ds = await fetchDataset("o/r", { ...base, days: 3, workflow: ".github/workflows/ci.yml" });
    assert.equal(ds.runs.length, 0);
  });

  it("turns a 404 into a clear repo error", async () => {
    mockFetch(() => json({ message: "Not Found" }, 404));
    await assert.rejects(fetchDataset("o/missing", { ...base, days: 3 }), /Repository o\/missing not found/);
  });

  it("retries after a rate limit during listing", async () => {
    let first = true;
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        if (first) {
          first = false;
          return json({ message: "rate limit" }, 429, { "retry-after": "1" });
        }
        return json({ total_count: 1, workflow_runs: [ghRun(1, "2026-11-18T10:00:00Z")] });
      }
      return json({ total_count: 1, jobs: [ghJob(5, 1, 1)] });
    });
    const msgs: string[] = [];
    const ds = await fetchDataset("o/r", { ...base, days: 3, onProgress: (m) => msgs.push(m) });
    assert.equal(ds.runs.length, 1);
    assert.ok(msgs.some((m) => /rate limited/.test(m)));
    assert.ok(msgs.includes("runs: 1 found"));
    assert.ok(msgs.includes("jobs: 1/1"));
  });

  it("disk cache avoids refetching jobs of known run attempts", async () => {
    let attempt = 1;
    mockFetch((url) => {
      if (url.pathname === "/repos/o/r/actions/runs") {
        return json({
          total_count: 2,
          workflow_runs: [ghRun(1, "2026-11-18T10:00:00Z"), ghRun(2, "2026-11-18T11:00:00Z", { run_attempt: attempt })],
        });
      }
      const runId = Number(url.pathname.split("/")[6]);
      return json({ total_count: 1, jobs: [ghJob(runId * 10, runId, 1)] });
    });
    const opts = { ...base, days: 3, cacheDir: tmp };
    const first = await fetchDataset("o/r", opts);
    assert.equal(calls.filter((c) => c.pathname.endsWith("/jobs")).length, 2);
    assert.deepEqual(readdirSync(join(tmp, "o__r")).sort(), ["1-1.json", "2-1.json"]);

    calls = [];
    const second = await fetchDataset("o/r", opts);
    assert.equal(calls.filter((c) => c.pathname.endsWith("/jobs")).length, 0);
    assert.deepEqual(second.runs, first.runs);

    // A re-run creates a new attempt -> only that run is refetched.
    attempt = 2;
    calls = [];
    await fetchDataset("o/r", opts);
    const jobCalls = calls.filter((c) => c.pathname.endsWith("/jobs"));
    assert.equal(jobCalls.length, 1);
    assert.equal(jobCalls[0].pathname, "/repos/o/r/actions/runs/2/jobs");
  });

  it("rejects malformed repo names", async () => {
    await assert.rejects(fetchDataset("not-a-repo", { ...base, days: 1 }), /expected owner\/name/);
  });
});

describe("saveDataset / loadDataset", () => {
  it("round-trips", () => {
    const ds = { repo: "o/r", since: "a", until: "b", fetchedAt: "c", runs: [] };
    const file = join(tmp, "sub", "ds.json");
    saveDataset(ds, file);
    assert.deepEqual(loadDataset(file), ds);
  });

  it("rejects non-datasets", () => {
    const file = join(tmp, "bad.json");
    saveDataset({ foo: 1 } as never, file);
    assert.throws(() => loadDataset(file), /not a ciburn dataset/);
  });
});
