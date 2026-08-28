import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHeroPrompt, findApprovedHero } from "../src/assetResolver.js";
import { safeBoundsFor, templateFor, textGeometry } from "../src/composer.js";
import { estimateCampaign } from "../src/estimate.js";
import { readInsights } from "../src/history.js";
import { loadBriefFile, parseBrief, runCampaign } from "../src/pipeline.js";
import { MODEL_OPTIONS, priceFor, REQUESTED_IMAGE_SIZE } from "../src/pricing.js";
import { selectGenerator } from "../src/providers/index.js";
import { TestDoubleHeroGenerator } from "../src/providers/placeholder.js";
import {
  type HeroGenerator,
  type HeroRequest,
  ProviderError,
  safeProviderMessage,
} from "../src/providers/types.js";
import { sanitizeId } from "../src/report.js";
import { withRetry } from "../src/retry.js";
import { RATIOS } from "../src/schema.js";
import { fitText, wrapText } from "../src/textLayout.js";
import { findProhibited, preflight } from "../src/validation.js";

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
${overrides}
`;

/** The same brief with two markets, used by localization and by the copy tests. */
const multiMarketBrief = () =>
  `${briefYaml()}
markets:
  - locale: en-GB
    message: Wake up to visibly brighter skin
    callToAction: Discover now
  - locale: de-DE
    message: Wach auf mit sichtbar strahlenderer Haut
    callToAction: Jetzt entdecken
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

  // And a real logo, so the brand-presence check has something to measure.
  // Without one the suite ran every creative past a logo rule that had nothing
  // to look at, which is exactly the hole the rule was written to close.
  await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100">' +
        '<circle cx="50" cy="50" r="30" fill="none" stroke="#F4F1EA" stroke-width="6"/>' +
        "</svg>",
    ),
  )
    .png()
    .toFile(path.join(assets, "logo.png"));
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

  it("explains what is wrong in words a marketer can act on", () => {
    // Zod's raw output is a JSON dump of issue objects; anyone editing a brief
    // in the console would have seen that instead of a sentence.
    try {
      parseBrief("id: x\nname: X\nbrand: { name: B }\nproducts: []");
      throw new Error("should have rejected");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("Invalid brief");
      expect(message).toContain("region");
      expect(message).not.toContain("{");
      expect(message).not.toContain("code");
    }
  });

  it("says so plainly when the brief is empty", () => {
    expect(() => parseBrief("   ")).toThrow(/brief is empty/i);
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

  it("art-directs differently when an approved packshot anchors the product", async () => {
    const brief = parseBrief(briefYaml());
    const withRef = buildHeroPrompt(brief.products[1], brief, true);
    const withoutRef = buildHeroPrompt(brief.products[1], brief, false);

    // No reference: the model is inventing the packaging, so any lettering it
    // draws is a fabricated claim on a regulated cosmetic.
    expect(withoutRef).toMatch(/no logos/i);
    expect(withoutRef).not.toMatch(/preserve the supplied product/i);

    // With a reference: preserving the real product is the entire point, so
    // telling it "no logos" would erase the packaging we supplied. It still has
    // to forbid INVENTED lettering -- a macro framing of a blank reference jar
    // came back carrying fabricated cosmetic claims.
    expect(withRef).toMatch(/preserve the supplied product/i);
    expect(withRef).not.toMatch(/no logos, no watermarks/i);

    // BOTH branches end with the absolute typography rule, and it is the last
    // clause in the prompt. Handed a completely blank jar, the model printed
    // "Lumen Botanicals / Overnight Recovery Cream" on it -- accurate by luck,
    // and an earlier run of the same instruction produced garbled cosmetic
    // claims. Nothing downstream reads pixels, so no check would ever see it.
    for (const prompt of [withRef, withoutRef]) {
      expect(prompt).toMatch(/TYPOGRAPHY RULE, absolute/);
      expect(prompt).toMatch(/must stay completely unlabelled/i);
      expect(prompt.trimEnd().endsWith("image can have.")).toBe(true);
    }

    // And it must not promise colour it cannot hold: the campaign light is
    // directional and dramatic by design, so the lid necessarily reads darker
    // than it does on a packshot's white sweep. Measured dE76 12.3, of which
    // 10.8 is lightness. Asking for hue is an instruction; asking for exact
    // colour is a claim nothing in this repo measures.
    expect(withRef).toMatch(/hue/i);
    expect(withRef).not.toMatch(/EXACTLY as it appears/i);
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
    expect(wrapText("Wake up to visibly brighter skin every single morning", 400, 60)).toEqual(
      lines,
    );
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
    const { blockBottom } = textGeometry(tpl, worstCase, true, "Jetzt entdecken");

    expect(tpl.logo.top).toBeGreaterThanOrEqual(safe.top);
    expect(blockBottom).toBeLessThanOrEqual(safe.bottom);
    expect(tpl.copy.left).toBeGreaterThanOrEqual(safe.left);
    expect(tpl.copy.left + tpl.copy.width).toBeLessThanOrEqual(safe.right);
  });

  /**
   * This used to pass `hasDisclaimer: false` and compare against
   * `tpl.disclaimerY`, which is a coordinate the renderer never uses on 9:16 --
   * there the legal line follows the CTA. So the one format where the two
   * elements can actually collide was the one format the check was blind to,
   * and on the other three it measured a disclaimer the scenario had removed.
   *
   * Both constraints are asserted here against the coordinates the compositor
   * itself draws on, with a disclaimer present, because that is what every
   * sample brief supplies.
   */
  it("keeps the CTA clear of the disclaimer, and the disclaimer on the canvas", () => {
    for (const ratio of Object.keys(RATIOS) as (keyof typeof RATIOS)[]) {
      const tpl = templateFor(ratio);
      const { width, height } = RATIOS[ratio];
      const worstCase = {
        lines: Array.from({ length: tpl.maxLines }, () => "X"),
        fontSize: tpl.maxFontSize,
      };
      const g = textGeometry(tpl, worstCase, true, "Jetzt entdecken");

      // The legal line is set at 24px, so it needs its own height of clearance
      // below the pill or the two touch.
      expect(g.ctaBottom + 24).toBeLessThanOrEqual(g.disclaimerY);

      // And it has to land somewhere a viewer can read it: inside the Meta
      // safe zone where one applies, inside the frame everywhere else.
      const floor = tpl.enforceSafeZone ? safeBoundsFor(width, height).bottom : height - 24;
      expect(g.disclaimerY).toBeLessThanOrEqual(floor);
    }
  });
});

