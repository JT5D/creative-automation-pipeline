import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHeroPrompt, findApprovedHero } from "../src/assetResolver.js";
import { safeBoundsFor, templateFor, textBlockBottom } from "../src/composer.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import type { HeroGenerator, HeroRequest } from "../src/providers/types.js";
import { loadBriefFile, parseBrief, runCampaign } from "../src/pipeline.js";
import { sanitizeId } from "../src/report.js";
import { RATIOS } from "../src/schema.js";
import { findProhibited, preflight } from "../src/validation.js";
import { fitText, wrapText } from "../src/textLayout.js";

/**
 * Reports as a real provider so the pipeline takes the "generated" path.
 * The offline placeholder deliberately does not, which is what the separate
 * placeholder test below asserts.
 */
class FakeApiGenerator implements HeroGenerator {
  readonly provider = "test-api";
  readonly model = "fake-model-1";
  calls = 0;
  private readonly renderer = new TestDoubleHeroGenerator();

  async generateHero(input: HeroRequest) {
    this.calls++;
    const result = await this.renderer.generateHero(input);
    return { ...result, provider: this.provider, model: this.model };
  }
}

let workdir: string;
let assets: string;
let outputs: string;

const briefYaml = (overrides = "") => `
id: test-campaign
name: Test Campaign
region: Germany (DACH)
audience: Urban professionals 28-45
message: Wake up to visibly brighter skin
brand:
  name: Lumen Botanicals
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
${overrides}
`;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "cap-test-"));
  assets = path.join(workdir, "assets");
  outputs = path.join(workdir, "outputs");
  await mkdir(assets, { recursive: true });

  // A real 2048x2048 image on disk stands in for the approved campaign hero.
  await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: "#8a9a7b" },
  })
    .png()
    .toFile(path.join(assets, "approved-hero.png"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("brief contract", () => {
  it("accepts YAML and JSON identically", () => {
    const fromYaml = parseBrief(briefYaml());
    const fromJson = parseBrief(JSON.stringify(fromYaml));
    expect(fromJson).toEqual(fromYaml);
  });

  it("rejects a brief with fewer than two products", () => {
    const oneProduct = `
id: x
name: X
region: DE
audience: A
message: M
brand: { name: B }
products:
  - { id: only, name: Only }
`;
    expect(() => parseBrief(oneProduct)).toThrow(/at least 2 products/i);
  });

  it("rejects a brief missing a required campaign field", () => {
    expect(() => parseBrief(briefYaml().replace("region: Germany (DACH)\n", ""))).toThrow();
  });
});

describe("legal + brand preflight", () => {
  it("matches prohibited terms on word boundaries only", () => {
    expect(findProhibited("this will cure you", ["cure"])).toEqual(["cure"]);
    expect(findProhibited("a secure formula", ["cure"])).toEqual([]);
    expect(findProhibited("CLINICALLY PROVEN results", ["clinically proven"])).toHaveLength(1);
  });

  it("fails preflight when campaign copy carries a prohibited claim", async () => {
    const brief = parseBrief(
      briefYaml().replace(
        "message: Wake up to visibly brighter skin",
        "message: The miracle that will cure dull skin",
      ),
    );
    const result = await preflight(brief);
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "legal.prohibitedWords")?.status).toBe("fail");
  });

  it("passes preflight on compliant copy", async () => {
    const result = await preflight(parseBrief(briefYaml()));
    expect(result.status).not.toBe("fail");
  });
});

describe("asset resolution", () => {
  it("finds an approved hero that exists on disk", async () => {
    expect(await findApprovedHero(path.join(assets, "approved-hero.png"))).toBeTruthy();
  });

  it("returns undefined for a missing or unset path", async () => {
    expect(await findApprovedHero(path.join(assets, "nope.png"))).toBeUndefined();
    expect(await findApprovedHero(undefined)).toBeUndefined();
  });

  it("builds a deterministic prompt that bans baked-in typography", () => {
    const brief = parseBrief(briefYaml());
    const prompt = buildHeroPrompt(brief.products[1], brief);
    expect(prompt).toContain("Overnight Cream");
    expect(prompt).toMatch(/no text/i);
    expect(prompt).toBe(buildHeroPrompt(brief.products[1], brief)); // stable
  });
});

