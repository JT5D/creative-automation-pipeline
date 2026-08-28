import sharp from "sharp";

/**
 * A coarse visual signature of a rendered creative.
 *
 * Byte-comparing PNGs is useless across machines: font rasterization and
 * anti-aliasing differ between macOS and the Linux box CI runs on, so an exact
 * hash fails on the first push while catching nothing real.
 *
 * Instead the image is reduced to a small grid of mean luminance and quantized.
 * Anti-aliasing noise disappears at this resolution; a headline that moved, a
 * logo that vanished, or a scrim that changed strength does not.
 */
const SIGNATURE_GRID = 12;
const SIGNATURE_LEVELS = 16;

export async function visualSignature(image: Buffer | string): Promise<number[]> {
  const { data } = await sharp(image)
    .greyscale()
    .resize(SIGNATURE_GRID, SIGNATURE_GRID, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return Array.from(data).map((v) => Math.round((v / 255) * (SIGNATURE_LEVELS - 1)));
}

export type SignatureDrift = {
  /** Mean absolute difference in quantization levels, across every cell. */
  meanDrift: number;
  /** Largest single-cell difference. */
  maxDrift: number;
  /** Cells that moved by more than one level. */
  cellsChanged: number;
};

export function compareSignatures(a: number[], b: number[]): SignatureDrift {
  if (a.length !== b.length) {
    return { meanDrift: SIGNATURE_LEVELS, maxDrift: SIGNATURE_LEVELS, cellsChanged: a.length };
  }
  let total = 0;
  let max = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    total += d;
    if (d > max) max = d;
    if (d > 1) changed++;
  }
  return {
    meanDrift: Number((total / a.length).toFixed(3)),
    maxDrift: max,
    cellsChanged: changed,
  };
}
