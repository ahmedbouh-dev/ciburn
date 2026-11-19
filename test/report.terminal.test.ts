import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTerminal, visibleLength } from "../src/report/terminal.ts";
import { sampleReport } from "./fixtures/sample-report.ts";
import type { Report } from "../src/types.ts";

test("plain render has key figures and no ANSI", () => {
  const out = renderTerminal(sampleReport, { color: false, width: 80 });
  assert.doesNotMatch(out, /\x1b\[/);
  for (const s of ["acme/webapp", "$1,792/mo", "26% wasted", "$513/mo", "TOP FIXES", "$281/mo",
    "cancel-in-progress", "WORKFLOWS BY COST", "FLAKY JOBS", "SLOWEST STEPS", "+2 more (see --html)"]) {
    assert.ok(out.includes(s), `missing: ${s}`);
  }
});

test("color render contains ANSI", () => {
  assert.match(renderTerminal(sampleReport, { color: true }), /\x1b\[1m/);
});

for (const width of [60, 80, 100, 120]) {
  test(`respects width ${width}`, () => {
    for (const color of [false, true]) {
      const lines = renderTerminal(sampleReport, { color, width }).split("\n");
      for (const l of lines) assert.ok(visibleLength(l) <= width, `too long (${visibleLength(l)}): ${l}`);
    }
  });
}

test("stays compact for a typical report", () => {
  const lines = renderTerminal(sampleReport, { color: false }).trimEnd().split("\n");
  assert.ok(lines.length <= 60, `got ${lines.length} lines`);
});

test("handles an empty report", () => {
  const empty: Report = {
    ...sampleReport, workflows: [], jobs: [], slowSteps: [], flaky: [], findings: [],
    totals: { ...sampleReport.totals, cost: { usd: 0, minutes: 0 }, wastedCost: { usd: 0, minutes: 0 } },
  };
  const out = renderTerminal(empty, { color: false });
  assert.ok(out.includes("0% wasted"));
  assert.ok(!out.includes("TOP FIXES"));
});

test("dev time: separate headline figure, per-finding hours, never in $", () => {
  const out = renderTerminal(sampleReport, { color: false, width: 80 });
  assert.ok(out.includes("$513/mo"), "billing savings only");
  assert.ok(out.includes("14h/mo") && out.includes("dev time saved"));
  assert.ok(/Self-hosted GPU runner.*6h dev$/m.test(out), "hours-only finding");
  assert.ok(/\$281\/mo · 2h dev$/m.test(out), "both");
  assert.ok(!out.includes("saves dev time"));
  assert.ok(out.includes("valued at $100/h for ranking only"));
  const noDev = renderTerminal({ ...sampleReport, findings: sampleReport.findings.map((f) => ({ ...f, devHoursSaved: 0 })) }, { color: false });
  assert.ok(!noDev.includes("dev time saved"));
});

test("long code snippets are capped with an ellipsis", () => {
  const code = Array.from({ length: 20 }, (_, i) => `line${i}: x`).join("\n");
  const f = { ...sampleReport.findings[0]!, fix: "Do this:\n\n```yaml\n" + code + "\n```" };
  const out = renderTerminal({ ...sampleReport, findings: [f] }, { color: false });
  assert.ok(out.includes("line4: x"));
  assert.ok(!out.includes("line5: x"));
  assert.ok(out.includes("… (+15 lines"));
});

test("workflow names use available width", () => {
  const wf = { ...sampleReport.workflows[0]!, workflowName: "Semantic Pull Request" };
  const out = renderTerminal({ ...sampleReport, workflows: [wf] }, { color: false, width: 80 });
  assert.ok(out.includes("Semantic Pull Request "));
});
