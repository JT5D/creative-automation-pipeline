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
 * `visualSignature` greyscales before it measures, so a creative rendered in
 * the wrong palette at the same luminance drifts by zero and passes a test
 * named "matches its committed appearance".
 *
 * The worst rendering defect this project had was `.png({ quality: 95 })`
 * quantising every export to 256 colours. It survived the whole suite and 24
 * visual baselines, and was found by opening a file. `distinctColours` is the
 * number that catches it: a truecolor photographic hero carries tens of
 * thousands, a palette-mode one at most 256.
 *
 * The two measurements need different sampling, at 256x256:
 *
 *   distinctColours  NEAREST NEIGHBOUR, which returns real source pixels.
 *                    Interpolation manufactures colours between palette
 *                    entries: this repo's 1:1 creative measures 11,102
 *                    truecolor, exactly 256 after the palette bug, and 8,534
 *                    if resized with the default filter.
 *   rgb              lanczos, because a mean wants the smooth resample and is
 *                    then stable across platforms.
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
