import { resolveArtDirection } from "./artDirection.js";
import { buildHeroPrompt, findApprovedHero } from "./assetResolver.js";
import { costEstimate, PREVIEW_MODEL, timeSavedEstimate } from "./pricing.js";
import {
  baselineMinutes,
  type CampaignBrief,
  CampaignBriefSchema,
  type RatioKey,
  selectScope,
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
  /**
   * Who the campaign is for and what it is trying to do.
   *
   * The console showed the message and nothing else, so two of the four things
   * the exercise requires a brief to carry - audience and objective - were
   * visible only by opening the YAML. They are inputs to the prompt, so a
   * reviewer reading the generated image has a right to see them next to it.
   */
  audience: string;
  objective?: string;
  /**
   * The art direction this run resolved to, and which slots the brief replaced.
   *
   * `--prompts` has printed this since the cascade shipped; the console had a
   * look picker but never showed what it produced. Control you cannot see is
   * not control, and that applies to the surface people actually demo on.
   */
  look: string;
  overriddenSlots: string[];
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
  /**
   * Price and plan the run the way `--preview` runs it: 1K on the cheapest
   * model that can serve it. The estimate has to agree with the run or the
   * guardrail is decorative, so this reads the same PREVIEW_MODEL the pipeline
   * selects rather than a second opinion about what preview costs.
   */
  preview?: boolean;
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

  // The same selection the run makes, from the same function. This is the
  // whole reason the estimate is trustworthy: it is not a parallel model of
  // the pipeline, it calls the pipeline's own decisions.
  const { ratios, markets } = selectScope(brief, options);
  const locales = markets.map((m) => m.locale);

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

  const art = resolveArtDirection(brief);
  const generations = products.filter((p) => p.action === "generate").length;
  const variants = products.length * ratios.length * locales.length;
  const model = options.preview
    ? PREVIEW_MODEL.id
    : (options.model ?? process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image");

  // Runtime is dominated by generation; composition is milliseconds per file.
  const projectedMs = generations * (options.secondsPerGeneration ?? 27) * 1000;

  return {
    campaignId: brief.id,
    campaignName: brief.name,
    audience: brief.audience,
    objective: brief.objective,
    look: art.look,
    overriddenSlots: art.overridden,
    preflight: pre,
    blocked: pre.status === "fail",
    model,
    ratios,
    locales,
    products,
    variants,
    generations,
    estimatedCostUsd: costEstimate(model, generations),
    estimatedTimeSaved: timeSavedEstimate(baselineMinutes(brief), variants, projectedMs),
  };
}
