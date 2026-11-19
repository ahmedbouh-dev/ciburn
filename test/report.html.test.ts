import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, fixToHtml, renderHtml, safeHref } from "../src/report/html.ts";
import { sampleReport } from "./fixtures/sample-report.ts";
import type { Report } from "../src/types.ts";

const XSS = `"><script>alert(1)</script><img src=x onerror='alert(2)'>`;

test("esc neutralizes an XSS payload", () => {
  const out = esc(XSS);
  assert.equal(out, "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&#39;alert(2)&#39;&gt;");
  assert.doesNotMatch(out, /[<>"']/);
});

test("safeHref allows only http(s)", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref('https://x.y/"onmouseover=1'), null);
  assert.equal(safeHref("https://github.com/a/b/actions/runs/1"), "https://github.com/a/b/actions/runs/1");
});

test("fixToHtml renders fences and inline code, escaped", () => {
  const html = fixToHtml("Use `a<b>`:\n\n```yaml\nx: <y>\n```");
  assert.ok(html.includes("<code>a&lt;b&gt;</code>"));
  assert.ok(html.includes("<pre><code>x: &lt;y&gt;</code></pre>"));
  assert.ok(html.includes('class="copy"'));
});

test("untrusted report data is escaped everywhere", () => {
  const evil: Report = {
    ...sampleReport,
    repo: XSS,
    workflows: [{ ...sampleReport.workflows[0]!, workflowName: XSS, workflowPath: XSS }],
    jobs: [{ ...sampleReport.jobs[0]!, jobName: XSS, workflowName: XSS }],
    slowSteps: [{ ...sampleReport.slowSteps[0]!, stepName: XSS }],
    flaky: [{ ...sampleReport.flaky[0]!, jobName: XSS, examples: ["javascript:alert(3)"] }],
    findings: [{ ...sampleReport.findings[0]!, title: XSS, detail: XSS, fix: `${XSS}\n\n\`\`\`\n${XSS}\n\`\`\``, evidence: ["javascript:alert(4)"] }],
  };
  const html = renderHtml(evil);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("javascript:alert"));
  // Exactly one real <script> (our own inline JS).
  assert.equal(html.match(/<script>/g)?.length, 1);
});

test("self-contained: no external resource loads, only evidence links", () => {
  const html = renderHtml(sampleReport);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /\bsrc\s*=\s*["']?https?:/i);
  // Every http(s) occurrence must be an <a href> evidence link.
  const allHttp = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const hrefs = [...html.matchAll(/<a href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0);
  for (const u of allHttp) assert.ok(hrefs.includes(u), `non-link URL: ${u}`);
});

test("contains all sections and key numbers", () => {
  const html = renderHtml(sampleReport);
  for (const s of ["Monthly CI spend", "$1,792", "26%", "$513", "71.4", "Cost by runner", "Top fixes",
    "Workflows by cost", 'class="sortable"', "Flaky jobs", "Slowest steps", "list-price equivalent",
    "prefers-color-scheme:dark", "cancel-in-progress"]) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
});

test("dev time KPI, per-finding hours, footer note; bold in fix", () => {
  const html = renderHtml(sampleReport);
  assert.ok(html.includes("Dev time saved"));
  assert.ok(html.includes("14h<small>/mo</small>"));
  assert.ok(html.includes('class="save only-hours"'));
  assert.ok(html.includes("dev time/mo"));
  assert.ok(html.includes("only to rank findings"));
  assert.ok(!html.includes("saves dev time"));
  assert.ok(fixToHtml("Use **Re-run failed jobs** and `a**b**`").includes("<strong>Re-run failed jobs</strong>"));
  assert.ok(fixToHtml("`a**b**`").includes("<code>a**b**</code>"));
});

test("long lists collapse behind a toggle", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...sampleReport.jobs[0]!, jobName: `job ${i}` }));
  const html = renderHtml({ ...sampleReport, jobs: many });
  assert.equal(html.match(/<tr class="extra">/g)?.length, 8);
  assert.ok(html.includes("Show 8 more jobs"));
});