describe("localization", () => {
  const multiMarket = multiMarketBrief;

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
    expect(multiReport.metrics.liveHeroGenerations).toBe(1);
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
      expect(creative.validation.checks.find((c) => c.id === "message.rendered")?.status).toBe(
        "pass",
      );
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
  const manifest = JSON.parse(readFileSync(path.resolve("samples/briefs.json"), "utf8")) as {
    file: string;
    label: string;
    expect: string;
  }[];

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
      expect(report.metrics.liveHeroGenerations).toBe(Number(generations));
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

describe("dry run", () => {
  it("reports the same reuse/generate split the real run takes, and spends nothing", async () => {
    const estimate = await estimateCampaign(parseBrief(briefYaml()));

    expect(estimate.blocked).toBe(false);
    expect(estimate.products.find((p) => p.productId === "product-a")?.action).toBe("reuse");
    expect(estimate.products.find((p) => p.productId === "product-b")?.action).toBe("generate");
    expect(estimate.generations).toBe(1);

    // The estimate must match what actually happens, or it is worthless.
    const generator = new FakeApiGenerator();
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator,
    });
    expect(report.metrics.liveHeroGenerations).toBe(estimate.generations);
    expect(report.metrics.variantsCreated).toBe(estimate.variants);
  });

  it("prices the run from the published table, per model", async () => {
    const pro = await estimateCampaign(parseBrief(briefYaml()), { model: "gemini-3-pro-image" });
    const lite = await estimateCampaign(parseBrief(briefYaml()), {
      model: "gemini-3.1-flash-lite-image",
    });

    expect(pro.estimatedCostUsd?.totalUsd).toBeCloseTo(0.134, 4);
    expect(lite.estimatedCostUsd?.totalUsd).toBeCloseTo(0.0336, 4);
    // An unpriced model must report nothing rather than guess.
    const unknown = await estimateCampaign(parseBrief(briefYaml()), { model: "some-new-model" });
    expect(unknown.estimatedCostUsd).toBeUndefined();
  });

  it("narrows the plan when formats or markets are deselected", async () => {
    const all = await estimateCampaign(parseBrief(briefYaml()));
    const narrowed = await estimateCampaign(parseBrief(briefYaml()), { ratios: ["1x1", "16x9"] });

    expect(narrowed.ratios).toEqual(["1x1", "16x9"]);
    expect(narrowed.variants).toBe(all.variants / 2);
    // Fewer formats must not change what has to be generated.
    expect(narrowed.generations).toBe(all.generations);
  });

  it("flags a non-compliant brief without calling anything", async () => {
    const estimate = await estimateCampaign(
      parseBrief(
        briefYaml().replace(
          "message: Wake up to visibly brighter skin",
          "message: A miracle that will cure dull skin",
        ),
      ),
    );
    expect(estimate.blocked).toBe(true);
    expect(estimate.preflight.status).toBe("fail");
  });
});

