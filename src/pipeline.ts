import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveHero } from "./assetResolver.js";
import { composeVariant } from "./composer.js";
import { recordRun } from "./history.js";
import { type HeroGenerator, selectGenerator } from "./providers/index.js";
import {
  type CampaignReport,
  type CreativeRecord,
  createReport,
  type ProductFailure,
  type ProductRecord,
  sanitizeId,
  writeReport,
} from "./report.js";
import {
  type CampaignBrief,
  CampaignBriefSchema,
  RATIOS,
  type RatioKey,
  resolveMarkets,
} from "./schema.js";
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
  /** Produce only these formats. Omit for all of them. */
  ratios?: RatioKey[];
  /** Produce only these markets. Omit for every market in the brief. */
  locales?: string[];
  /** Model override for this run only. */
  model?: string;
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
  const allMarkets = resolveMarkets(brief);
  const markets = options.locales?.length
    ? allMarkets.filter((m) => options.locales?.includes(m.locale))
    : allMarkets;

  const allRatios = Object.keys(RATIOS) as RatioKey[];
  const ratios = options.ratios?.length
    ? allRatios.filter((r) => options.ratios?.includes(r))
    : allRatios;

  if (markets.length === 0) throw new Error("No markets selected");
  if (ratios.length === 0) throw new Error("No formats selected");
  emit("brief_validated", {
    campaignId: brief.id,
    products: brief.products.length,
    markets: markets.length,
    formats: ratios.length,
  });

  // 2. Everything checkable for free, checked before anything is paid for.
  const pre = await preflight(brief);
  emit("preflight_complete", { status: pre.status });
  preflightOrThrow(pre);
  for (const c of pre.checks) {
    if (c.status === "warning") warnings.push(c.message);
  }

  // 3. Provider is resolved once, and only if a hero might actually be missing.
  const generator = options.generator ?? selectGenerator(process.env, options.model);
  emit("provider_selected", { provider: generator.provider, model: generator.model });

  // Cache sits under the output root, so every run's cache is scoped to it and
  // a test can never write into the project's.
  const cacheDir = path.join(outputRoot, ".cache");
  const campaignDir = path.join(outputRoot, sanitizeId(brief.id));
  const products: ProductRecord[] = [];
  const failures: ProductFailure[] = [];

  for (const product of brief.products) {
    try {
      emit("asset_resolving", { productId: product.id });

      const hero = await resolveHero(product, { brief, generator, mode, cacheDir, emit });

      // Persist the canonical hero next to its outputs so the provenance chain
      // is inspectable on disk, not just in the report.
      const productDir = path.join(campaignDir, sanitizeId(product.id));
      await mkdir(path.join(productDir, "source"), { recursive: true });
      const heroCopyName = hero.source === "reused" ? "approved-hero" : "generated-hero";
      const heroCopy = path.join(
        productDir,
        "source",
        `${heroCopyName}${path.extname(hero.localPath) || ".png"}`,
      );
      await writeFile(heroCopy, await readFile(hero.localPath));

      const creatives: CreativeRecord[] = [];

      // One hero, then every ratio x every market. Adding a format or a market
      // multiplies the output and costs nothing -- the expensive step is done.
      for (const ratio of ratios) {
        for (const market of markets) {
          const variantStart = Date.now();
          emit("variant_composing", { productId: product.id, ratio, locale: market.locale });

          const rendered = await composeVariant({ brief, product, hero, ratio, market });
          const validation = validateCreative({ brief, rendered, ratio, market });

          const dir = path.join(productDir, ratio);
          await mkdir(dir, { recursive: true });
          const outputPath = path.join(dir, `${sanitizeId(market.locale)}.png`);
          await writeFile(outputPath, rendered.buffer);

          emit("variant_saved", {
            productId: product.id,
            ratio,
            locale: market.locale,
            status: validation.status,
            outputPath: path.relative(outputRoot, outputPath),
          });

          creatives.push({
            ratio,
            locale: market.locale,
            width: rendered.width,
            height: rendered.height,
            outputPath: path.relative(outputRoot, outputPath),
            bytes: rendered.buffer.length,
            validation,
            durationMs: Date.now() - variantStart,
          });
        }
      }

      products.push({
        productId: product.id,
        productName: product.name,
        hero: { ...hero, localPath: path.relative(outputRoot, heroCopy) },
        creatives,
      });
    } catch (error) {
      // One product failing must not lose the rest of the campaign. A client
      // running hundreds of these does not want a single provider hiccup to
      // discard every creative that did succeed.
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        productId: product.id,
        productName: product.name,
        stage: "resolve",
        message,
      });
      emit("product_failed", { productId: product.id, message: message.slice(0, 160) });
    }
  }

  if (products.length === 0) {
    throw new Error(`Every product failed. First error: ${failures[0]?.message ?? "unknown"}`);
  }

  const report = createReport({
    brief,
    markets,
    products,
    failures,
    preflight: pre,
    mode,
    provider: { provider: generator.provider, model: generator.model },
    startedAt,
    completedAt: Date.now(),
    warnings,
  });

  await writeReport(report, outputRoot);
  await recordRun(report, outputRoot);
  emit("report_written", { path: path.join(sanitizeId(brief.id), "report.json") });
  emit("complete", {
    variants: report.metrics.variantsCreated,
    generationRequests: report.metrics.generationRequests,
    productsFailed: failures.length,
  });

  return report;
}
