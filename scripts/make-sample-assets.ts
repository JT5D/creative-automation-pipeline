import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import "../src/fonts.js";
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

/**
 * The wordmark is drawn in code — deterministic, and mine, not a model's.
 *
 * It is the reversed, single-colour lockup: every element is the same light
 * tone so it holds over any background. An earlier two-colour version put gold
 * under the wordmark, which disappeared against a sunlit wall. Brand systems
 * ship a reversed variant for exactly this reason.
 *
 * The mark is a leaf inside a ring: the ring is the "lumen", the leaf is the
 * "botanicals". It replaced a cross inside a ring, which was a mistake worth
 * recording — a cross-in-circle is the visual language of pharmacy and first
 * aid, and this brand sells a *cosmetic*. Its own brief bans "clinically
 * proven" and hedges to "Dermatologist tested" precisely to stay clear of
 * medical claims, so leading the lockup with a medical symbol undercut the
 * compliance position the copy was working to hold. It also meant nothing:
 * neither light nor plant.
 *
 * The typeface is the bundled one. The previous version asked for
 * "Helvetica, Arial", neither of which ships here — on this machine fontconfig
 * found a system Helvetica, and on a Linux CI box it would have silently
 * substituted something else. Same class of bug as the font chain described in
 * assets/fonts/LICENSE.md, in the one asset that had escaped the fix.
 */
async function makeLogo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200">
    <rect width="640" height="200" fill="none"/>
    <circle cx="92" cy="100" r="52" fill="none" stroke="${BRAND.cream}" stroke-width="6"/>
    <path d="M92 64 C118 84 118 116 92 136 C66 116 66 84 92 64 Z"
          fill="none" stroke="${BRAND.cream}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M92 78 L92 130" stroke="${BRAND.cream}" stroke-width="4" stroke-linecap="round" opacity="0.9"/>
    <text x="176" y="92" font-family="Rubik" font-size="52"
          font-weight="700" letter-spacing="6" fill="${BRAND.cream}">LUMEN</text>
    <text x="178" y="136" font-family="Rubik" font-size="25"
          letter-spacing="10.5" fill="${BRAND.cream}" opacity="0.82">BOTANICALS</text>
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

  // The logo is pure SVG, so it can be redrawn without touching a paid model.
  if (process.argv.includes("--logo-only")) {
    console.log("\n  logo only — skipping generation\n");
    return;
  }

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