describe("selective production", () => {
  it("produces only the formats and markets asked for", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    expect(report.metrics.variantsCreated).toBe(2); // 2 products x 1 format x 1 market
    for (const p of report.products) {
      expect(p.creatives.every((c) => c.ratio === "1x1")).toBe(true);
    }
  });

  it("refuses an empty selection rather than silently producing nothing", async () => {
    await expect(
      runCampaign(parseBrief(briefYaml()), {
        outputRoot: outputs,
        mode: "final",
        generator: new FakeApiGenerator(),
        ratios: ["9x16"],
        locales: ["nope-XX"],
      }),
    ).rejects.toThrow(/no markets selected/i);
  });
});

describe("resilience", () => {
  /** Fails a chosen product; succeeds on the rest. */
  class PartialGenerator implements HeroGenerator {
    readonly provider = "partial";
    readonly model = "partial-1";
    private readonly inner = new TestDoubleHeroGenerator();
    constructor(private readonly failFor: string) {}
    async generateHero(input: HeroRequest) {
      if (input.productId === this.failFor) {
        throw new ProviderError("HTTP 503: model temporarily unavailable", 503);
      }
      const r = await this.inner.generateHero(input);
      return { ...r, provider: this.provider, model: this.model };
    }
  }

  it("keeps the creatives that succeeded when one product fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-partial-"));
    const brief = parseBrief(`
id: partial-run
name: Partial
region: DE
audience: A
message: M
brand: { name: B }
products:
  - { id: good-one, name: Good One }
  - { id: bad-one, name: Bad One }
`);

    const report = await runCampaign(brief, {
      outputRoot: dir,
      mode: "final",
      generator: new PartialGenerator("bad-one"),
      ratios: ["1x1"],
    });

    expect(report.metrics.productsProcessed).toBe(1);
    expect(report.metrics.productsFailed).toBe(1);
    expect(report.metrics.variantsCreated).toBe(1);
    expect(report.failures[0].productId).toBe("bad-one");
    expect(report.failures[0].message).toContain("503");

    // The creative that worked is a real file, not a casualty of the other one.
    await expect(
      stat(path.join(dir, report.products[0].creatives[0].outputPath)),
    ).resolves.toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });

  it("still fails loudly when nothing at all succeeds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-total-"));
    class AlwaysFails implements HeroGenerator {
      readonly provider = "nope";
      readonly model = "nope-1";
      async generateHero(): Promise<never> {
        throw new ProviderError("HTTP 500", 500);
      }
    }
    await expect(
      runCampaign(
        parseBrief(`
id: doomed
name: Doomed
region: DE
audience: A
message: M
brand: { name: B }
products:
  - { id: a, name: A }
  - { id: b, name: B }
`),
        {
          outputRoot: dir,
          mode: "final",
          generator: new AlwaysFails(),
          ratios: ["1x1"],
        },
      ),
    ).rejects.toThrow(/every product failed/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("retries a transient failure and gives up on a permanent one", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw new ProviderError("rate limited", 429);
      return "ok";
    };
    expect(await withRetry(flaky, { sleep: async () => {} })).toBe("ok");
    expect(calls).toBe(3);

    let permanentCalls = 0;
    const permanent = async () => {
      permanentCalls++;
      throw new ProviderError("bad request", 400);
    };
    await expect(withRetry(permanent, { sleep: async () => {} })).rejects.toThrow(/bad request/);
    // A 400 will fail identically every time; retrying only spends quota.
    expect(permanentCalls).toBe(1);
  });
});

