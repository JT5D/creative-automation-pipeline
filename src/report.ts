import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { USD_PER_IMAGE_2K } from "./providers/gemini.js";
import { resolveMarkets } from "./schema.js";
import type {
  CampaignBrief,
  CanonicalHeroAsset,
  RatioKey,
  ValidationResult,
} from "./schema.js";

export type CreativeRecord = {
  ratio: RatioKey;
  locale: string;
  width: number;
  height: number;
  outputPath: string;
  bytes: number;
  validation: ValidationResult;
  durationMs: number;
};

export type ProductRecord = {
  productId: string;
  productName: string;
  hero: CanonicalHeroAsset;
  creatives: CreativeRecord[];
};

export type CampaignReport = {
  campaignId: string;
  campaignName: string;
  region: string;
  audience: string;
  message: string;
  markets: { locale: string; message: string }[];
  mode: "dev" | "final";
  provider: { provider: string; model: string };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  preflight: ValidationResult;
  metrics: {
    productsProcessed: number;
    marketsProcessed: number;
    approvedAssetsReused: number;
    heroesGenerated: number;
    heroesFromCache: number;
    /** Rendered offline with no model call. Never counted as a generation. */
    heroesPlaceholder: number;
    variantsCreated: number;
    validationPassed: number;
    validationWarnings: number;
    validationFailed: number;
    generationRequests: number;
  };
  products: ProductRecord[];
  warnings: string[];
  /**
   * Estimated spend for this run: generation calls x published list price for
   * the model used. Omitted when no verified price is known for that model.
   * An estimate from published pricing, not a billed amount.
   */
  estimatedCostUsd?: { generations: number; unitPriceUsd: number; totalUsd: number; source: string };
  /**
   * Only present when the brief supplies manualMinutesPerCreative. It is an
   * estimate derived from that stated baseline, not a measured figure, and it
   * is labelled as such wherever it is shown.
   */
  estimatedTimeSaved?: {
    baselineMinutesPerCreative: number;
    manualMinutes: number;
    pipelineMinutes: number;
    savedMinutes: number;
    basis: string;
  };
};

/** Every number here is counted off the records we actually produced. */
export function createReport(args: {
  brief: CampaignBrief;
  products: ProductRecord[];
  preflight: ValidationResult;
  mode: "dev" | "final";
  provider: { provider: string; model: string };
  startedAt: number;
  completedAt: number;
  warnings: string[];
}): CampaignReport {
  const { brief, products, preflight, mode, provider, startedAt, completedAt } = args;
  const creatives = products.flatMap((p) => p.creatives);

  return {
    campaignId: brief.id,
    campaignName: brief.name,
    region: brief.region,
    audience: brief.audience,
    message: brief.message,
    markets: resolveMarkets(brief).map((m) => ({ locale: m.locale, message: m.message })),
    mode,
    provider,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    preflight,
    metrics: {
      productsProcessed: products.length,
    marketsProcessed: resolveMarkets(brief).length,
      approvedAssetsReused: products.filter((p) => p.hero.source === "reused").length,
      heroesGenerated: products.filter((p) => p.hero.source === "generated").length,
      heroesFromCache: products.filter((p) => p.hero.source === "generated_cached").length,
    heroesPlaceholder: products.filter((p) => p.hero.source === "placeholder").length,
      variantsCreated: creatives.length,
      validationPassed: creatives.filter((c) => c.validation.status === "pass").length,
      validationWarnings: creatives.filter((c) => c.validation.status === "warning").length,
      validationFailed: creatives.filter((c) => c.validation.status === "fail").length,
      // Only a live call counts. A cache hit is explicitly not a request.
      generationRequests: products.filter((p) => p.hero.source === "generated").length,
    },
    products,
    warnings: args.warnings,
    estimatedCostUsd: estimateCost(
      provider.model,
      products.filter((p) => p.hero.source === "generated").length,
    ),
    estimatedTimeSaved: estimateTimeSaved(
      brief.manualMinutesPerCreative,
      creatives.length,
      completedAt - startedAt,
    ),
  };
}

function estimateCost(model: string, generations: number) {
  const unitPriceUsd = USD_PER_IMAGE_2K[model];
  if (unitPriceUsd === undefined) return undefined;
  return {
    generations,
    unitPriceUsd,
    totalUsd: Number((generations * unitPriceUsd).toFixed(4)),
    source: "ai.google.dev/gemini-api/docs/pricing, 2K output, verified 2026-08-28",
  };
}

function estimateTimeSaved(
  baseline: number | undefined,
  variants: number,
  durationMs: number,
) {
  if (!baseline) return undefined;
  const manualMinutes = baseline * variants;
  const pipelineMinutes = durationMs / 60_000;
  return {
    baselineMinutesPerCreative: baseline,
    manualMinutes,
    pipelineMinutes: Number(pipelineMinutes.toFixed(3)),
    savedMinutes: Number((manualMinutes - pipelineMinutes).toFixed(2)),
    basis:
      "Illustrative estimate: manualMinutesPerCreative from the brief × variants produced, " +
      "minus measured pipeline runtime. Not a measured comparison.",
  };
}

export async function writeReport(
  report: CampaignReport,
  outputRoot: string,
): Promise<string> {
  const dir = path.join(outputRoot, sanitizeId(report.campaignId));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "report.json");
  await writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

/** Brief ids come from user input and become directory names. */
export function sanitizeId(id: string): string {
  const cleaned = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || "campaign";
}
