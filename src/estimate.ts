import { buildHeroPrompt, findApprovedHero } from "./assetResolver.js";
import { costEstimate, timeSavedEstimate } from "./pricing.js";
import {
  type CampaignBrief,
  CampaignBriefSchema,
  RATIOS,
  type RatioKey,
  resolveMarkets,
  type ValidationResult,
} from "./schema.js";
import { preflight } from "./validation.js";

export type PlannedProduct = {
  productId: string;
  productName: string;
  action: "reuse" | "generate";
  /** The approved asset we found, when reusing. */
  sourceAssetPath?: string;
  /** True when a packshot exists to anchor the product's identity. */
  usingReference: boolean;
  /**
   * The exact prompt this product would be generated from, assembled the way
   * the run assembles it. Present only when the action is "generate".
   *
   * Here so the thing being paid for can be read before it is paid for. It was
   * previously only visible by adding a console.log, which meant the one
   * decision with a real cost attached was the least inspectable in the system.
   */
  prompt?: string;
};

export type CampaignEstimate = {
  campaignId: string;
  campaignName: string;
  preflight: ValidationResult;
  blocked: boolean;
  model: string;
  ratios: RatioKey[];
  locales: string[];
  products: PlannedProduct[];
  variants: number;
  generations: number;
  estimatedCostUsd?: ReturnType<typeof costEstimate>;
  estimatedTimeSaved?: ReturnType<typeof timeSavedEstimate>;
};

export type EstimateOptions = {
  model?: string;
  ratios?: RatioKey[];
  locales?: string[];
  /** Baseline seconds per generation, for the time estimate only. */
  secondsPerGeneration?: number;
};

/**
 * Answers "what will this cost, and what will I get" without spending anything.
 *
 * It resolves exactly the way the pipeline does -- the same `findApprovedHero`
 * on the same filesystem -- so the reuse/generate split it reports is the split
 * that will actually happen, not a guess. Nothing is generated and no provider
 * is constructed.
 */
export async function estimateCampaign(
  rawBrief: unknown,
  options: EstimateOptions = {},
): Promise<CampaignEstimate> {
  const brief: CampaignBrief =
    typeof rawBrief === "string"
      ? CampaignBriefSchema.parse((await import("./pipeline.js")).parseBrief(rawBrief))
      : CampaignBriefSchema.parse(rawBrief);

  const pre = await preflight(brief);

  const allRatios = Object.keys(RATIOS) as RatioKey[];
  const ratios = options.ratios?.length
    ? allRatios.filter((r) => options.ratios?.includes(r))
    : allRatios;

  const markets = resolveMarkets(brief);
  const locales = options.locales?.length
    ? markets.filter((m) => options.locales?.includes(m.locale)).map((m) => m.locale)
    : markets.map((m) => m.locale);

  const products: PlannedProduct[] = [];
  for (const product of brief.products) {
    const approved = await findApprovedHero(product.approvedHeroPath);
    const reference = await findApprovedHero(product.referenceAssetPath);
    products.push({
      productId: product.id,
      productName: product.name,
      action: approved ? "reuse" : "generate",
      sourceAssetPath: approved,
      usingReference: !approved && Boolean(reference),
      // Only for the products that would actually be paid for.
      prompt: approved ? undefined : buildHeroPrompt(product, brief, Boolean(reference)),
    });
  }

  const generations = products.filter((p) => p.action === "generate").length;
  const variants = products.length * ratios.length * locales.length;
  const model = options.model ?? process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";

  // Runtime is dominated by generation; composition is milliseconds per file.
  const projectedMs = generations * (options.secondsPerGeneration ?? 27) * 1000;

  return {
    campaignId: brief.id,
    campaignName: brief.name,
    preflight: pre,
    blocked: pre.status === "fail",
    model,
    ratios,
    locales,
    products,
    variants,
    generations,
    estimatedCostUsd: costEstimate(model, generations),
    estimatedTimeSaved: timeSavedEstimate(brief.manualMinutesPerCreative, variants, projectedMs),
  };
}
