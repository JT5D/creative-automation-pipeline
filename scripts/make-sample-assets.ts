import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { measureText } from "../src/fonts.js";
import { selectGenerator } from "../src/providers/index.js";

/**
 * One-time setup for the repo's sample INPUT assets.
 *
 *   npm run make:samples
 *
 * The committed PNGs in samples/assets/ were produced by this script, so an
 * evaluator never has to run it. Two of those inputs are themselves GenAI
 * images - that is stated plainly in the README. They are inputs to the
 * exercise, not pipeline outputs, and nothing in the demo passes them off
 * as pipeline results.
 */
const ASSETS = path.resolve("samples/assets");

/**
 * Reversed lockups are drawn in one light tone so they hold over any hero.
 * A two-colour version put gold under the wordmark and it disappeared against
 * a sunlit wall; brand systems ship a reversed variant for exactly this reason.
 */
const CREAM = "#F4F1EA";

/**
 * Every sample brand gets a wordmark, drawn in code - deterministic, and mine,
 * not a model's.
 *
 * They exist because the exercise names "presence of logo" as its example of a
 * brand check, and a check with nothing to measure is not a check. Two brands
 * shipped without one, and the logo rule went absent rather than red, so those
 * campaigns reported every creative passing a brand suite that had quietly
 * skipped the brand's most visible asset.
 *
 * Each mark is a symbol inside a ring plus the name, so the four read as one
 * system without being the same drawing. Lumen's is a leaf: the ring is the
 * "lumen", the leaf the "botanicals". It replaced a cross inside a ring, which
 * is worth recording as a mistake - a cross-in-circle is the visual language of
 * pharmacy and first aid, and this brand sells a *cosmetic*. Its own brief bans
 * "clinically proven" and hedges to "Dermatologist tested" precisely to stay
 * clear of medical claims, so leading the lockup with a medical symbol undercut
 * the compliance position the copy was holding.
 *
 * The typeface is the bundled one. An earlier version asked for
 * "Helvetica, Arial", neither of which ships here - on this machine fontconfig
 * found a system Helvetica, and on a Linux CI box it would have silently
 * substituted something else. Same class of bug as the font chain described in
 * assets/fonts/LICENSE.md, in the one asset that had escaped the fix.
 */
type Lockup = { file: string; name: string; sub?: string; glyph: string };

const LOCKUPS: Lockup[] = [
  {
    file: "lumen-logo.png",
    name: "LUMEN",
    sub: "BOTANICALS",
    // Leaf: light and plant, the two halves of the name.
    glyph: `<path d="M92 64 C118 84 118 116 92 136 C66 116 66 84 92 64 Z"
              fill="none" stroke="${CREAM}" stroke-width="6" stroke-linejoin="round"/>
            <path d="M92 78 L92 130" stroke="${CREAM}" stroke-width="4"
              stroke-linecap="round" opacity="0.9"/>`,
  },
  {
    file: "nordisk-brew-logo.png",
    name: "NORDISK",
    sub: "BREW",
    // Bean: an ellipse with its seam, the category's oldest mark.
    glyph: `<ellipse cx="92" cy="100" rx="24" ry="33" fill="none"
              stroke="${CREAM}" stroke-width="6" transform="rotate(-28 92 100)"/>
            <path d="M78 78 C98 92 86 108 106 122" fill="none" stroke="${CREAM}"
              stroke-width="5" stroke-linecap="round"/>`,
  },
  {
    file: "nordvik-logo.png",
    name: "NORDVIK",
    // Headland and water: "nord" + "vik", north inlet. Drawn as two angles
    // rather than a line over an arc, which read as a smiling face.
    glyph: `<path d="M62 116 L92 72 L122 116" fill="none" stroke="${CREAM}"
              stroke-width="6" stroke-linejoin="round"/>
            <path d="M64 132 L120 132" stroke="${CREAM}" stroke-width="5"
              stroke-linecap="round" opacity="0.85"/>`,
  },
  {
    file: "atelier-ferro-logo.png",
    name: "ATELIER",
    sub: "FERRO",
    // Flacon: shoulders, neck and stopper, reduced to four strokes.
    glyph: `<path d="M78 84 L78 132 L106 132 L106 84 Z" fill="none" stroke="${CREAM}"
              stroke-width="6" stroke-linejoin="round"/>
            <path d="M86 84 L86 72 L98 72 L98 84" fill="none" stroke="${CREAM}"
              stroke-width="5" stroke-linejoin="round"/>`,
  },
];

