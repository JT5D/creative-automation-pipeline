import { z } from "zod";

/**
 * The campaign brief is the single input contract for the pipeline.
 * JSON and YAML both normalize into this exact object, so the rest of the
 * system never has to care which format the marketer handed us.
 */
export const ProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),

  /**
   * A finished, brand-approved campaign hero image.
   * Present  -> we REUSE it and spend nothing.
   * Absent   -> we generate the hero with a real GenAI model.
   */
  approvedHeroPath: z.string().optional(),

  /**
   * An approved product packshot. Never used as a campaign hero directly, but
   * when the hero is missing this is handed to the model as an identity anchor
   * so the product is composited into a new scene rather than hallucinated.
   */
  referenceAssetPath: z.string().optional(),

  /** Art direction for this specific product. Optional; a default is derived. */
  generationPrompt: z.string().optional(),
});

export const BrandSchema = z.object({
  name: z.string().min(1),
  logoPath: z.string().optional(),
  primaryColor: z.string().default("#111111"),
  secondaryColor: z.string().default("#FFFFFF"),
  disclaimer: z.string().optional(),
  /** Legal/MLR terms that must never appear in campaign copy. */
  prohibitedWords: z.array(z.string()).default([]),
});

/**
 * One target market. Copy is supplied per market by the people accountable for
 * it -- translation is data, not a runtime model call, because localized claims
 * carry legal weight and need human sign-off.
 */
export const MarketSchema = z.object({
  locale: z.string().min(1),
  name: z.string().optional(),
  message: z.string().min(1),
  callToAction: z.string().optional(),
  disclaimer: z.string().optional(),
});

export const CampaignBriefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),

  region: z.string().min(1),
  audience: z.string().min(1),
  message: z.string().min(1),

  /**
   * The 4A's brief standard reduces to who / what / why / where / success.
   * audience=who, message=what, region=where. These cover why and success.
   * All optional, so a minimal brief stays minimal.
   */
  objective: z.string().optional(),
  /** Rendered into every creative. Every real social ad has one. */
  callToAction: z.string().optional(),
  /** Feeds the deterministic art-direction prompt. */
  toneOfVoice: z.string().optional(),
  /**
   * Documented baseline for the "manual time saved" figure. Reported only
   * when supplied, and always labelled as an estimate from this number --
   * never invented.
   */
  manualMinutesPerCreative: z.number().positive().optional(),

  locale: z.string().optional(),

  /**
   * Target markets. Every market multiplies the creative count and costs
   * nothing extra -- the hero is generated once and localized copy is
   * composited per market. Omit it and the brief runs as a single market
   * built from the fields above.
   */
  markets: z.array(MarketSchema).optional(),

  brand: BrandSchema,
  products: z.array(ProductSchema).min(2, "A campaign needs at least 2 products"),
});

export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;
export type Market = z.infer<typeof MarketSchema>;

/**
 * Collapses the single-market and multi-market forms into one list, so the
 * pipeline only ever deals with an array of markets.
 */
export function resolveMarkets(brief: CampaignBrief): Market[] {
  if (brief.markets?.length) return brief.markets;
  return [
    {
      locale: brief.locale ?? "en",
      message: brief.message,
      callToAction: brief.callToAction,
      disclaimer: brief.brand.disclaimer,
    },
  ];
}
export type Product = z.infer<typeof ProductSchema>;
export type Brand = z.infer<typeof BrandSchema>;

/**
 * The architectural seam of this system.
 *
 * Asset origin is a boundary concern. A reused approved asset and a freshly
 * generated one both collapse into this single shape, and everything
 * downstream -- composition, validation, export, reporting -- is deterministic
 * and completely source-agnostic from here on.
 */
export type CanonicalHeroAsset = {
  productId: string;
  source: "reused" | "generated" | "generated_cached" | "placeholder";

  localPath: string;
  mimeType: string;
  width: number;
  height: number;

  /** Set when source === "reused": the approved file we found on disk. */
  sourceAssetPath?: string;

  /** Set when the hero was produced by a model. Never invented. */
  generation?: {
    provider: string;
    operation: "text-to-image" | "image-reference" | "object-composite";
    model?: string;
    prompt: string;
    durationMs: number;
    requestId?: string;
  };
};

export const RATIOS = {
  "1x1": { width: 1080, height: 1080, label: "1:1 · Feed" },
  "4x5": { width: 1080, height: 1350, label: "4:5 · Portrait feed" },
  "9x16": { width: 1080, height: 1920, label: "9:16 · Story / Reel" },
  "16x9": { width: 1920, height: 1080, label: "16:9 · Landscape" },
} as const;

export type RatioKey = keyof typeof RATIOS;

export type ValidationCheck = {
  id: string;
  status: "pass" | "warning" | "fail";
  message: string;
};

export type ValidationResult = {
  status: "pass" | "warning" | "fail";
  checks: ValidationCheck[];
};
