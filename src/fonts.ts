import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import opentype from "opentype.js";

/**
 * Typography is bundled, not borrowed.
 *
 * Rubik ships with the repo for two reasons. First, the creatives render
 * identically on any machine -- an evaluator on Linux gets the same pixels I
 * get on macOS, instead of whatever their fontconfig happens to fall back to.
 * Second, and more useful: because the font file is right here, line breaking
 * can read real glyph advance widths out of it rather than estimating them.
 *
 * Licence: assets/fonts/LICENSE.md (SIL Open Font License).
 */
export const FONT_FAMILY = "Rubik";
export const FONT_DIR = path.resolve("assets/fonts");

/**
 * librsvg resolves SVG font-family through fontconfig, which only looks at
 * system directories. Pointing it at the bundled directory has to happen
 * before libvips loads, so this module is imported for its side effect.
 */
function configureFontconfig(): void {
  if (process.env.CAP_FONTCONFIG_READY) return;
  const cfgDir = mkdtempSync(path.join(tmpdir(), "cap-fc-"));
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>${cfgDir}</cachedir>
</fontconfig>`;
  writeFileSync(path.join(cfgDir, "fonts.conf"), conf);
  process.env.FONTCONFIG_PATH = cfgDir;
  process.env.FONTCONFIG_FILE = path.join(cfgDir, "fonts.conf");
  process.env.CAP_FONTCONFIG_READY = "1";
}

configureFontconfig();

const cache = new Map<number, opentype.Font>();

/** 400 and 700 are the two weights the templates use. */
export function loadFont(weight: 400 | 700): opentype.Font {
  const cached = cache.get(weight);
  if (cached) return cached;
  const file = weight >= 700 ? "Rubik-Bold.ttf" : "Rubik-Regular.ttf";
  const bytes = readFileSync(path.join(FONT_DIR, file));
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  cache.set(weight, font);
  return font;
}

/**
 * Exact advance width in pixels, summed from the font's own hmtx table plus
 * kerning pairs. This replaced a per-character width table that guessed at
 * Helvetica metrics -- the guess was wrong for Rubik, and a CTA pill sized
 * from it clipped its own label.
 *
 * Glyphs are walked directly rather than through getAdvanceWidth(), because
 * that path runs opentype.js's shaping engine, which throws on Rubik's ccmp
 * lookup (type 6, format 2 -- unsupported by the library). Advance widths and
 * kerning are all the layout needs; shaping would add nothing for Latin copy.
 */
export function measureText(text: string, fontSize: number, weight: 400 | 700 = 700): number {
  if (!text) return 0;

  const font = loadFont(weight);
  const scale = fontSize / font.unitsPerEm;

  let units = 0;
  let previous: opentype.Glyph | null = null;

  for (const char of text) {
    const glyph = font.charToGlyph(char);
    units += glyph.advanceWidth ?? 0;
    if (previous) units += font.getKerningValue(previous, glyph);
    previous = glyph;
  }

  return units * scale;
}