/**
 * Wordmark tracking is measured, never guessed.
 *
 * The names are different lengths, so a single hardcoded size and letter
 * spacing would run the longest one off the 640px canvas. This reads Rubik's
 * real advance widths through the same measureText the compositor uses, then
 * picks the largest size that fits - the same measured-typography argument the
 * creatives make, applied to the one asset that used to sidestep it.
 */
function fitWordmark(text: string, maxWidth: number, maxSize: number, tracking: number) {
  for (let size = maxSize; size >= 18; size -= 1) {
    const width = measureText(text, size, "bold") + tracking * size * 0.1 * text.length;
    if (width <= maxWidth) return { size, spacing: Number((size * 0.1 * tracking).toFixed(2)) };
  }
  return { size: 18, spacing: 1 };
}

async function makeLogos() {
  for (const lockup of LOCKUPS) {
    const name = fitWordmark(lockup.name, 430, 52, 1.2);
    const sub = lockup.sub ? fitWordmark(lockup.sub, 430, 25, 4.2) : null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200">
      <circle cx="92" cy="100" r="52" fill="none" stroke="${CREAM}" stroke-width="6"/>
      ${lockup.glyph}
      <text x="176" y="${sub ? 92 : 118}" font-family="Rubik" font-size="${name.size}"
            font-weight="700" letter-spacing="${name.spacing}" fill="${CREAM}">${lockup.name}</text>
      ${
        sub
          ? `<text x="178" y="136" font-family="Rubik" font-size="${sub.size}"
            letter-spacing="${sub.spacing}" fill="${CREAM}" opacity="0.82">${lockup.sub}</text>`
          : ""
      }
    </svg>`;
    const out = path.join(ASSETS, lockup.file);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log(`  ✓ ${lockup.file.padEnd(26)} ${path.relative(process.cwd(), out)}`);
  }
}

const PROMPTS = {
  // The approved campaign hero, and the fixture with the most to prove.
  //
  // Two constraints, both learned the hard way. Its composition has to match
  // what the pipeline asks of a generated one, or the fixture demonstrates the
  // reuse path while quietly breaking the layout: shot "centred with empty
  // space on all sides", the bottle ran straight through the copy band once
  // copy moved to the top. And it has to be lit and graded like the generated
  // hero, or the two products in one campaign read as two separate shoots --
  // which is what happened when the art direction moved to a cinematic
  // standard and this prompt stayed a catalogue one. A brand's real approved
  // asset comes off the same shoot as the rest of the campaign; this is the
  // fixture standing in for that, so it has to behave like it.
  "radiance-serum-hero.png":
    "Award-winning cinematic advertising photography, editorial quality, shot " +
    "for a global luxury brand campaign. Rich, filmic colour grade with deep " +
    "tonal range. Beautiful shallow depth of field. Dramatic natural light with " +
    "real atmosphere and mood. Hyper-detailed, photorealistic, sharp on the " +
    "subject. Not a flat studio packshot, not a stock catalogue render. " +
    "Campaign photograph of an amber glass vitamin C facial serum bottle with a " +
    "matte deep-green dropper cap. Shot on a 100mm macro lens at f/4, focus " +
    "stacked across the bottle itself so its edges are critically sharp, while " +
    "the background falls into a soft, creamy out-of-focus wash with gentle " +
    "bokeh. Lit by soft natural window daylight raking in from the upper left, " +
    "warm and directional, with open bounce fill from the right and a narrow rim " +
    "of light separating the bottle from the background. A faint atmospheric " +
    "haze catches the light. The bottle stands on a honed travertine ledge " +
    "against a seamless plaster wall, with soft foliage shadow falling across " +
    "the background. Warm cream and deep green palette. The bottle sits in the " +
    "LOWER HALF of the frame, horizontally centred, large and clearly the " +
    "subject, filling most of the central 50% of the width with its base and cap " +
    "entirely in frame. The UPPER HALF is quiet, empty background - wall and " +
    "light only, no product and no props - because campaign copy is composited " +
    "there. No text, no lettering, no logos, no watermarks, no packaging labels.",

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

  await makeLogos();

  // The logos are pure SVG, so they can be redrawn without touching a paid model.
  // One asset at a time, so regenerating a single fixture does not pay for both.
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];

  if (process.argv.includes("--logo-only")) {
    console.log("\n  logos only - skipping generation\n");
    return;
  }

  const generator = selectGenerator();
  console.log(`  · provider        ${generator.provider} · ${generator.model}\n`);

  for (const [filename, prompt] of Object.entries(PROMPTS)) {
    if (only && !filename.includes(only)) continue;
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
