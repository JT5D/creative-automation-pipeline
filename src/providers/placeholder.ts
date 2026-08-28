import sharp from "sharp";
import type { GeneratedHero, HeroGenerator, HeroRequest } from "./types.js";

/**
 * Deterministic offline hero renderer. Calls nothing, costs nothing.
 *
 * This exists so the repo runs on a machine that has just cloned it, with no
 * account and no API key -- which matters because the exercise asks for
 * something the interviewers can set up and run locally. It is also what the
 * test suite uses, so CI never touches a paid endpoint.
 *
 * It is NOT presented as generative output anywhere. Assets it produces carry
 * `source: "placeholder"`, are excluded from `generationRequests`, and are
 * labelled "PLACEHOLDER — no model called" in the UI, the CLI summary and
 * report.json. Swapping in a real provider is one environment variable.
 */
export class PlaceholderHeroGenerator implements HeroGenerator {
  readonly provider = "offline-placeholder";
  readonly model = "deterministic-render";

  async generateHero(input: HeroRequest): Promise<GeneratedHero> {
    const startedAt = Date.now();
    const size = 2048;

    // Derived from the product id, so the same brief always renders the same
    // bytes and a layout change never looks like a new generation.
    const seed = [...input.productId].reduce((a, c) => a + c.charCodeAt(0), 0);
    const hue = seed % 360;
    const bottleH = 900 + (seed % 200);
    const cx = size / 2;
    const top = size / 2 - bottleH / 2 + 120;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stop-color="hsl(${hue},18%,88%)"/>
          <stop offset="100%" stop-color="hsl(${(hue + 24) % 360},22%,68%)"/>
        </linearGradient>
        <linearGradient id="body" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="hsl(${hue},26%,52%)"/>
          <stop offset="45%" stop-color="hsl(${hue},30%,64%)"/>
          <stop offset="100%" stop-color="hsl(${hue},26%,44%)"/>
        </linearGradient>
        <radialGradient id="shadow">
          <stop offset="0%" stop-color="#000" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <rect width="${size}" height="${size}" fill="url(#bg)"/>
      <ellipse cx="${cx}" cy="${top + bottleH + 40}" rx="360" ry="70" fill="url(#shadow)"/>
      <rect x="${cx - 90}" y="${top - 130}" width="180" height="150" rx="26"
            fill="hsl(${hue},30%,38%)"/>
      <rect x="${cx - 250}" y="${top}" width="500" height="${bottleH}" rx="90"
            fill="url(#body)"/>
      <rect x="${cx - 180}" y="${top + 80}" width="90" height="${bottleH - 300}" rx="45"
            fill="#ffffff" opacity="0.18"/>
    </svg>`;

    return {
      bytes: await sharp(Buffer.from(svg)).png().toBuffer(),
      mimeType: "image/png",
      provider: this.provider,
      operation: input.referenceAssetPath ? "image-reference" : "text-to-image",
      model: this.model,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Kept as an alias so the tests read as what they are. */
export { PlaceholderHeroGenerator as TestDoubleHeroGenerator };
