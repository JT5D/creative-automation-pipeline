import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateFor } from "../src/composer.js";
import { loadBriefFile, runCampaign } from "../src/pipeline.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import { RATIOS, type RatioKey, selectScope } from "../src/schema.js";
import { colourSignature, compareSignatures, visualSignature } from "../src/signature.js";

/**
 * Visual regression.
 *
 * Every other test in this suite checks that something is true of the output:
 * the right size, ink where copy should be, the safe zone respected. None of
 * them would notice a headline sliding on top of the lockup, because that
 * creative still has the right dimensions and plenty of ink.
 *
 * These compare each creative against a committed signature instead, so an
 * unintended layout change fails even when nobody thought to assert against it.
 */
const baselines = JSON.parse(
  readFileSync(path.resolve("tests/baselines/creatives.json"), "utf8"),
) as Record<string, { luma: number[]; rgb: number[] }>;

/**
 * Tolerances, set from measurement rather than taste.
 *
 * Re-rendering the same brief twice produces drift of exactly 0 -- composition
 * is deterministic. Deliberately sliding a copy band produces:
 *
 *     shift    meanDrift   cellsChanged
 *      40px      0.389           8
 *     100px      0.743          27
 *     160px      0.965          36
 *
 * The same baselines rendered on Linux in CI drift by 0.014 -- that is the real
 * cost of different font rasterization at this grid size. So 0.3 sits about
 * twenty times above cross-platform noise and comfortably below a shift worth
 * catching. The last two tests keep the check honest: one proves it detects a
 * moved band, the other proves rendering is deterministic in the first place.
 */
const MAX_MEAN_DRIFT = 0.3;
const MAX_CELLS_CHANGED = 6;

/**
 * Colour tolerances, set from measurement.
 *
 * Mean RGB moves a little with font rasterization, so it is a per-channel
 * budget rather than an equality: it catches a palette swap or a lost brand
 * colour, not an antialiasing difference between macOS and Linux.
 *
 * The floor on distinct colours is the one that matters, and 512 is not a round
 * number picked for comfort. A palette PNG cannot hold more than 256 colours --
 * that is a hard ceiling, not a tendency -- and the lowest count across all 24
 * creatives in this fixture is 768, on the 16:9 whose left half is a flat brand
 * panel. 512 sits between the two with headroom on both sides. The repo's real
 * photographic creative measures 11,102, and 256 after `.png({ quality: 95 })`.
 */
const MAX_CHANNEL_DRIFT = 6;
const MIN_DISTINCT_COLOURS = 512;

let outputs: string;
let signatures: Record<string, number[]>;
let colours: Record<string, Awaited<ReturnType<typeof colourSignature>>>;

beforeAll(async () => {
  outputs = await mkdtemp(path.join(tmpdir(), "cap-visual-"));
  // dev, deliberately: this suite compares LAYOUT, so it wants the
  // deterministic offline renderer as its hero. `final` now refuses that
  // renderer for a missing asset -- which is the point of the guard, and
  // exactly why this fixture must not run in final mode.
  const report = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
    outputRoot: outputs,
    mode: "dev",
    generator: new TestDoubleHeroGenerator(),
  });

  signatures = {};
  colours = {};
  for (const product of report.products) {
    for (const creative of product.creatives) {
      const key = `${product.productId}/${creative.ratio}/${creative.locale}`;
      const file = path.join(outputs, creative.outputPath);
      signatures[key] = await visualSignature(file);
      colours[key] = await colourSignature(file);
    }
  }
}, 120_000);

afterAll(async () => {
  await rm(outputs, { recursive: true, force: true });
});

