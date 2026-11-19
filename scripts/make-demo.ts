// Regenerates examples/demo-dataset.json (used by `ciburn --demo`) from the synthetic fixture.
import { sampleDataset } from "../test/fixtures/build.ts";
import { saveDataset } from "../src/github/fetch.ts";
saveDataset(sampleDataset(), new URL("../examples/demo-dataset.json", import.meta.url).pathname);
