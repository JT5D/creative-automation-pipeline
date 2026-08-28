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
 *
 * It measures GEOMETRY AND TONE ONLY. It greyscales first, so it is blind to
 * colour by construction -- see colourSignature below, which is the other half
 * and exists because this one alone was being described as "appearance".
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

/**
 * What the luminance grid above cannot see: colour.
 *
 * `visualSignature` greyscales before it measures, so it is blind to every
 * colour defect by construction -- a creative rendered in the wrong brand
 * palette at the same luminance drifts by exactly zero and passes a test named
 * "matches its committed appearance". That is the same shape as every false
 * green in this repo: a label broader than the measurement under it.
 *
 * It is not theoretical. The worst rendering defect this project has had was
 * `.png({ quality: 95 })` quantising every export to a 256-colour palette. It
 * survived the whole suite, including 24 committed visual baselines, and was
 * found by opening a file. `distinctColours` is the number that would have
 * caught it: a truecolor export of a photographic hero carries tens of
 * thousands of colours, and a palette-mode one carries at most 256.
 *
 * Sampled at 256x256 rather than full size, which costs milliseconds. The two
 * measurements need different sampling and get it:
 *
 *   distinctColours  NEAREST NEIGHBOUR, which returns real source pixels. The
 *                    first version of this used the default (lanczos) and was
 *                    itself a false green -- interpolation manufactures colours
 *                    between the palette entries, so a 256-colour file measured
 *                    8,534 and sailed past. Measured on this repo's own 1:1
 *                    creative: 11,102 truecolor, exactly 256 after
 *                    `.png({ quality: 95 })`, and 8,534 if you resize it wrong.
 *   rgb              lanczos, because a mean wants the smooth resample and is
 *                    then stable enough across platforms to compare directly.
 */
export type ColourSignature = {
  /** Mean R, G, B across the whole creative, 0-255. */
  rgb: [number, number, number];
  /** Distinct RGB triples in a 256x256 sample. */
  distinctColours: number;
};

const COLOUR_SAMPLE = 256;

export async function colourSignature(image: Buffer | string): Promise<ColourSignature> {
  const sample = (kernel: "nearest" | "lanczos3") =>
    sharp(image)
      .resize(COLOUR_SAMPLE, COLOUR_SAMPLE, { fit: "fill", kernel })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

  const exact = await sample("nearest");
  const seen = new Set<number>();
  for (let i = 0; i < exact.data.length; i += exact.info.channels) {
    seen.add((exact.data[i] << 16) | (exact.data[i + 1] << 8) | exact.data[i + 2]);
  }

  const smooth = await sample("lanczos3");
  const totals = [0, 0, 0];
  const pixels = smooth.info.width * smooth.info.height;
  for (let i = 0; i < smooth.data.length; i += smooth.info.channels) {
    totals[0] += smooth.data[i];
    totals[1] += smooth.data[i + 1];
    totals[2] += smooth.data[i + 2];
  }

  return {
    rgb: totals.map((t) => Math.round(t / pixels)) as [number, number, number],
    distinctColours: seen.size,
  };
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
