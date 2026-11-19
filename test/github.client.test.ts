import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitHubError, ghGet, paginate, parseNextLink, pMap, resolveToken } from "../src/github/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const noSleep = async () => {};

describe("client", () => {
  it("sends GitHub headers and auth, builds query params", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return json({ ok: 1 });
    }) as typeof fetch;
    const data = await ghGet<{ ok: number }>("/repos/a/b", { per_page: 100, x: undefined }, { token: "t0k" });
    assert.deepEqual(data, { ok: 1 });
    assert.equal(seen!.url, "https://api.github.com/repos/a/b?per_page=100");
    assert.equal(seen!.headers.Accept, "application/vnd.github+json");
    assert.equal(seen!.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(seen!.headers["User-Agent"], "ciburn");
    assert.equal(seen!.headers.Authorization, "Bearer t0k");
  });

  it("honors GITHUB_API_URL for GHES", async () => {
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://ghe.example.com/api/v3/";
    let url = "";
    globalThis.fetch = (async (u: string) => {
      url = u;
      return json({});
    }) as typeof fetch;
    try {
      await ghGet("/repos/a/b", {}, { token: null });
      assert.equal(url, "https://ghe.example.com/api/v3/repos/a/b");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = prev;
    }
  });

  it("parses Link next", () => {
    const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    assert.equal(parseNextLink(link), "https://api.github.com/x?page=2");
    assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
    assert.equal(parseNextLink(null), null);
  });

  it("paginates via Link header", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const headers: Record<string, string> =
        page < 3 ? { link: `<https://api.github.com/items?page=${page + 1}>; rel="next"` } : {};
      return json({ items: [page * 10, page * 10 + 1] }, 200, headers);
    }) as typeof fetch;
    const items = await paginate<{ items: number[] }, number>("/items", {}, { token: null }, (p) => p.items);
    assert.deepEqual(items, [10, 11, 20, 21, 30, 31]);
    assert.equal(calls.length, 3);
  });

  it("waits on primary rate limit (x-ratelimit-remaining: 0) and retries", async () => {
    let n = 0;
    const waits: number[] = [];
    const warns: string[] = [];
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) {
        const reset = Math.floor(Date.now() / 1000) + 30;
        return json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;
    const data = await ghGet("/x", {}, {
      token: "t",
      sleep: async (ms) => void waits.push(ms),
      onWarn: (m) => warns.push(m),
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(n, 2);
    assert.ok(waits[0] > 25_000 && waits[0] <= 32_000, `wait ${waits[0]}`);
    assert.match(warns[0], /rate limited/);
  });

  it("honors retry-after on 429", async () => {
    let n = 0;
    const waits: number[] = [];
    globalThis.fetch = (async () => (++n === 1 ? json({}, 429, { "retry-after": "7" }) : json({ ok: 1 }))) as typeof fetch;
    await ghGet("/x", {}, { token: "t", sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(waits, [7000]);
  });

  it("gives up when rate-limit wait exceeds the cap", async () => {
    globalThis.fetch = (async () =>
      json({}, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      })) as typeof fetch;
    await assert.rejects(ghGet("/x", {}, { token: "t", sleep: noSleep, maxWaitMs: 60_000 }), /rate limit exhausted/);
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    globalThis.fetch = (async () => (++n < 3 ? json({}, 502) : json({ ok: 1 }))) as typeof fetch;
    await ghGet("/x", {}, { token: "t", sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("fails after 3 attempts of 5xx", async () => {
    let n = 0;
    globalThis.fetch = (async () => (n++, json({}, 503))) as typeof fetch;
    await assert.rejects(ghGet("/x", {}, { token: "t", sleep: noSleep }), /503.*after 3 attempts/);
    assert.equal(n, 3);
  });

  it("clear errors for 401 and 404", async () => {
    globalThis.fetch = (async () => json({ message: "Bad credentials" }, 401)) as typeof fetch;
    await assert.rejects(ghGet("/x", {}, { token: "bad" }), (e: unknown) => e instanceof GitHubError && e.status === 401 && /invalid or expired/.test(e.message));
    globalThis.fetch = (async () => json({ message: "Not Found" }, 404)) as typeof fetch;
    await assert.rejects(ghGet("/repos/a/b", {}, { token: "t" }), (e: unknown) => e instanceof GitHubError && e.status === 404);
  });

  it("error messages never contain the token", async () => {
    globalThis.fetch = (async () => json({}, 401)) as typeof fetch;
    await assert.rejects(ghGet("/x", {}, { token: "SECRET123" }), (e: Error) => !e.message.includes("SECRET123"));
  });

  it("pMap limits concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await pMap([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    assert.equal(peak, 3);
  });

  it("resolveToken prefers GITHUB_TOKEN then GH_TOKEN", () => {
    const a = process.env.GITHUB_TOKEN;
    const b = process.env.GH_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "one";
      process.env.GH_TOKEN = "two";
      assert.equal(resolveToken(), "one");
      delete process.env.GITHUB_TOKEN;
      assert.equal(resolveToken(), "two");
    } finally {
      if (a === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = a;
      if (b === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = b;
    }
  });
});
