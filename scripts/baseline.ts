import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBriefFile, runCampaign } from "../src/pipeline.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import { visualSignature } from "../src/signature.js";

/**
 * Regenerates the visual baselines.
 *
 *   npm run test:baseline
 *
 * Run this deliberately, after eyeballing the creatives, when a layout change
 * is intended. If the visual regression test fails and you did not mean to
 * change the layout, that is the test doing its job -- do not run this to make
 * it quiet.
 */
// Renders outside the repo: a generated-output directory here would end up
// committed, which is exactly what happened the first time.
const OUT = await mkdtemp(path.join(tmpdir(), "cap-baseline-"));

const report = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
  outputRoot: OUT,
  mode: "final",
  generator: new TestDoubleHeroGenerator(),
});

const signatures: Record<string, number[]> = {};
for (const product of report.products) {
  for (const creative of product.creatives) {
    const key = `${product.productId}/${creative.ratio}/${creative.locale}`;
    signatures[key] = await visualSignature(path.join(OUT, creative.outputPath));
  }
}

await mkdir(path.resolve("tests/baselines"), { recursive: true });
await writeFile(
  path.resolve("tests/baselines/creatives.json"),
  `${JSON.stringify(signatures, null, 2)}\n`,
);
await rm(OUT, { recursive: true, force: true });
console.log(`wrote ${Object.keys(signatures).length} signatures`);
