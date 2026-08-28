import sharp from "sharp";
import type { GeneratedHero, HeroGenerator, HeroRequest } from "./types.js";

/**
 * Deterministic stand-in generator. TESTS ONLY.
 *
 * This exists so the full pipeline -- resolve, compose, validate, export,
 * report -- can be exercised in CI with zero network calls and zero spend.
 * It is never selectable at runtime: `selectGenerator()` cannot return it.
 * Anything it produces is labelled provider "test-double" in the report, so a
 * test artifact can never be mistaken for real generative output.
 */
export class TestDoubleHeroGenerator implements HeroGenerator {
  readonly provider = "test-double";
  readonly model = "deterministic-gradient";

  async generateHero(input: HeroRequest): Promise<GeneratedHero> {
    const startedAt = Date.now();
    const size = 2048;

    // A flat two-tone field derived from the product id -- deterministic, so
    // the same brief always yields byte-identical test output.
    const hue = [...input.productId].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="hsl(${hue},35%,42%)"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 3.2}" fill="hsl(${(hue + 40) % 360},45%,68%)"/>
      <text x="50%" y="52%" text-anchor="middle" font-family="sans-serif"
            font-size="96" fill="#ffffff">TEST DOUBLE</text>
    </svg>`;

    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();

    return {
      bytes,
      mimeType: "image/png",
      provider: this.provider,
      operation: input.referenceAssetPath ? "image-reference" : "text-to-image",
      model: this.model,
      durationMs: Date.now() - startedAt,
    };
  }
}
