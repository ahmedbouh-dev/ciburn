import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKDOWN_MARKER, renderMarkdown } from "../src/report/markdown.ts";
import { sampleReport } from "./fixtures/sample-report.ts";
import type { Report } from "../src/types.ts";

test("starts with the bot marker", () => {
  const md = renderMarkdown(sampleReport);
  assert.ok(md.startsWith(MARKDOWN_MARKER));
  assert.equal(MARKDOWN_MARKER, "<!-- ciburn-report -->");
});

test("contains summary, findings with details and tables", () => {
  const md = renderMarkdown(sampleReport);
  for (const s of ["| Monthly CI spend |", "**$1,792**", "<details>", "</details>", "```yaml",
    "cancel-in-progress", "### Workflows by cost", "### Flaky jobs", "Slowest steps",
    "[run 1](https://github.com/acme/webapp/actions/runs/9123450100)"]) {
    assert.ok(md.includes(s), `missing: ${s}`);
  }
  assert.equal(md.match(/<details>/g)?.length, md.match(/<\/details>/g)?.length);
});

test("escapes untrusted names in tables and drops unsafe links", () => {
  const evil: Report = {
    ...sampleReport,
    jobs: [{ ...sampleReport.jobs[0]!, jobName: "a|b <img src=x onerror=alert(1)>" }],
    findings: [{ ...sampleReport.findings[0]!, title: "<script>x</script>", evidence: ["javascript:alert(1)"] }],
  };
  const md = renderMarkdown(evil);
  assert.ok(md.includes("a\\|b &lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("javascript:"));
});

test("dev time shown separately from billing $", () => {
  const md = renderMarkdown(sampleReport);
  assert.ok(md.includes("| Dev time saved |") || md.includes("Dev time saved |"));
  assert.ok(md.includes("**14h/mo**"));
  assert.ok(md.includes("saves ~6h dev time/mo</summary>"));
  assert.ok(md.includes("saves ~$281/mo + 2h dev time/mo"));
  assert.ok(md.includes("$100/h only to rank findings"));
  assert.ok(!md.includes("saves developer time"));
});
