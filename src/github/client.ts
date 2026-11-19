// Minimal GitHub REST client: auth, pagination, rate limiting, retries, concurrency.
// Zero dependencies: uses global fetch and node built-ins only.

import { execFileSync } from "node:child_process";

export interface ClientOptions {
  token: string | null;
  /** Warnings / waiting notices (rate limit, retries). Never receives secrets. */
  onWarn?: (msg: string) => void;
  /** Longest single rate-limit wait we accept before giving up. Default 15 min. */
  maxWaitMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class GitHubError extends Error {
  status: number;
  path: string;
  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
  }
}

const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const SERVER_RETRIES = 3; // total attempts for 5xx / network errors
const RATE_LIMIT_RETRIES = 5;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Token lookup order: GITHUB_TOKEN, GH_TOKEN, then `gh auth token`. */
export function resolveToken(): string | null {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (env) return env;
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function apiBaseUrl(): string {
  return (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

export type Params = Record<string, string | number | boolean | undefined>;

/** Build an absolute URL from a path (or pass through an absolute URL, e.g. a Link "next"). */
export function buildUrl(path: string, params: Params = {}): string {
  const url = new URL(/^https?:\/\//.test(path) ? path : apiBaseUrl() + (path.startsWith("/") ? path : "/" + path));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Extract rel="next" from a Link header. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

/** Path without query string, for error messages (query may be long but is never secret). */
function shortPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** How long to wait for a rate-limited response, or null if it is not a rate limit. */
function rateLimitWaitMs(res: Response): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter) * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 1000;
    return 60_000;
  }
  // 429 without hints: secondary limit, GitHub recommends waiting at least a minute.
  if (res.status === 429) return 60_000;
  return null;
}

export interface RawResponse<T> {
  data: T;
  headers: Headers;
}

/** Single GET with rate-limit waits and 5xx/network retries. */
export async function request<T>(url: string, opts: ClientOptions): Promise<RawResponse<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ciburn",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const path = shortPath(url);

  let serverFailures = 0;
  let rateLimitHits = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      serverFailures++;
      if (serverFailures >= SERVER_RETRIES) {
        throw new GitHubError(`Network error for ${path}: ${(err as Error).message}`, 0, path);
      }
      const backoff = 1000 * 2 ** (serverFailures - 1);
      opts.onWarn?.(`network error on ${path}, retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }

    if (res.ok) {
      return { data: (await res.json()) as T, headers: res.headers };
    }

    const wait = rateLimitWaitMs(res);
    if (wait !== null) {
      await res.body?.cancel();
      rateLimitHits++;
      if (rateLimitHits > RATE_LIMIT_RETRIES) {
        throw new GitHubError(`Rate limited on ${path} after ${RATE_LIMIT_RETRIES} retries`, res.status, path);
      }
      if (wait > maxWait) {
        const mins = Math.ceil(wait / 60_000);
        throw new GitHubError(
          `GitHub rate limit exhausted; reset in ~${mins} min (exceeds max wait). ` +
            (opts.token ? "Try again later or reduce --days." : "Set GITHUB_TOKEN for a 5000 req/h limit."),
          res.status,
          path,
        );
      }
      opts.onWarn?.(`rate limited, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }

    if (res.status >= 500) {
      await res.body?.cancel();
      serverFailures++;
      if (serverFailures >= SERVER_RETRIES) {
        throw new GitHubError(`GitHub API ${res.status} for ${path} after ${SERVER_RETRIES} attempts`, res.status, path);
      }
      const backoff = 1000 * 2 ** (serverFailures - 1);
      opts.onWarn?.(`GitHub API ${res.status} on ${path}, retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }

    let apiMessage = "";
    try {
      apiMessage = ((await res.json()) as { message?: string }).message ?? "";
    } catch {
      // body not JSON; ignore
    }
    if (res.status === 401) {
      throw new GitHubError("GitHub token is invalid or expired (401). Check GITHUB_TOKEN / `gh auth status`.", 401, path);
    }
    if (res.status === 404) {
      throw new GitHubError(`Not found (404): ${path}. The repo may not exist or the token has no access.`, 404, path);
    }
    if (res.status === 403 && /rate limit/i.test(apiMessage) && rateLimitHits < RATE_LIMIT_RETRIES) {
      // Secondary rate limit without headers: back off a minute.
      rateLimitHits++;
      opts.onWarn?.("secondary rate limit hit, waiting 60s");
      await sleep(60_000);
      continue;
    }
    if (res.status === 403) {
      throw new GitHubError(`Forbidden (403) for ${path}: ${apiMessage || "insufficient permissions"}`, 403, path);
    }
    throw new GitHubError(`GitHub API ${res.status} for ${path}${apiMessage ? `: ${apiMessage}` : ""}`, res.status, path);
  }
}

/** GET a path (relative to the API base) and return parsed JSON. */
export async function ghGet<T>(path: string, params: Params, opts: ClientOptions): Promise<T> {
  return (await request<T>(buildUrl(path, params), opts)).data;
}

/**
 * Follow Link rel="next" pages. `pick` extracts the items of one page
 * (e.g. `(p) => p.workflow_runs`). `onPage` sees each raw page (e.g. for total_count).
 * Stops early once `limit` items were collected.
 */
export async function paginate<P, T>(
  path: string,
  params: Params,
  opts: ClientOptions,
  pick: (page: P) => T[],
  limit = Infinity,
  onPage?: (page: P) => void,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = buildUrl(path, params);
  while (url && out.length < limit) {
    const res: RawResponse<P> = await request<P>(url, opts);
    onPage?.(res.data);
    out.push(...pick(res.data));
    url = parseNextLink(res.headers.get("link"));
  }
  return out;
}

/** Map with bounded concurrency; preserves input order. Rejects on first error. */
export async function pMap<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
