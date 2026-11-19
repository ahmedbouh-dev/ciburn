import { test } from "node:test";
import assert from "node:assert/strict";
import { renderJson } from "../src/report/json.ts";
import { sampleReport } from "./fixtures/sample-report.ts";

test("pretty, parseable and stable", () => {
  const a = renderJson(sampleReport);
  const shuffled = Object.fromEntries(Object.entries(sampleReport).reverse()) as typeof sampleReport;
  assert.equal(a, renderJson(shuffled));
  const parsed = JSON.parse(a);
  assert.equal(parsed.repo, "acme/webapp");
  assert.equal(parsed.schema, "ciburn/report@1");
  assert.ok(a.includes('\n  "days": 14'));
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort());
});