describe("generation cache integrity", () => {
  it("never serves one provider's cached hero to another", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-cache-"));

    // Populate the cache with the offline renderer.
    const first = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "dev",
      generator: new TestDoubleHeroGenerator(),
      ratios: ["1x1"],
    });
    expect(first.products[1].hero.source).toBe("placeholder");

    // A different provider must NOT pick that entry up.
    const api = new FakeApiGenerator();
    const second = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "dev",
      generator: api,
      ratios: ["1x1"],
    });
    expect(api.calls).toBe(1);
    expect(second.products[1].hero.source).toBe("generated");
    expect(second.products[1].hero.generation?.provider).toBe("test-api");

    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a cached placeholder labelled as a placeholder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-cache2-"));
    for (let i = 0; i < 2; i++) {
      const r = await runCampaign(parseBrief(briefYaml()), {
        outputRoot: dir,
        mode: "dev",
        generator: new TestDoubleHeroGenerator(),
        ratios: ["1x1"],
      });
      expect(r.products[1].hero.source).toBe("placeholder");
      expect(r.metrics.liveHeroGenerations).toBe(0);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("scopes the cache to the output root so runs cannot pollute each other", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-cache3-"));
    const api = new FakeApiGenerator();
    await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "dev",
      generator: api,
      ratios: ["1x1"],
    });
    const entries = await readdir(path.join(dir, ".cache"));
    expect(entries.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("provider selection", () => {
  it("applies a per-run model override without touching global state", async () => {
    const before = process.env.GEMINI_IMAGE_MODEL;
    const g = selectGenerator(
      { GEMINI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      "gemini-3.1-flash-image",
    );
    expect(g.model).toBe("gemini-3.1-flash-image");
    expect(process.env.GEMINI_IMAGE_MODEL).toBe(before);
  });

  it("falls back to the offline renderer when nothing is configured", () => {
    const g = selectGenerator({} as NodeJS.ProcessEnv);
    expect(g.provider).toBe("offline-placeholder");
  });

  it("takes the only provider that is configured", () => {
    expect(selectGenerator({ GEMINI_API_KEY: "k" } as NodeJS.ProcessEnv).provider).toBe(
      "google-gemini",
    );
    expect(
      selectGenerator({
        FIREFLY_SERVICES_CLIENT_ID: "id",
        FIREFLY_SERVICES_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv).provider,
    ).toBe("adobe-firefly");
  });

  it("refuses to guess when both providers are configured", () => {
    // Firefly used to win silently here, which meant the run that mattered
    // could change provider because two variables happened to be set.
    expect(() =>
      selectGenerator({
        GEMINI_API_KEY: "k",
        FIREFLY_SERVICES_CLIENT_ID: "id",
        FIREFLY_SERVICES_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv),
    ).toThrow(/IMAGE_PROVIDER/);

    expect(
      selectGenerator({
        IMAGE_PROVIDER: "gemini",
        GEMINI_API_KEY: "k",
        FIREFLY_SERVICES_CLIENT_ID: "id",
        FIREFLY_SERVICES_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv).provider,
    ).toBe("google-gemini");
  });

  it("never offers a model that cannot produce the size the adapter asks for", () => {
    // gemini-3.1-flash-lite-image and gemini-2.5-flash-image are 1K-only
    // (ai.google.dev/gemini-api/docs/pricing, 2026-08-28). Offering either in
    // a picker that always requests 2K is a guaranteed API rejection.
    for (const m of MODEL_OPTIONS) {
      expect(m.maxImageSize).toBe(REQUESTED_IMAGE_SIZE);
    }
    expect(MODEL_OPTIONS.map((m) => m.id)).not.toContain("gemini-3.1-flash-lite-image");
    // The catalog still prices them, so a hand-set override is costed honestly.
    expect(priceFor("gemini-3.1-flash-lite-image")).toBe(0.0336);
  });

  it("redacts a provider body before it can reach the browser", () => {
    // Assembled rather than written out: a literal credential-shaped string in
    // a tracked file is exactly what the release gate's secret scan exists to
    // reject, and it should reject it even when the key is fake.
    const keyShaped = `AIza${"Sy0EXAMPLEKEYabcdefghijklmnop"}${"qrstuv"}`;
    const msg = safeProviderMessage(
      "Gemini",
      400,
      `API key not valid: ${keyShaped}. Check the header.`,
    );
    expect(msg).not.toMatch(/AIzaSy/);
    expect(msg).toContain("[redacted]");
    expect(msg).toContain("HTTP 400");
  });
});

describe("run history", () => {
  it("accumulates across runs and computes a reuse rate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-history-"));

    await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "final",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });
    await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "final",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    const insights = await readInsights(dir);
    expect(insights.runs).toBe(2);
    expect(insights.campaigns).toBe(1);
    expect(insights.creatives).toBe(4);
    expect(insights.liveHeroGenerations).toBe(2);
    // One of two heroes reused each run.
    expect(insights.reuseRate).toBeCloseTo(0.5, 2);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports an empty history without failing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cap-empty-"));
    const insights = await readInsights(dir);
    expect(insights.runs).toBe(0);
    expect(insights.reuseRate).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * The doctrine this repo is built on: a check that cannot go red is worse than
 * no check at all, because it launders an assumption into a green tick.
 *
 * Each test here supplies a genuinely broken input and asserts the check
 * notices. Two earlier false-greens were found exactly this way -- both were
 * shaped `Boolean(someInput)`, proving the brief said so rather than proving
 * the pixels did.
 */
describe("checks that can actually fail", () => {
  it("never lets the logo check go absent when a brief names no logo", async () => {
    // The two newest sample brands shipped without a lockup, and this rule
    // returned null for them -- so their creatives reported 16 of 16 checks
    // passed from a brand suite that had silently dropped the exercise's own
    // example of a brand check. An absent check reads as a passed check.
    const report = await runCampaign(parseBrief(briefYaml().replace(/^ {2}logoPath:.*$/m, "")), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    for (const creative of report.products.flatMap((p) => p.creatives)) {
      const logo = creative.validation.checks.find((c) => c.id === "brand.logo");
      expect(logo).toBeDefined();
      expect(logo?.status).toBe("warning");
    }
  });

  it("refuses a manual baseline whose line items do not add up to its total", async () => {
    // The itemised baseline exists so the time-saved figure can be argued
    // with. Two ways of writing one number is two numbers unless something
    // makes them agree.
    const honest = await preflight(
      parseBrief(
        `${briefYaml()}
manualMinutesPerCreative: 25
manualBaseline:
  - { task: Layout, minutes: 15 }
  - { task: Export, minutes: 10 }
`,
      ),
    );
    expect(honest.checks.find((c) => c.id === "brief.manualBaseline")?.status).toBe("pass");

    const drifted = await preflight(
      parseBrief(
        `${briefYaml()}
manualMinutesPerCreative: 25
manualBaseline:
  - { task: Layout, minutes: 15 }
  - { task: Export, minutes: 4 }
`,
      ),
    );
    expect(drifted.status).toBe("fail");
    expect(drifted.checks.find((c) => c.id === "brief.manualBaseline")?.message).toMatch(
      /add to 19 min but manualMinutesPerCreative says 25/,
    );
  });

  it("screens the caption for prohibited claims, not only the rendered copy", async () => {
    // The caption is published copy. It is assembled from strings the brief
    // already carries plus the product and brand names -- so a banned claim in
    // a PRODUCT NAME would have shipped clean images with a prohibited term in
    // the post body underneath them.
    const result = await preflight(
      parseBrief(briefYaml().replace("name: Overnight Cream", "name: Miracle Overnight Cream")),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "legal.prohibitedWords")?.message).toMatch(
      /miracle/i,
    );
  });

  it("writes a caption per product per market, built only from approved copy", async () => {
    const report = await runCampaign(parseBrief(multiMarketBrief()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    for (const product of report.products) {
      expect(product.socialCopy.map((c) => c.locale)).toEqual(["en-GB", "de-DE"]);
      for (const post of product.socialCopy) {
        const market = report.markets.find((m) => m.locale === post.locale);
        // That market's own signed-off message, verbatim. Nothing translated
        // at runtime, nothing paraphrased.
        expect(post.caption).toContain(market?.message);
        expect(post.caption).toContain(product.productName);
        expect(post.hashtags).toContain("#LumenBotanicals");

        // And it is on disk beside the creatives, ready to paste.
        const file = path.join(
          outputs,
          sanitizeId(report.campaignId),
          sanitizeId(product.productId),
          "copy",
          `${sanitizeId(post.locale)}.txt`,
        );
        expect(await readFile(file, "utf8")).toContain(post.hashtags.join(" "));
      }
    }
  });

  it("catches a logo that loads perfectly but renders nothing", async () => {
    // The exercise's first named bonus is "presence of logo". This file
    // decodes, resizes and composites without error -- and is fully
    // transparent, so nothing whatsoever appears in the creative. Measuring
    // Boolean(fileLoaded) reported "Brand logo composited" over it.
    const dir = await mkdtemp(path.join(tmpdir(), "cap-logo-"));
    const invisible = path.join(dir, "invisible-logo.png");
    await sharp({
      create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toFile(invisible);

    const brief = parseBrief(briefYaml());
    brief.brand.logoPath = invisible;
    const report = await runCampaign(brief, {
      outputRoot: dir,
      mode: "dev",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    const logo = report.products[0].creatives[0].validation.checks.find(
      (c) => c.id === "brand.logo",
    );
    expect(logo?.status).toBe("warning");
    expect(logo?.message).toMatch(/no logo pixels/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to call a truncated campaign message rendered", async () => {
    // The exercise is most explicit about this one: the campaign message goes
    // on the post. A headline the compositor cut in half at the legibility
    // floor is not that message, and it used to be a warning -- so the creative
    // rolled up to "warning" rather than "fail", and assignmentProof stayed
    // green over a requirement it had not met.
    const dir = await mkdtemp(path.join(tmpdir(), "cap-trunc-"));
    const brief = parseBrief(briefYaml());
    brief.message =
      "Wake up to visibly brighter skin with our clinically inspired overnight " +
      "botanical recovery complex formulated for urban professionals who want " +
      "measurable radiance without compromise or irritation of any kind";
    for (const market of brief.markets ?? []) market.message = brief.message;

    const report = await runCampaign(brief, {
      outputRoot: dir,
      mode: "dev",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    const creative = report.products[0].creatives[0];
    const legible = creative.validation.checks.find((c) => c.id === "message.legible");
    expect(legible?.status).toBe("fail");
    expect(creative.validation.status).toBe("fail");

    // And the proof must say so rather than reporting the ink and stopping.
    const proof = report.assignmentProof;
    expect(proof.passed).toBe(false);
    expect(proof.checks.find((c) => c.id === "campaign_message_rasterized")?.passed).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("passes the same check when the logo actually has ink", async () => {
    // The control. Without it the test above would also pass if the check
    // had simply been broken the other way.
    const dir = await mkdtemp(path.join(tmpdir(), "cap-logo-ok-"));
    const solid = path.join(dir, "solid-logo.png");
    await sharp({
      create: { width: 400, height: 120, channels: 4, background: "#ffffff" },
    })
      .png()
      .toFile(solid);

    const brief = parseBrief(briefYaml());
    brief.brand.logoPath = solid;
    const report = await runCampaign(brief, {
      outputRoot: dir,
      mode: "dev",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    const logo = report.products[0].creatives[0].validation.checks.find(
      (c) => c.id === "brand.logo",
    );
    expect(logo?.status).toBe("pass");
    await rm(dir, { recursive: true, force: true });
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
    expect(report.metrics.liveHeroGenerations).toBe(1);

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

  it("measures the headline separately, so CTA ink cannot vouch for it", async () => {
    // The campaign message is the requirement the exercise is most explicit
    // about. Measured against the combined text layer, a creative that drew
    // only its CTA and disclaimer would pass a check claiming the message is
    // present. These must therefore be two different measurements.
    const dir = await mkdtemp(path.join(tmpdir(), "cap-ink-"));
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: dir,
      mode: "dev",
      generator: new FakeApiGenerator(),
      ratios: ["1x1"],
    });

    const creative = report.products[0].creatives[0];
    const rendered = creative.validation.checks.find((c) => c.id === "message.rendered");
    expect(rendered?.status).toBe("pass");
    expect(rendered?.message).toMatch(/headline ink/);

    // The disclaimer is proven by its own ink now, not by the brief having
    // contained the string. This brief sets no callToAction, so that check
    // correctly reports nothing at all rather than a vacuous pass.
    expect(creative.validation.checks.find((c) => c.id === "legal.disclaimer")?.status).toBe(
      "pass",
    );
    expect(
      creative.validation.checks.find((c) => c.id === "creative.callToAction"),
    ).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
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
      mode: "dev",
      generator: new TestDoubleHeroGenerator(),
    });

    const b = report.products.find((p) => p.productId === "product-b")!;
    expect(b.hero.source).toBe("placeholder");
    expect(report.metrics.heroesPlaceholder).toBe(1);
    expect(report.metrics.heroesGenerated).toBe(0);
    // A placeholder costs nothing, so it must never inflate the spend count.
    expect(report.metrics.liveHeroGenerations).toBe(0);
  });

  it("refuses to fabricate a missing hero in final mode", async () => {
    // The exercise requires a real model for a MISSING asset. The offline
    // renderer is a setup convenience, so `final` must refuse it outright
    // rather than produce a run that looks compliant and is not.
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new TestDoubleHeroGenerator(),
    });

    // Product A is a reused approved asset and needs no provider at all.
    expect(report.products.map((p) => p.productId)).toEqual(["product-a"]);
    expect(report.failures[0].productId).toBe("product-b");
    expect(report.failures[0].message).toMatch(/requires a real GenAI provider/i);

    expect(report.metrics.heroesPlaceholder).toBe(0);
    expect(report.metrics.liveHeroGenerations).toBe(0);
    expect(report.assignmentProof.passed).toBe(false);
    expect(
      report.assignmentProof.checks.find((c) => c.id === "real_genai_demonstrated")?.passed,
    ).toBe(false);
  });

  it("proves the exercise's own requirements off the records it produced", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "final",
      generator: new FakeApiGenerator(),
    });

    expect(report.assignmentProof.passed).toBe(true);
    // The three the exercise names, plus the facts that make them meaningful.
    for (const id of [
      "minimum_products",
      "required_ratio_1x1",
      "required_ratio_9x16",
      "required_ratio_16x9",
      "real_genai_demonstrated",
      "no_placeholder_output",
      "campaign_message_rasterized",
      "no_failed_creative_validation",
      "all_products_produced",
    ]) {
      expect(report.assignmentProof.checks.find((c) => c.id === id)?.passed).toBe(true);
    }
  });

  it("lets a brief replace the art-direction standard, and defaults it otherwise", async () => {
    // Three widening escape hatches, all optional: styleBar replaces the
    // standard, artDirection replaces the set, generationPrompt replaces
    // everything. The point of the default is that most briefs set none.
    const base = parseBrief(briefYaml());
    const product = base.products[1];

    const fallback = buildHeroPrompt(product, base, false);
    expect(fallback).toContain("Award-winning cinematic advertising photography");

    const styled = parseBrief(
      `${briefYaml()}styleBar: Flat lay graphic poster, hard flash, no depth of field.\n`,
    );
    const overridden = buildHeroPrompt(product, styled, false);
    expect(overridden).toContain("Flat lay graphic poster");
    expect(overridden).not.toContain("Award-winning cinematic");
    // Nothing downstream may re-assert a look the brief just replaced.
    expect(overridden).not.toContain("Cinematic campaign photograph");
  });

  it("cannot prove the assignment when a requested product never got produced", async () => {
    // The fifth false green this project has found, and the same shape as the
    // other four: the proof measured the products that SURVIVED, so a run that
    // dropped one still counted every ratio as fully covered. A three-product
    // brief passed on the two that worked.
    //
    // GenAI is genuinely demonstrated here and nothing that was produced is
    // wrong, so every other check is green. The dropped product is the only
    // defect, which is exactly why the old code could not see it.
    class DropsOneProduct extends FakeApiGenerator {
      async generateHero(input: HeroRequest) {
        if (input.productId === "product-c") throw new Error("provider refused");
        return super.generateHero(input);
      }
    }

    const report = await runCampaign(
      parseBrief(briefYaml("  - id: product-c\n    name: Repair Balm")),
      { outputRoot: outputs, mode: "final", generator: new DropsOneProduct() },
    );

    expect(report.products).toHaveLength(2);
    expect(report.failures.map((f) => f.productId)).toEqual(["product-c"]);
    expect(report.metrics.liveHeroGenerations).toBe(1);

    // The checks that would have hidden it, now measured against the brief.
    const check = (id: string) => report.assignmentProof.checks.find((c) => c.id === id);
    expect(check("all_products_produced")?.passed).toBe(false);
    expect(check("all_products_produced")?.message).toBe("2/3 requested products produced");
    for (const ratio of ["1x1", "9x16", "16x9"]) {
      expect(check(`required_ratio_${ratio}`)?.passed).toBe(false);
      expect(check(`required_ratio_${ratio}`)?.message).toContain("2/3");
    }

    // Everything that DID run is still honestly green -- the proof is not
    // failing because the pipeline broke, only because it is incomplete.
    expect(check("real_genai_demonstrated")?.passed).toBe(true);
    expect(check("no_failed_creative_validation")?.passed).toBe(true);
    expect(report.assignmentProof.passed).toBe(false);
  });

  it("publishes provenance paths that work on another machine", async () => {
    const report = await runCampaign(parseBrief(briefYaml()), {
      outputRoot: outputs,
      mode: "dev",
      generator: new FakeApiGenerator(),
    });
    const reused = report.products.find((p) => p.hero.source === "reused")!;
    expect(reused.hero.sourceAssetPath).toBeDefined();
    expect(reused.hero.sourceAssetPath).not.toMatch(/^\//);
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
