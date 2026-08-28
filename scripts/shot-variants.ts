import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHeroPrompt, SHOT_SET } from "../src/assetResolver.js";
import { loadBriefFile } from "../src/pipeline.js";
import { selectGenerator } from "../src/providers/index.js";
import { preflight, preflightOrThrow } from "../src/validation.js";

/**
 * Covers one product from several camera set-ups, the way a shoot does.
 *
 *   npm run shots -- samples/campaign.yaml overnight-recovery-cream
 *
 * Separate from the campaign path on purpose. A campaign generates ONE hero and
 * crops it to every format, because the crop is free and the generation is not;
 * that is the cost argument the whole pipeline rests on and this does not touch
 * it. Coverage is the thing that argument gives up, and this is what buying it
 * back costs: one paid generation per set-up, run only when a human asks.
 *
 * The identity anchor, the campaign set, the light and the quality bar all stay
 * fixed. Only the camera moves, which is why the results read as one session
 * rather than four unrelated pictures.
 */
const [file = "samples/campaign.yaml", productId] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));

const brief = await loadBriefFile(path.resolve(file));
const product = productId
  ? brief.products.find((p) => p.id === productId)
  : brief.products.find((p) => !p.approvedHeroPath);

if (!product) {
  console.error(`No product to shoot. Available: ${brief.products.map((p) => p.id).join(", ")}`);
  process.exit(1);
}

// Same gate the campaign path uses. A shoot spends real money per set-up,
// so a brief carrying a prohibited claim must be refused here too -- the
// whole argument of this project is that nothing is paid for before the
// free checks have run, and a side entrance that skips them is not a side
// entrance, it is a hole.
preflightOrThrow(await preflight(brief));

const generator = selectGenerator(process.env);
const outDir = path.resolve("outputs", "shot-variants", product.id);
await mkdir(outDir, { recursive: true });

console.log(`\nSHOOT  ${product.name}  ·  ${SHOT_SET.length} set-ups  ·  ${generator.model}`);
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
      prompt: buildHeroPrompt(product, brief, Boolean(product.referenceAssetPath), shot),
      referenceAssetPath: product.referenceAssetPath
        ? path.resolve(product.referenceAssetPath)
        : undefined,
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
