import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildShotPrompt, findApprovedHero, SHOT_SET } from "../src/assetResolver.js";
import { loadBriefFile } from "../src/pipeline.js";
import { selectGenerator } from "../src/providers/index.js";
import { preflight, preflightOrThrow } from "../src/validation.js";

/**
 * Covers one product from several camera set-ups, the way a shoot does.
 *
 *   npm run shots -- samples/campaign.yaml radiance-serum
 *   npm run shots -- samples/campaign.yaml radiance-serum --prompts   (spends nothing)
 *
 * Separate from the campaign path on purpose. A campaign generates ONE hero and
 * crops it to every format, because the crop is free and the generation is not;
 * that is the cost argument the whole pipeline rests on and this does not touch
 * it. Coverage is what that argument gives up, and this is what buying it back
 * costs: one paid generation per set-up, run only when a human asks.
 *
 * The reference image is THE HERO, not the packshot. That is the difference
 * between this and the version that did not work: the model is looking at the
 * finished scene and being asked to move the camera within it, so the set, the
 * light and the grade come from the image rather than from a paragraph trying
 * to re-specify them.
 */
const args = process.argv.slice(2);
const dryRun = args.includes("--prompts");
const [file = "samples/campaign.yaml", productId] = args.filter((a) => !a.startsWith("--"));

const brief = await loadBriefFile(path.resolve(file));
const product = productId
  ? brief.products.find((p) => p.id === productId)
  : brief.products.find((p) => p.approvedHeroPath);

if (!product) {
  console.error(`No such product. Available: ${brief.products.map((p) => p.id).join(", ")}`);
  process.exit(2);
}

// The scene to move the camera within. Without one there is nothing to vary,
// and inventing it here would just be the campaign path with extra steps.
const reference = await findApprovedHero(product.approvedHeroPath);
if (!reference) {
  console.error(
    `${product.id} has no approved hero on disk. Run the campaign first, then point this at\n` +
      "the generated hero, or use a product whose approvedHeroPath resolves.",
  );
  process.exit(2);
}

if (dryRun) {
  console.log(`\nSHOT PROMPTS  ${product.name}  ·  nothing will be generated\n`);
  for (const shot of SHOT_SET) {
    console.log(`── ${shot.label} ${"─".repeat(Math.max(0, 56 - shot.label.length))}`);
    console.log(`${buildShotPrompt(shot)}\n`);
  }
  process.exit(0);
}

// Same gate the campaign path uses. A shoot spends real money per set-up, so a
// brief carrying a prohibited claim must be refused here too: the argument of
// this project is that nothing is paid for before the free checks have run, and
// a side entrance that skips them is not a side entrance, it is a hole.
preflightOrThrow(await preflight(brief));

const generator = selectGenerator(process.env);
const outDir = path.resolve("outputs", "shot-variants", product.id);
await mkdir(outDir, { recursive: true });

console.log(`\nSHOOT  ${product.name}  ·  ${SHOT_SET.length} set-ups  ·  ${generator.model}`);
console.log(`  Reference: ${path.relative(process.cwd(), reference)}`);
console.log(`  Each set-up is one paid generation. ${SHOT_SET.length} will be made.\n`);

for (const shot of SHOT_SET) {
  const startedAt = Date.now();
  try {
    const hero = await generator.generateHero({
      productId: product.id,
      productName: product.name,
      campaignMessage: brief.message,
      region: brief.region,
      audience: brief.audience,
      brandName: brief.brand.name,
      prompt: buildShotPrompt(shot),
      referenceAssetPath: reference,
    });
    const out = path.join(outDir, `${shot.id}.png`);
    await writeFile(out, hero.bytes);
    console.log(
      `  ✓ ${shot.label.padEnd(20)} ${((Date.now() - startedAt) / 1000).toFixed(1)}s  ${path.relative(process.cwd(), out)}`,
    );
  } catch (error) {
    // One refused set-up must not lose the rest of the shoot.
    console.log(
      `  ✗ ${shot.label.padEnd(20)} ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

console.log(`\n  Contact sheet → ${path.relative(process.cwd(), outDir)}/\n`);
