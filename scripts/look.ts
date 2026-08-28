import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOOKS, resolveArtDirection } from "../src/artDirection.js";
import { buildHeroPrompt, findApprovedHero } from "../src/assetResolver.js";
import { loadBriefFile } from "../src/pipeline.js";
import { PREVIEW_MODEL } from "../src/pricing.js";
import { selectGenerator } from "../src/providers/index.js";
import { preflight, preflightOrThrow } from "../src/validation.js";

/**
 * ONE hero, at the cheapest price the catalogue allows.
 *
 *   npm run look -- samples/campaign-fragrance-eu.yaml
 *   npm run look -- samples/campaign.yaml nocturne
 *
 * The cheapest way to answer "is this the right art direction", which is the
 * question people actually iterate on. A campaign preview generates one hero
 * per missing product; this generates exactly one image, because judging a look
 * needs one image. At 1K on the cheapest model that is about three cents
 * against thirteen for a shipping hero - a quarter of the price for a quarter
 * of the pixels, on the axis where pixels do not matter.
 *
 * Cheaper still, and free: `npm run campaign -- <brief> --dry-run --prompts`
 * prints which slots the brief changed and what it inherited. Most questions
 * are answered there without generating anything.
 */
const args = process.argv.slice(2);
const [file = "samples/campaign.yaml", lookOverride] = args.filter((a) => !a.startsWith("--"));

const brief = await loadBriefFile(path.resolve(file));
if (lookOverride && !(lookOverride in LOOKS)) {
  console.error(`Unknown look "${lookOverride}". Available: ${Object.keys(LOOKS).join(", ")}`);
  process.exit(2);
}
// Overriding the look here rather than editing the brief is the point: it is
// how you compare two looks for the same campaign without a commit in between.
const subject = lookOverride ? { ...brief, look: lookOverride as keyof typeof LOOKS } : brief;

// The same gate the campaign path uses. This spends, so it does not get a side
// entrance around the free checks.
preflightOrThrow(await preflight(subject));

// The product that would actually cost money, since that is the one whose art
// direction is in question.
const product = subject.products.find((p) => !p.approvedHeroPath) ?? subject.products[0];
const reference = await findApprovedHero(product.referenceAssetPath);

const generator = selectGenerator(process.env, PREVIEW_MODEL.id);
const art = resolveArtDirection(subject);

console.log(`\nLOOK  ${art.look}  ·  ${product.name}  ·  ${generator.model}`);
console.log(`  One generation at 1K: $${PREVIEW_MODEL.usdPer2K.toFixed(4)}`);
if (art.overridden.length) console.log(`  Slots overridden: ${art.overridden.join(", ")}`);

const startedAt = Date.now();
const hero = await generator.generateHero({
  productId: product.id,
  productName: product.name,
  campaignMessage: subject.message,
  region: subject.region,
  audience: subject.audience,
  brandName: subject.brand.name,
  prompt: buildHeroPrompt(product, subject, Boolean(reference)),
  referenceAssetPath: reference,
  imageSize: "1K",
});

const out = path.resolve("outputs", "looks", `${art.look}-${product.id}.png`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, hero.bytes);
console.log(
  `  ✓ ${((Date.now() - startedAt) / 1000).toFixed(1)}s  ${path.relative(process.cwd(), out)}\n`,
);
