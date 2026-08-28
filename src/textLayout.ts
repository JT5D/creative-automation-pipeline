/**
 * Deterministic text layout.
 *
 * Sharp rasterizes SVG, and SVG gives us no text-measurement API, so we
 * measure with a per-character width table instead of a flat multiplier.
 * Approximate, but consistent -- and consistency is what matters: the same
 * copy always wraps identically, so output is reproducible run to run.
 *
 * Widths are fractions of font-size, sampled from a humanist sans (Helvetica
 * /Arial/DejaVu all sit within a few percent of these).
 */
const NARROW = new Set([..."ijltfIr!|.,;:'`()[]{}/\\ "]);
const WIDE = new Set([..."mwMW@%"]);
const UPPER_EXTRA = 0.06;

export function charWidth(ch: string, fontSize: number): number {
  let factor = 0.52;
  if (NARROW.has(ch)) factor = 0.28;
  else if (WIDE.has(ch)) factor = 0.86;
  else if (ch >= "0" && ch <= "9") factor = 0.55;
  if (ch !== ch.toLowerCase() && ch !== ch.toUpperCase()) factor += 0;
  if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) factor += UPPER_EXTRA;
  return factor * fontSize;
}

/**
 * Bold faces set wider than regular at the same size. Ignoring that made the
 * CTA pill size to the regular-weight width and clip its own label, so weight
 * is now part of the measurement rather than an afterthought.
 */
const BOLD_FACTOR = 1.10;

export function measure(text: string, fontSize: number, weight = 400): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return weight >= 600 ? w * BOLD_FACTOR : w;
}

/** Greedy wrap. A single word longer than the line is left intact, not broken. */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  weight = 400,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, fontSize, weight) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export type FitResult = {
  lines: string[];
  fontSize: number;
  /** True when the copy fits inside maxLines at or above minFontSize. */
  fits: boolean;
};

/**
 * Shrinks the headline until it fits the copy zone -- but stops at
 * minFontSize and reports failure rather than rendering something illegible.
 * An unreadable ad is a worse outcome than a flagged one.
 */
export function fitText(
  text: string,
  maxWidth: number,
  maxLines: number,
  maxFontSize: number,
  minFontSize: number,
  weight = 700,
): FitResult {
  for (let size = maxFontSize; size >= minFontSize; size -= 2) {
    const lines = wrapText(text, maxWidth, size, weight);
    if (lines.length <= maxLines) return { lines, fontSize: size, fits: true };
  }
  const lines = wrapText(text, maxWidth, minFontSize, weight).slice(0, maxLines);
  return { lines, fontSize: minFontSize, fits: false };
}

/** WCAG relative luminance, used to pick readable text over any brand colour. */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Picks whichever of the brand's own light/dark tones reads on a background. */
export function readableTextColor(background: string): string {
  return relativeLuminance(background) > 0.45 ? "#101010" : "#FFFFFF";
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
