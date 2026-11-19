// Regenerates examples/sample-report.{html,md,txt} from the hand-written fixture.
// Usage: node scripts/render-sample.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderHtml } from "../src/report/html.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { renderTerminal } from "../src/report/terminal.ts";
import { sampleReport } from "../test/fixtures/sample-report.ts";

const outDir = fileURLToPath(new URL("../examples/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}sample-report.html`, renderHtml(sampleReport));
writeFileSync(`${outDir}sample-report.md`, renderMarkdown(sampleReport));
writeFileSync(`${outDir}sample-report.txt`, renderTerminal(sampleReport, { color: false, width: 80 }));
console.log(`wrote sample-report.{html,md,txt} to ${outDir}`);
