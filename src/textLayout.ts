import { type Face, measureText } from "./fonts.js";

/**
 * Deterministic text layout.
 *
 * SVG gives no text-measurement API, so wrapping has to be computed before the
 * markup is written. Measurements come from the bundled font's own advance
 * widths (see fonts.ts) -- this used to be a per-character width table tuned by
 * eye, which was wrong often enough to clip a CTA label.
 */
export type FitResult = {
  lines: string[];
  fontSize: number;
  /** True when the copy fits inside maxLines at or above minFontSize. */
  fits: boolean;
};

/** Greedy wrap. A single word longer than the line is left intact, not broken. */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  face: Face = "display",
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, fontSize, face) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

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
  face: Face = "display",
): FitResult {
  for (let size = maxFontSize; size >= minFontSize; size -= 2) {
    const lines = wrapText(text, maxWidth, size, face);
    if (lines.length <= maxLines) return { lines, fontSize: size, fits: true };
  }
  const lines = wrapText(text, maxWidth, minFontSize, face).slice(0, maxLines);
  return { lines, fontSize: minFontSize, fits: false };
}

/** WCAG relative luminance, used to pick readable text over any brand colour. */
function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
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

/** Picks whichever tone reads on a given background. */
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