describe("text layout", () => {
  it("wraps deterministically and never exceeds the line budget", () => {
    const lines = wrapText("Wake up to visibly brighter skin every single morning", 400, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(wrapText("Wake up to visibly brighter skin every single morning", 400, 60)).toEqual(lines);
  });

  it("reports failure instead of shrinking copy below the legibility floor", () => {
    const long = "word ".repeat(200);
    const fit = fitText(long, 300, 3, 80, 40);
    expect(fit.fits).toBe(false);
    expect(fit.fontSize).toBe(40);
  });
});

describe("output paths", () => {
  it("sanitizes ids that become directory names", () => {
    expect(sanitizeId("../../etc/passwd")).not.toContain("..");
    expect(sanitizeId("Campaign DE/2026")).toBe("campaign-de-2026");
    expect(sanitizeId("!!!")).toBe("campaign");
  });
});

describe("ratio templates", () => {
  it("keeps panel-format hero crops near square so the product is not sliced", () => {
    // 9:16 is deliberately full-bleed, per Meta's guidance that the safe zone
    // restricts text and logos rather than the photograph.
    for (const ratio of ["1x1", "16x9"] as const) {
      const { hero } = templateFor(ratio);
      const aspect = hero.width / hero.height;
      expect(aspect).toBeGreaterThan(0.9);
      expect(aspect).toBeLessThan(1.1);
    }
  });

  it("keeps the 9:16 copy inside the Meta safe zone even in the worst case", () => {
    // Meta reserves 14% top / 35% bottom / 6% sides on 9:16 placements.
    // The worst case is the maximum number of lines at the maximum font size;
    // if that fits, every shorter headline fits too.
    const { width, height } = RATIOS["9x16"];
    const tpl = templateFor("9x16");
    const safe = safeBoundsFor(width, height);

    expect(safe).toEqual({ top: 269, bottom: 1248, left: 65, right: 1015 });

    const worstCase = {
      lines: Array.from({ length: tpl.maxLines }, () => "X"),
      fontSize: tpl.maxFontSize,
    };
    const bottom = textBlockBottom(tpl, worstCase, true, "Jetzt entdecken");

    expect(tpl.logo.top).toBeGreaterThanOrEqual(safe.top);
    expect(bottom).toBeLessThanOrEqual(safe.bottom);
    expect(tpl.copy.left).toBeGreaterThanOrEqual(safe.left);
    expect(tpl.copy.left + tpl.copy.width).toBeLessThanOrEqual(safe.right);
  });

  it("keeps the CTA clear of the disclaimer in every format", () => {
    for (const ratio of Object.keys(RATIOS) as (keyof typeof RATIOS)[]) {
      const tpl = templateFor(ratio);
      const worstCase = {
        lines: Array.from({ length: tpl.maxLines }, () => "X"),
        fontSize: tpl.maxFontSize,
      };
      const bottom = textBlockBottom(tpl, worstCase, false, "Jetzt entdecken");
      expect(bottom).toBeLessThan(tpl.disclaimerY);
    }
  });
});

describe("localization", () => {
  const multiMarket = () =>
    briefYaml() +
    `
markets:
  - locale: en-GB
    message: Wake up to visibly brighter skin
    callToAction: Discover now
  - locale: de-DE
    message: Wach auf mit sichtbar strahlenderer Haut
    callToAction: Jetzt entdecken
`;

  it("multiplies creatives per market without any extra generation", async () => {
    const single = new FakeApiGenerator();
    const singleReport = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: single,
    });

    const multi = new FakeApiGenerator();
    const multiReport = await runCampaign(parseBrief(multiMarket()), {
      outputRoot: outputs,
      mode: "final",
      generator: multi,
    });

    expect(singleReport.metrics.marketsProcessed).toBe(1);
    expect(multiReport.metrics.marketsProcessed).toBe(2);
    expect(multiReport.metrics.variantsCreated).toBe(singleReport.metrics.variantsCreated * 2);

    // The whole point: twice the output, identical spend.
    expect(multi.calls).toBe(single.calls);
    expect(multiReport.metrics.generationRequests).toBe(1);
  });

  it("writes one file per locale and rasterizes that market's own copy", async () => {
    const report = await runCampaign(parseBrief(multiMarket()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    const locales = new Set(report.products[0].creatives.map((c) => c.locale));
    expect(locales).toEqual(new Set(["en-GB", "de-DE"]));

    for (const creative of report.products[0].creatives) {
      const abs = path.join(outputs, creative.outputPath);
      expect(creative.outputPath).toContain(creative.locale.toLowerCase());
      expect((await stat(abs)).size).toBeGreaterThan(1000);
      expect(creative.validation.checks.find((c) => c.id === "message.rendered")?.status).toBe("pass");
    }
  });

  it("screens prohibited claims in every market, not just the default", async () => {
    const badFrench =
      briefYaml() +
      `
markets:
  - locale: en-GB
    message: Wake up to visibly brighter skin
  - locale: de-DE
    message: Das Wunder das alles cure
`;
    const result = await preflight(parseBrief(badFrench));
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "legal.prohibitedWords")?.status).toBe("fail");
  });
});

