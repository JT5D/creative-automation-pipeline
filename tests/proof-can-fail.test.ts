import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBrief, runCampaign } from "../src/pipeline.js";
import { PlaceholderHeroGenerator, TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import type { HeroGenerator, HeroRequest } from "../src/providers/types.js";
import { type CampaignReport, createReport, type ProductRecord } from "../src/report.js";
import { RATIOS } from "../src/schema.js";
import { preflight } from "../src/validation.js";

/**
 * The proof has to be able to say no.
 *
 * `report.json -> assignmentProof` is the headline claim of this submission:
 * eleven checks that assert the exercise's own requirements off the records the
 * run produced. A check that cannot go red asserts nothing, and this repo has
 * shipped two of those already -- one green over a palette-quantised creative
 * for forty-one tests, one green with the guard it tested deleted.
 *
 * So every check gets a case here that breaks exactly the thing it names and
 * asserts that check, and only that check, turns false. If a case cannot be
 * written, the check measures less than its label says and the label is wrong.
 */

let workdir: string;
let assets: string;
let outputs: string;
let baseline: CampaignReport;

class FakeApiGenerator implements HeroGenerator {
  readonly provider = "test-api";
  readonly model = "fake-model-1";
  private readonly renderer = new TestDoubleHeroGenerator();
  async generateHero(input: HeroRequest) {
    const result = await this.renderer.generateHero(input);
    return { ...result, provider: this.provider, model: this.model };
  }
}

const briefYaml = () => `
id: proof-campaign
name: Proof Campaign
region: Germany (DACH)
audience: Urban professionals 28-45
message: Wake up to visibly brighter skin
brand:
  name: Lumen Botanicals
  logoPath: ${assets}/logo.png
  primaryColor: "#14322B"
  secondaryColor: "#C9A227"
  disclaimer: Individual results may vary.
  prohibitedWords: [cure, miracle, clinically proven]
products:
  - id: product-a
    name: Radiance Serum
    approvedHeroPath: ${assets}/approved-hero.png
  - id: product-b
    name: Overnight Cream
`;

/** Rebuilds the report from records the test has deliberately damaged. */
function reportFrom(
  products: ProductRecord[],
  over: Partial<{ requested: number; preview: true }> = {},
) {
  const brief = parseBrief(briefYaml());
  if (over.requested) brief.products = brief.products.slice(0, over.requested);
  return createReport({
    brief,
    markets: baseline.markets,
    products,
    failures: [],
    preflight: baseline.preflight,
    mode: over.preview ? "preview" : "final",
    provider: baseline.provider,
    startedAt: 0,
    completedAt: 1000,
    warnings: [],
  });
}

const clone = (): ProductRecord[] => structuredClone(baseline.products);
const check = (report: CampaignReport, id: string) =>
  report.assignmentProof.checks.find((c) => c.id === id);

/**
 * The named check must go red, and nothing else may -- otherwise the case
 * proved that damage is detectable, not that THIS check detects it.
 *
 * `alsoExpected` is for the corruptions that genuinely trip more than one
 * check. Losing a product is the honest example: the brief still asked for it,
 * so the product count, all three crop counts and the generation it would have
 * paid for are all really absent. Listing them is the assertion; leaving them
 * unlisted would be the bug.
 */
function onlyFailure(report: CampaignReport, id: string, alsoExpected: string[] = []) {
  expect(check(report, id)?.passed, `${id} should have gone red`).toBe(false);
  expect(report.assignmentProof.passed).toBe(false);
  const others = report.assignmentProof.checks
    .filter((c) => c.id !== id && !c.passed)
    .map((c) => c.id);
  expect(others.sort()).toEqual([...alsoExpected].sort());
}

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "cap-proof-"));
  assets = path.join(workdir, "assets");
  outputs = path.join(workdir, "outputs");
  await mkdir(assets, { recursive: true });

  await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#8a9a7b" } })
    .png()
    .toFile(path.join(assets, "approved-hero.png"));
  await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100">' +
        '<circle cx="50" cy="50" r="30" fill="none" stroke="#F4F1EA" stroke-width="6"/></svg>',
    ),
  )
    .png()
    .toFile(path.join(assets, "logo.png"));

  baseline = await runCampaign(parseBrief(briefYaml()), {
    outputRoot: outputs,
    mode: "final",
    generator: new FakeApiGenerator(),
  });
}, 120_000);

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("assignmentProof, one corruption per check", () => {
  it("passes all eleven on an undamaged run, so every case below starts from green", () => {
    expect(baseline.assignmentProof.checks).toHaveLength(11);
    expect(baseline.assignmentProof.passed).toBe(true);
  });

  it("minimum_products: goes red on a one-product brief", () => {
    const report = reportFrom(clone().slice(0, 1), { requested: 1 });
    expect(check(report, "minimum_products")?.passed).toBe(false);
    expect(check(report, "minimum_products")?.message).toMatch(/1 products/);
  });

  it("all_products_produced: goes red when a product is dropped from the output", () => {
    // The denominator is what the BRIEF asked for, so losing a product to a
    // provider fault cannot be hidden by measuring against the survivors.
    const report = reportFrom(clone().slice(0, 1));
    onlyFailure(report, "all_products_produced", [
      "required_ratio_1x1",
      "required_ratio_9x16",
      "required_ratio_16x9",
      // product-b is the one with no approved hero, so it is also the run's
      // only live generation. Dropping it removes the exercise's evidence.
      "real_genai_demonstrated",
    ]);
  });

  for (const ratio of ["1x1", "9x16", "16x9"] as const) {
    it(`required_ratio_${ratio}: goes red when that crop is missing`, () => {
      const products = clone();
      for (const product of products) {
        product.creatives = product.creatives.filter((c) => c.ratio !== ratio);
      }
      onlyFailure(reportFrom(products), `required_ratio_${ratio}`);
    });
  }

  it("ships_at_full_resolution: goes red on a creative exported at the wrong size", () => {
    // The check this file was written to catch. It used to read `mode` alone,
    // so its label promised a pixel dimension nothing measured -- a creative
    // could ship at any size at all and it stayed green.
    const products = clone();
    const victim = products[0].creatives[0];
    victim.height = RATIOS[victim.ratio].height - 40;
    const report = reportFrom(products);
    onlyFailure(report, "ships_at_full_resolution");
    expect(check(report, "ships_at_full_resolution")?.message).toMatch(/wrong size/);
  });

  it("ships_at_full_resolution: goes red on a preview run, whose hero is 1K", () => {
    const report = reportFrom(clone(), { preview: true });
    expect(check(report, "ships_at_full_resolution")?.passed).toBe(false);
    expect(check(report, "ships_at_full_resolution")?.message).toMatch(/upscaled/);
  });

  it("real_genai_demonstrated: goes red when nothing was generated this run", () => {
    const products = clone();
    for (const product of products) {
      product.hero.source = "reused";
      product.hero.generation = undefined;
    }
    onlyFailure(reportFrom(products), "real_genai_demonstrated");
  });

  it("no_placeholder_output: goes red on a real run served by the offline renderer", async () => {
    // Not a mutated record: the offline renderer actually produces these files.
    // This is the exercise's hard requirement -- a missing asset must come from
    // a GenAI model -- and the failure it guards is a run that looks compliant
    // because the placeholder is competent.
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: path.join(workdir, "offline"),
      mode: "dev",
      generator: new PlaceholderHeroGenerator(),
    });
    expect(check(report, "no_placeholder_output")?.passed).toBe(false);
    expect(check(report, "real_genai_demonstrated")?.passed).toBe(false);
    expect(report.assignmentProof.passed).toBe(false);
  }, 120_000);

  it("campaign_message_rasterized: goes red when the headline is not legible in the pixels", () => {
    const products = clone();
    const victim = products[0].creatives[0];
    const legible = victim.validation.checks.find((c) => c.id === "message.legible");
    if (legible) legible.status = "fail";
    // Kept at "warning" so no_failed_creative_validation stays green and this
    // case isolates the one check it is about.
    victim.validation.status = "warning";
    onlyFailure(reportFrom(products), "campaign_message_rasterized");
  });

  it("distinct_output_files: goes red when two creatives write to one path", () => {
    const products = clone();
    products[0].creatives[1].outputPath = products[0].creatives[0].outputPath;
    onlyFailure(reportFrom(products), "distinct_output_files");
  });

  it("no_failed_creative_validation: goes red on one failed creative", () => {
    const products = clone();
    products[0].creatives[0].validation.status = "fail";
    onlyFailure(reportFrom(products), "no_failed_creative_validation");
  });
});

describe("the gates upstream of the proof", () => {
  it("a prohibited claim stops the run before a credit is spent", async () => {
    // There is no assignmentProof case for legal copy because a brief carrying
    // one never reaches a report: preflight refuses it, which is the stronger
    // outcome and the reason the bonus check is worth having.
    const result = await preflight(
      parseBrief(briefYaml().replace("name: Overnight Cream", "name: Miracle Cure Cream")),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "legal.prohibitedWords")?.message).toMatch(
      /miracle|cure/i,
    );
  });

  it("a missing logo is reported, not silently omitted", async () => {
    const result = await preflight(
      parseBrief(briefYaml().replace(/^ {2}logoPath:.*$/m, `  logoPath: ${assets}/absent.png`)),
    );
    const logo = result.checks.find((c) => c.id === "brand.logoFile");
    expect(logo?.status).not.toBe("pass");
  });
});
