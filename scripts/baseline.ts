import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBriefFile, runCampaign } from "../src/pipeline.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import { colourSignature, visualSignature } from "../src/signature.js";

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
  // dev, to match tests/visual.test.ts: this captures LAYOUT, so it wants the
  // deterministic offline renderer as its hero. `final` refuses that renderer
  // for a missing asset, which would silently drop product B and halve the
  // baseline set.
  mode: "dev",
  generator: new TestDoubleHeroGenerator(),
});

/**
 * Two signatures per creative, because one of them is blind.
 *
 * `luma` is the 12x12 tone grid, which sees geometry. `rgb` is the mean colour,
 * which is the half that greyscaling threw away -- the reason a 256-colour
 * palette bug once passed all 24 of these.
 */
const signatures: Record<string, { luma: number[]; rgb: number[] }> = {};
for (const product of report.products) {
  for (const creative of product.creatives) {
    const key = `${product.productId}/${creative.ratio}/${creative.locale}`;
    const file = path.join(OUT, creative.outputPath);
    signatures[key] = {
      luma: await visualSignature(file),
      rgb: (await colourSignature(file)).rgb,
    };
  }
}

await mkdir(path.resolve("tests/baselines"), { recursive: true });
await writeFile(
  path.resolve("tests/baselines/creatives.json"),
  `${JSON.stringify(signatures, null, 2)}\n`,
);
await rm(OUT, { recursive: true, force: true });
console.log(`wrote ${Object.keys(signatures).length} signatures`);