describe("the sample brief library", () => {
  /**
   * Each sample advertises what it will do. If a brief drifts from its own
   * description the library becomes a sales pitch, so the claims are asserted
   * against real runs.
   */
  const manifest = JSON.parse(
    readFileSync(path.resolve("samples/briefs.json"), "utf8"),
  ) as { file: string; label: string; expect: string }[];

  it("lists every brief that exists, and every listed brief exists", async () => {
    const listed = manifest.map((m) => m.file).sort();
    const onDisk = (await readdir(path.resolve("samples")))
      .filter((f) => (f.endsWith(".yaml") || f.endsWith(".json")) && f !== "briefs.json")
      .sort();
    expect(listed).toEqual(onDisk);
  });

  it.each(manifest.filter((m) => !m.expect.includes("blocked")))(
    "$label produces exactly what it advertises",
    async ({ file, expect: claim }) => {
      const [, variants] = claim.match(/(\d+) creatives/) ?? [];
      const [, generations] = claim.match(/(\d+) generation/) ?? [];

      const report = await runCampaign(await loadBriefFile(`samples/${file}`), {
        outputRoot: outputs,
        mode: "final",
        generator: new FakeApiGenerator(),
      });

      expect(report.metrics.variantsCreated).toBe(Number(variants));
      expect(report.metrics.generationRequests).toBe(Number(generations));
      expect(report.metrics.validationFailed).toBe(0);
    },
  );

  it("blocks the non-compliant brief before any spend", async () => {
    const counting = new FakeApiGenerator();
    await expect(
      runCampaign(await loadBriefFile("samples/campaign-legal-fail.yaml"), {
        outputRoot: outputs,
        mode: "final",
        generator: counting,
      }),
    ).rejects.toThrow(/preflight failed/i);
    expect(counting.calls).toBe(0);
  });
});

describe("end-to-end campaign run", () => {
  it("reuses one hero, generates the other, and writes every channel variant", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final", // bypass cache so the generator is genuinely exercised
      generator: new FakeApiGenerator(),
    });

    expect(report.metrics.productsProcessed).toBe(2);
    expect(report.metrics.approvedAssetsReused).toBe(1);
    expect(report.metrics.heroesGenerated).toBe(1);
    // Derived, not hardcoded: adding a format or a market must never add cost.
    const expectedVariants = 2 * Object.keys(RATIOS).length * report.metrics.marketsProcessed;
    expect(report.metrics.variantsCreated).toBe(expectedVariants);
    expect(report.metrics.generationRequests).toBe(1);

    const a = report.products.find((p) => p.productId === "product-a")!;
    const b = report.products.find((p) => p.productId === "product-b")!;
    expect(a.hero.source).toBe("reused");
    expect(a.hero.sourceAssetPath).toContain("approved-hero.png");
    expect(b.hero.source).toBe("generated");
    expect(b.hero.generation?.provider).toBe("test-api");

    // Every declared output is a real file at exactly the declared size.
    for (const product of report.products) {
      for (const creative of product.creatives) {
        const abs = path.join(outputs, creative.outputPath);
        expect((await stat(abs)).size).toBeGreaterThan(1000);

        const meta = await sharp(abs).metadata();
        const expected = RATIOS[creative.ratio];
        expect([meta.width, meta.height]).toEqual([expected.width, expected.height]);
        expect(creative.validation.status).not.toBe("fail");
      }
    }
  });

  it("proves the message was rasterized into pixels, not just declared", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    for (const product of report.products) {
      for (const creative of product.creatives) {
        const check = creative.validation.checks.find((c) => c.id === "message.rendered");
        expect(check?.status).toBe("pass");
      }
    }
  });

  it("writes a report whose numbers match the files on disk", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    const onDisk = JSON.parse(
      await readFile(path.join(outputs, sanitizeId(report.campaignId), "report.json"), "utf8"),
    );
    expect(onDisk.metrics).toEqual(report.metrics);

    const declared = report.products.flatMap((p) => p.creatives.map((c) => c.outputPath));
    expect(declared).toHaveLength(onDisk.metrics.variantsCreated);
    for (const rel of declared) {
      await expect(stat(path.join(outputs, rel))).resolves.toBeTruthy();
    }
  });

  it("emits real pipeline events in causal order", async () => {
    const events: string[] = [];
    await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
      onEvent: (e) => events.push(e.event),
    });

    expect(events[0]).toBe("brief_validated");
    expect(events).toContain("asset_reused");
    expect(events).toContain("asset_generated");
    expect(events.at(-1)).toBe("complete");
    expect(events.indexOf("preflight_complete")).toBeLessThan(
      events.indexOf("generation_submitted"),
    );
  });

  it("never reports the offline placeholder as generative output", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new TestDoubleHeroGenerator(),
    });

    const b = report.products.find((p) => p.productId === "product-b")!;
    expect(b.hero.source).toBe("placeholder");
    expect(report.metrics.heroesPlaceholder).toBe(1);
    expect(report.metrics.heroesGenerated).toBe(0);
    // A placeholder costs nothing, so it must never inflate the spend count.
    expect(report.metrics.generationRequests).toBe(0);
  });

  it("refuses to spend on generation when preflight fails", async () => {
    const counting = new FakeApiGenerator();

    const bad = parseBrief(
      briefYaml().replace(
        "message: Wake up to visibly brighter skin",
        "message: A miracle that will cure dull skin",
      ),
    );

    await expect(
      runCampaign(bad, { outputRoot: outputs, mode: "final", generator: counting }),
    ).rejects.toThrow(/preflight failed/i);
    expect(counting.calls).toBe(0);
  });
});
