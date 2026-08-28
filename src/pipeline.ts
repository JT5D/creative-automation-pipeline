import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveHero } from "./assetResolver.js";
import { composeVariant } from "./composer.js";
import { selectGenerator, type HeroGenerator } from "./providers/index.js";
import {
  createReport,
  sanitizeId,
  writeReport,
  type CampaignReport,
  type CreativeRecord,
  type ProductRecord,
} from "./report.js";
import { CampaignBriefSchema, RATIOS, type CampaignBrief, type RatioKey } from "./schema.js";
import { preflight, preflightOrThrow, validateCreative } from "./validation.js";

export type PipelineEvent = {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
};

export type RunOptions = {
  outputRoot?: string;
  mode?: "dev" | "final";
  generator?: HeroGenerator;
  onEvent?: (event: PipelineEvent) => void;
};

/** Accepts JSON or YAML text; both normalize to the same validated object. */
export function parseBrief(raw: string): CampaignBrief {
  const trimmed = raw.trim();
  const data = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed);
  return CampaignBriefSchema.parse(data);
}

export async function loadBriefFile(file: string): Promise<CampaignBrief> {
  return parseBrief(await readFile(file, "utf8"));
}

/**
 * The whole product, top to bottom.
 *
 * Read it once and the architecture is obvious: resolve a hero per product
 * (reuse or generate), then turn that one hero into every channel format
 * deterministically. The expensive, non-deterministic step happens once per
 * product; everything after it is pure transformation.
 */
export async function runCampaign(
  rawBrief: unknown,
  options: RunOptions = {},
): Promise<CampaignReport> {
  const startedAt = Date.now();
  const outputRoot = options.outputRoot ?? path.resolve("outputs");
  const mode = options.mode ?? (process.env.MVP_MODE === "final" ? "final" : "dev");
  const warnings: string[] = [];

  const emit = (event: string, detail?: Record<string, unknown>) =>
    options.onEvent?.({ at: new Date().toISOString(), event, detail });

  // 1. Contract. An invalid brief never reaches the rest of the system.
  const brief =
    typeof rawBrief === "string" ? parseBrief(rawBrief) : CampaignBriefSchema.parse(rawBrief);
  emit("brief_validated", { campaignId: brief.id, products: brief.products.length });

  // 2. Everything checkable for free, checked before anything is paid for.
  const pre = await preflight(brief);
  emit("preflight_complete", { status: pre.status });
  preflightOrThrow(pre);
  for (const c of pre.checks) {
    if (c.status === "warning") warnings.push(c.message);
  }

  // 3. Provider is resolved once, and only if a hero might actually be missing.
  const generator = options.generator ?? selectGenerator();
  emit("provider_selected", { provider: generator.provider, model: generator.model });

  const campaignDir = path.join(outputRoot, sanitizeId(brief.id));
  const products: ProductRecord[] = [];

  for (const product of brief.products) {
    emit("asset_resolving", { productId: product.id });

    const hero = await resolveHero(product, { brief, generator, mode, emit });

    // Persist the canonical hero next to its outputs so the provenance chain
    // is inspectable on disk, not just in the report.
    const productDir = path.join(campaignDir, sanitizeId(product.id));
    await mkdir(path.join(productDir, "source"), { recursive: true });
    const heroCopyName =
      hero.source === "reused" ? "approved-hero" : "generated-hero";
    const heroCopy = path.join(
      productDir,
      "source",
      `${heroCopyName}${path.extname(hero.localPath) || ".png"}`,
    );
    await writeFile(heroCopy, await readFile(hero.localPath));

    const creatives: CreativeRecord[] = [];

    for (const ratio of Object.keys(RATIOS) as RatioKey[]) {
      const variantStart = Date.now();
      emit("variant_composing", { productId: product.id, ratio });

      const rendered = await composeVariant({ brief, product, hero, ratio });
      const validation = validateCreative({ brief, product, rendered, ratio });

      const dir = path.join(productDir, ratio);
      await mkdir(dir, { recursive: true });
      const outputPath = path.join(dir, "final.png");
      await writeFile(outputPath, rendered.buffer);

      emit("variant_saved", {
        productId: product.id,
        ratio,
        status: validation.status,
        outputPath: path.relative(outputRoot, outputPath),
      });

      creatives.push({
        ratio,
        width: rendered.width,
        height: rendered.height,
        outputPath: path.relative(outputRoot, outputPath),
        bytes: rendered.buffer.length,
        validation,
        durationMs: Date.now() - variantStart,
      });
    }

    products.push({
      productId: product.id,
      productName: product.name,
      hero: { ...hero, localPath: path.relative(outputRoot, heroCopy) },
      creatives,
    });
  }

  const report = createReport({
    brief,
    products,
    preflight: pre,
    mode,
    provider: { provider: generator.provider, model: generator.model },
    startedAt,
    completedAt: Date.now(),
    warnings,
  });

  await writeReport(report, outputRoot);
  emit("report_written", { path: path.join(sanitizeId(brief.id), "report.json") });
  emit("complete", {
    variants: report.metrics.variantsCreated,
    generationRequests: report.metrics.generationRequests,
  });

  return report;
}
