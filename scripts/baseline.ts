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

/**
 * Four creatives, not all twenty-four.
 *
 * Between them they cover both products, both hero sources, all four crops,
 * all three locales and both layouts -- the 16:9 is the only one with a brand
 * panel beside the photograph, so it is the only one whose geometry differs in
 * kind. A layout defect shows up in the crop it affects, and every crop is here
 * once, so the other twenty are 3,000 lines of generated numbers that cannot
 * fail independently.
 */
const BASELINE_KEYS = [
  "radiance-serum/1x1/en-GB",
  "radiance-serum/16x9/fr-FR",
  "overnight-recovery-cream/4x5/en-GB",
  "overnight-recovery-cream/9x16/de-DE",
];

// Renders outside the repo. A generated-output directory inside it ends up
// committed.
const OUT = await mkdtemp(path.join(tmpdir(), "cap-baseline-"));

const report = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
  outputRoot: OUT,
  // dev, to match tests/visual.test.ts: this captures LAYOUT, so it wants the
  // deterministic offline renderer as its hero. `final` refuses that renderer
  // for a missing asset, which would silently drop product B.
  mode: "dev",
  generator: new TestDoubleHeroGenerator(),
});

/**
 * Two signatures per creative, because one of them is blind.
 *
 * `luma` is the 12x12 tone grid, which sees geometry. `rgb` is the mean colour,
 * which is the half greyscaling threw away -- the reason a 256-colour palette
 * bug once passed every one of these.
 */
const rows: string[] = [];
for (const product of report.products) {
  for (const creative of product.creatives) {
    const key = `${product.productId}/${creative.ratio}/${creative.locale}`;
    if (!BASELINE_KEYS.includes(key)) continue;
    const file = path.join(OUT, creative.outputPath);
    const luma = await visualSignature(file);
    const { rgb } = await colourSignature(file);
    // One line per creative. Pretty-printing these arrays is what turned four
    // signatures into six hundred lines of diff nobody can read.
    rows.push(
      `  ${JSON.stringify(key)}: { "luma": ${JSON.stringify(luma)}, "rgb": ${JSON.stringify(rgb)} }`,
    );
  }
}

if (rows.length !== BASELINE_KEYS.length) {
  throw new Error(`expected ${BASELINE_KEYS.length} baseline creatives, matched ${rows.length}`);
}

await mkdir(path.resolve("tests/baselines"), { recursive: true });
await writeFile(path.resolve("tests/baselines/creatives.json"), `{\n${rows.join(",\n")}\n}\n`);
await rm(OUT, { recursive: true, force: true });
console.log(`wrote ${rows.length} signatures`);