describe("visual regression", () => {
  /**
   * The baselines are a sample, so coverage is asserted in two halves: every
   * committed key must still be produced, and the run must still produce
   * exactly the number of creatives the brief asks for. Together those catch a
   * renamed creative, a dropped one and a silently added one -- which is what
   * comparing the two key sets used to do when all twenty-four were committed.
   */
  it("still produces every creative the baselines name, and no more than the brief asks for", async () => {
    const brief = await loadBriefFile("samples/campaign.yaml");
    const { ratios, markets } = selectScope(brief);
    expect(Object.keys(signatures).length).toBe(
      brief.products.length * ratios.length * markets.length,
    );
    for (const key of Object.keys(baselines)) expect(Object.keys(signatures)).toContain(key);
  });

  it.each(Object.keys(baselines))("%s matches its committed appearance", (key) => {
    const drift = compareSignatures(signatures[key], baselines[key].luma);
    expect(drift.meanDrift).toBeLessThanOrEqual(MAX_MEAN_DRIFT);
    expect(drift.cellsChanged).toBeLessThanOrEqual(MAX_CELLS_CHANGED);

    // The half the luminance grid cannot see. Until this existed, "matches its
    // committed appearance" meant "matches its committed greyscale", and the
    // creatives could have gone out in any palette at all.
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(colours[key].rgb[channel] - baselines[key].rgb[channel])).toBeLessThanOrEqual(
        MAX_CHANNEL_DRIFT,
      );
    }
    expect(colours[key].distinctColours).toBeGreaterThan(MIN_DISTINCT_COLOURS);
  });

  /**
   * A regression test that cannot fail is decoration. This moves a headline by
   * a plausible amount and asserts the signature notices.
   */
  /**
   * The colour half of the same argument. This is the exact defect that got
   * past 24 committed baselines and the whole suite: PNG `quality` is not JPEG
   * quality, it switches libvips into palette mode. Re-encoding one creative
   * that way here proves the check now goes red on it.
   */
  it("actually detects a creative quantised to a palette", async () => {
    const sharp = (await import("sharp")).default;
    const file = path.join(outputs, "lumen-autumn-glow-de/radiance-serum/1x1/en-gb.png");
    const quantised = await sharp(file).png({ quality: 95 }).toBuffer();

    const before = await colourSignature(file);
    const after = await colourSignature(quantised);

    expect(before.distinctColours).toBeGreaterThan(MIN_DISTINCT_COLOURS);
    expect(after.distinctColours).toBeLessThanOrEqual(256);

    // And the tone grid, which is what used to guard these files, does not
    // notice at all. That is the finding, stated as an assertion.
    const tonal = compareSignatures(
      await visualSignature(quantised),
      signatures["radiance-serum/1x1/en-GB"],
    );
    expect(tonal.meanDrift).toBeLessThanOrEqual(MAX_MEAN_DRIFT);
  });

  it("actually detects a layout change", async () => {
    const key = "radiance-serum/1x1/en-GB";
    const shifted = await visualSignature(
      await shiftCopyBand(path.join(outputs, "lumen-autumn-glow-de/radiance-serum/1x1/en-gb.png")),
    );
    const drift = compareSignatures(shifted, baselines[key].luma);

    expect(drift.meanDrift).toBeGreaterThan(MAX_MEAN_DRIFT);
    expect(drift.cellsChanged).toBeGreaterThan(MAX_CELLS_CHANGED);
  });

  /**
   * Composition must be deterministic, or a baseline proves nothing. This
   * compares two renders on the SAME machine, which is the only place exact
   * equality is a fair ask -- against a committed baseline from another
   * platform the honest expectation is "negligible", not "identical".
   */
  it("renders the same brief identically twice", async () => {
    const opts = {
      outputRoot: outputs,
      mode: "final" as const,
      ratios: ["1x1" as const],
      locales: ["en-GB"],
    };
    const first = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
      ...opts,
      generator: new TestDoubleHeroGenerator(),
    });
    const a = await visualSignature(path.join(outputs, first.products[0].creatives[0].outputPath));

    const second = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
      ...opts,
      generator: new TestDoubleHeroGenerator(),
    });
    const b = await visualSignature(path.join(outputs, second.products[0].creatives[0].outputPath));

    expect(compareSignatures(a, b).meanDrift).toBe(0);
  }, 120_000);
});

describe("layout collisions", () => {
  it("never lets the lockup and the headline occupy the same band", () => {
    for (const ratio of Object.keys(RATIOS) as RatioKey[]) {
      const tpl = templateFor(ratio);
      const logoBottom = tpl.logo.top + 100; // generous lockup height
      // The accent rule sits just above the headline and marks its top edge.
      expect(logoBottom).toBeLessThan(tpl.copy.top - 34);
    }
  });

  it("keeps the copy column inside the canvas in every format", () => {
    for (const ratio of Object.keys(RATIOS) as RatioKey[]) {
      const { width } = RATIOS[ratio];
      const tpl = templateFor(ratio);
      expect(tpl.copy.left).toBeGreaterThan(0);
      expect(tpl.copy.left + tpl.copy.width).toBeLessThanOrEqual(width);
    }
  });
});

/** Slides the lower half up by 100px, standing in for a layout slip. */
async function shiftCopyBand(file: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(file).metadata();
  const w = meta.width ?? 1080;
  const h = meta.height ?? 1080;
  const half = Math.floor(h / 2);
  const lower = await sharp(file)
    .extract({ left: 0, top: half, width: w, height: h - half })
    .toBuffer();
  return sharp(file)
    .composite([{ input: lower, left: 0, top: half - 100 }])
    .png()
    .toBuffer();
}
