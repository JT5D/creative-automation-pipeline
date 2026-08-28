import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { selectGenerator } from "../src/providers/index.js";

/**
 * One-time setup for the repo's sample INPUT assets.
 *
 *   npm run make:samples
 *
 * The committed PNGs in samples/assets/ were produced by this script, so an
 * evaluator never has to run it. Two of those inputs are themselves GenAI
 * images — that is stated plainly in the README. They are inputs to the
 * exercise, not pipeline outputs, and nothing in the demo passes them off
 * as pipeline results.
 */
const ASSETS = path.resolve("samples/assets");

const BRAND = { deep: "#14322B", gold: "#C9A227", cream: "#F4F1EA" };

/** The wordmark is drawn in code — deterministic, and mine, not a model's. */
async function makeLogo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200">
    <rect width="640" height="200" fill="none"/>
    <circle cx="92" cy="100" r="52" fill="none" stroke="${BRAND.gold}" stroke-width="7"/>
    <path d="M92 58 L92 142 M60 100 L124 100" stroke="${BRAND.gold}" stroke-width="7" stroke-linecap="round"/>
    <text x="176" y="92" font-family="Helvetica, Arial, sans-serif" font-size="52"
          font-weight="700" letter-spacing="6" fill="${BRAND.cream}">LUMEN</text>
    <text x="178" y="136" font-family="Helvetica, Arial, sans-serif" font-size="25"
          letter-spacing="10.5" fill="${BRAND.gold}">BOTANICALS</text>
  </svg>`;
  const out = path.join(ASSETS, "lumen-logo.png");
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`  ✓ logo            ${out}`);
}

const PROMPTS = {
  "radiance-serum-hero.png":
    "Professional commercial advertising photograph of an amber glass vitamin C " +
    "facial serum bottle with a matte deep-green dropper cap, standing on a pale " +
    "travertine stone ledge. Soft directional morning light from the left, gentle " +
    "eucalyptus leaf shadow falling across the background, warm cream and deep " +
    "green palette. Product centred, sharp, with generous empty space on all " +
    "sides. Premium editorial skincare campaign photography, shallow depth of " +
    "field. No text, no lettering, no logos, no watermarks, no packaging labels.",

  "overnight-cream-packshot.png":
    "Clean e-commerce packshot of a squat frosted-glass skincare jar with a matte " +
    "deep-green lid, photographed straight on, centred on a pure white seamless " +
    "background with a soft contact shadow. Studio softbox lighting, crisp and " +
    "even, catalogue style. No text, no lettering, no logos, no watermarks, no " +
    "printed labels of any kind.",
} as const;

async function main() {
  await mkdir(ASSETS, { recursive: true });
  console.log("\nBuilding sample input assets\n");

  await makeLogo();

  const generator = selectGenerator();
  console.log(`  · provider        ${generator.provider} · ${generator.model}\n`);

  for (const [filename, prompt] of Object.entries(PROMPTS)) {
    const out = path.join(ASSETS, filename);
    const result = await generator.generateHero({
      productId: filename,
      productName: filename,
      campaignMessage: "",
      region: "",
      audience: "",
      brandName: "Lumen Botanicals",
      prompt,
    });
    await writeFile(out, result.bytes);
    const meta = await sharp(out).metadata();
    console.log(
      `  ✓ ${filename.padEnd(34)} ${meta.width}×${meta.height}  ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  }

  console.log("\nDone. Commit these so evaluators never need an API key for setup.\n");
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
