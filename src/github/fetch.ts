// Fetches workflow runs + jobs (all attempts) for a repo and normalizes them into a Dataset.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Dataset, Job, Run, Step } from "../types.ts";
import { GitHubError, buildUrl, paginate, parseNextLink, pMap, request } from "./client.ts";
import type { ClientOptions } from "./client.ts";

export interface FetchOptions {
  days: number;
  token: string | null;
  /** Workflow file name (ci.yml), path (.github/workflows/ci.yml) or numeric id. */
  workflow?: string;
  /** Newest runs kept; default 3000. */
  maxRuns?: number;
  /** Cache root dir; undefined = ".ciburn-cache", null = no cache. Repo subfolder is appended. */
  cacheDir?: string | null;
  onProgress?: (msg: string) => void;
  /** Parallel job requests; default 8. */
  concurrency?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

// ---- Raw GitHub API shapes (only the fields we use) ----

interface GhRun {
  id: number;
  name: string | null;
  workflow_id: number;
  path?: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  run_attempt?: number;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  html_url: string;
}

interface GhRunsPage {
  total_count: number;
  workflow_runs: GhRun[];
}

interface GhStep {
  name: string;
  number: number;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GhJob {
  id: number;
  run_id: number;
  run_attempt?: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at?: string;
  started_at: string | null;
  completed_at: string | null;
  labels?: string[];
  runner_name?: string | null;
  steps?: GhStep[];
}

interface GhJobsPage {
  total_count: number;
  jobs: GhJob[];
}

// GitHub returns at most 1000 results per runs query, regardless of pagination.
const LIST_CAP = 1000;
const MIN_SPLIT_MS = 60_000;

// ---- Mapping ----

export function mapJob(j: GhJob): Job {
  return {
    id: j.id,
    runId: j.run_id,
    runAttempt: j.run_attempt ?? 1,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? null,
    createdAt: j.created_at ?? j.started_at ?? "",
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
    labels: j.labels ?? [],
    runnerName: j.runner_name ?? null,
    steps: (j.steps ?? []).map(
      (s): Step => ({
        name: s.name,
        number: s.number,
        conclusion: s.conclusion ?? null,
        startedAt: s.started_at ?? null,
        completedAt: s.completed_at ?? null,
      }),
    ),
  };
}

export function mapRun(r: GhRun, jobs: Job[]): Run {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.name ?? "",
    // `path` may carry a ref suffix for reusable/dynamic workflows: ".github/workflows/ci.yml@refs/heads/main"
    workflowPath: (r.path ?? "").replace(/@.*$/, ""),
    event: r.event,
    headBranch: r.head_branch ?? null,
    headSha: r.head_sha,
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    runAttempt: r.run_attempt ?? 1,
    createdAt: r.created_at,
    runStartedAt: r.run_started_at ?? null,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    jobs,
  };
}

// ---- Run listing with window splitting ----

/** GitHub date qualifier: second precision, UTC, no millis. */
function isoSec(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runsPath(repo: string, workflow?: string): string {
  if (!workflow) return `/repos/${repo}/actions/runs`;
  // Accept ".github/workflows/ci.yml" as well as "ci.yml" or an id.
  const id = workflow.replace(/^.*\//, "");
  return `/repos/${repo}/actions/workflows/${encodeURIComponent(id)}/runs`;
}

/**
 * List completed runs created in [fromMs, toMs] (inclusive, second precision), newest first.
 * When a range holds more than GitHub's 1000-result cap, it is bisected; the newer half is
 * fetched first so `limit` keeps the newest runs.
 */
async function listRuns(
  path: string,
  fromMs: number,
  toMs: number,
  limit: number,
  client: ClientOptions,
  out: Map<number, GhRun>,
  onCount: () => void,
): Promise<void> {
  if (out.size >= limit) return;
  const params = { created: `${isoSec(fromMs)}..${isoSec(toMs)}`, status: "completed", per_page: 100 };
  const first = await request<GhRunsPage>(buildUrl(path, params), client);
  const total = first.data.total_count;

  if (total > LIST_CAP && toMs - fromMs > MIN_SPLIT_MS) {
    // Split on whole seconds so the halves don't overlap: [from, mid] and [mid+1s, to].
    const mid = Math.floor((fromMs + (toMs - fromMs) / 2) / 1000) * 1000;
    await listRuns(path, mid + 1000, toMs, limit, client, out, onCount);
    await listRuns(path, fromMs, mid, limit, client, out, onCount);
    return;
  }
  if (total > LIST_CAP) {
    client.onWarn?.(`more than ${LIST_CAP} runs within one minute; some runs are skipped`);
  }

  const add = (runs: GhRun[]) => {
    for (const r of runs) if (r.status === "completed" && out.size < limit) out.set(r.id, r);
    onCount();
  };
  add(first.data.workflow_runs);
  let next = parseNextLink(first.headers.get("link"));
  while (next && out.size < limit) {
    const page = await request<GhRunsPage>(next, client);
    add(page.data.workflow_runs);
    next = parseNextLink(page.headers.get("link"));
  }
}

// ---- Cache ----

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function repoCacheDir(repo: string, cacheRoot: string): string {
  return join(cacheRoot, repo.replace("/", "__"));
}

// ---- Main entry ----

export async function fetchDataset(repo: string, opts: FetchOptions): Promise<Dataset> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo "${repo}", expected owner/name`);
  }
  const progress = opts.onProgress ?? (() => {});
  const client: ClientOptions = { token: opts.token, onWarn: progress, sleep: opts.sleep };
  const maxRuns = opts.maxRuns ?? 3000;
  const now = opts.now ?? new Date();
  const untilMs = Math.floor(now.getTime() / 1000) * 1000;
  const sinceMs = untilMs - opts.days * 86_400_000;
  const cacheDir = opts.cacheDir === null ? null : repoCacheDir(repo, opts.cacheDir ?? ".ciburn-cache");

  if (!opts.token) progress("no GitHub token found: unauthenticated limit is 60 requests/hour");

  // 1. Runs
  const found = new Map<number, GhRun>();
  try {
    await listRuns(runsPath(repo, opts.workflow), sinceMs, untilMs, maxRuns, client, found, () =>
      progress(`runs: ${found.size} found`),
    );
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      const what = opts.workflow ? `Repository ${repo} or workflow "${opts.workflow}"` : `Repository ${repo}`;
      throw new GitHubError(`${what} not found, or the token has no access to it.`, 404, err.path);
    }
    throw err;
  }
  const ghRuns = [...found.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, maxRuns);
  progress(`runs: ${ghRuns.length} found`);

  // 2. Jobs (all attempts), cached per run id + latest attempt
  let done = 0;
  let cached = 0;
  const step = Math.max(1, Math.ceil(ghRuns.length / 20));
  const runs = await pMap(ghRuns, opts.concurrency ?? 8, async (r) => {
    const attempt = r.run_attempt ?? 1;
    const file = cacheDir ? join(cacheDir, `${r.id}-${attempt}.json`) : null;
    let jobs = file ? readJson<Job[]>(file) : null;
    if (jobs) {
      cached++;
    } else {
      try {
        const raw = await paginate<GhJobsPage, GhJob>(
          `/repos/${repo}/actions/runs/${r.id}/jobs`,
          { filter: "all", per_page: 100 },
          client,
          (p) => p.jobs,
        );
        jobs = raw.map(mapJob);
        // Only cache when every job is final; a completed run should always satisfy this.
        if (file && jobs.every((j) => j.status === "completed")) writeJsonAtomic(file, jobs);
      } catch (err) {
        // A run deleted between listing and fetching jobs: keep the run, without jobs.
        if (err instanceof GitHubError && err.status === 404) {
          progress(`jobs for run ${r.id} not found, skipping`);
          jobs = [];
        } else {
          throw err;
        }
      }
    }
    done++;
    if (done % step === 0 || done === ghRuns.length) progress(`jobs: ${done}/${ghRuns.length}`);
    return mapRun(r, jobs);
  });
  if (cacheDir && cached > 0) progress(`jobs: ${cached}/${ghRuns.length} from cache`);

  // When maxRuns cut the listing, the data only covers the newest slice of the window.
  // Shrink `since` to the oldest fetched run so monthly normalization stays correct.
  const truncated = ghRuns.length >= maxRuns && ghRuns.length > 0;
  const effectiveSinceMs = truncated ? Date.parse(ghRuns[ghRuns.length - 1]!.created_at) : sinceMs;

  return {
    repo,
    since: new Date(effectiveSinceMs).toISOString(),
    ...(truncated && { truncated: true }),
    until: new Date(untilMs).toISOString(),
    fetchedAt: new Date().toISOString(),
    runs,
  };
}

// ---- Offline mode ----

export function saveDataset(ds: Dataset, file: string): void {
  writeJsonAtomic(file, ds);
}

export function loadDataset(file: string): Dataset {
  let ds: Dataset;
  try {
    ds = JSON.parse(readFileSync(file, "utf8")) as Dataset;
  } catch (err) {
    throw new Error(`Cannot read dataset ${file}: ${(err as Error).message}`);
  }
  if (!ds || typeof ds.repo !== "string" || !Array.isArray(ds.runs)) {
    throw new Error(`${file} is not a ciburn dataset (missing repo/runs)`);
  }
  return ds;
}
