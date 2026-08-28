import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateFor } from "../src/composer.js";
import { loadBriefFile, runCampaign } from "../src/pipeline.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import { RATIOS, type RatioKey } from "../src/schema.js";
import { compareSignatures, visualSignature } from "../src/signature.js";

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
) as Record<string, number[]>;

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
 * So these thresholds sit well above the zero-noise floor -- leaving room for
 * the anti-aliasing difference between a macOS dev machine and the Linux box CI
 * runs on -- and comfortably below a shift worth catching. The last test in
 * this file proves the detection rather than assuming it.
 */
const MAX_MEAN_DRIFT = 0.3;
const MAX_CELLS_CHANGED = 6;

let outputs: string;
let signatures: Record<string, number[]>;

beforeAll(async () => {
  outputs = await mkdtemp(path.join(tmpdir(), "cap-visual-"));
  const report = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
    outputRoot: outputs,
    mode: "final",
    generator: new TestDoubleHeroGenerator(),
  });

  signatures = {};
  for (const product of report.products) {
    for (const creative of product.creatives) {
      signatures[`${product.productId}/${creative.ratio}/${creative.locale}`] =
        await visualSignature(path.join(outputs, creative.outputPath));
    }
  }
}, 120_000);

afterAll(async () => {
  await rm(outputs, { recursive: true, force: true });
});

describe("visual regression", () => {
  it("covers every creative the campaign produces", () => {
    expect(Object.keys(signatures).sort()).toEqual(Object.keys(baselines).sort());
  });

  it.each(Object.keys(baselines))("%s matches its committed appearance", (key) => {
    const drift = compareSignatures(signatures[key], baselines[key]);
    expect(drift.meanDrift).toBeLessThanOrEqual(MAX_MEAN_DRIFT);
    expect(drift.cellsChanged).toBeLessThanOrEqual(MAX_CELLS_CHANGED);
  });

  /**
   * A regression test that cannot fail is decoration. This moves a headline by
   * a plausible amount and asserts the signature notices.
   */
  it("actually detects a layout change", async () => {
    const key = "radiance-serum/1x1/en-GB";
    const shifted = await visualSignature(
      await shiftCopyBand(path.join(outputs, "lumen-autumn-glow-de/radiance-serum/1x1/en-gb.png")),
    );
    const drift = compareSignatures(shifted, baselines[key]);

    expect(drift.meanDrift).toBeGreaterThan(MAX_MEAN_DRIFT);
    expect(drift.cellsChanged).toBeGreaterThan(MAX_CELLS_CHANGED);
  });

  it("is deterministic, so a passing baseline means something", async () => {
    const again = await runCampaign(await loadBriefFile("samples/campaign.yaml"), {
      outputRoot: outputs,
      mode: "final",
      generator: new TestDoubleHeroGenerator(),
      ratios: ["1x1"],
      locales: ["en-GB"],
    });
    const rerendered = await visualSignature(
      path.join(outputs, again.products[0].creatives[0].outputPath),
    );
    expect(compareSignatures(rerendered, baselines["radiance-serum/1x1/en-GB"]).meanDrift).toBe(0);
  }, 60_000);
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
