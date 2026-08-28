import { z } from "zod";

/**
 * The campaign brief is the single input contract for the pipeline.
 * JSON and YAML both normalize into this exact object, so the rest of the
 * system never has to care which format the marketer handed us.
 */
const ProductSchema = z.object({
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

  /**
   * The entire prompt for this one product, replacing everything.
   *
   * The last escape hatch, and the widest. `look` and `artDirection` cover the
   * cases anyone should normally need; this exists for the product whose art
   * direction has nothing to do with the campaign's, and it deliberately still
   * cannot reach the two locked slots - composition is appended from the crop
   * arithmetic and the typography rule is appended last, because a bare prompt
   * is exactly the input that produced invented packaging claims.
   */
  generationPrompt: z.string().optional(),
});

const BrandSchema = z.object({
  name: z.string().min(1),
  logoPath: z.string().optional(),
  primaryColor: z.string().default("#111111"),
  secondaryColor: z.string().default("#FFFFFF"),
  disclaimer: z.string().optional(),
  /** Legal/MLR terms that must never appear in campaign copy. */
  prohibitedWords: z.array(z.string()).default([]),
  /**
   * Headline typeface, by family name.
   *
   * Typography is brand identity in exactly the way colour is, so a brand that
   * can declare primaryColor should be able to declare its voice too. Omitted,
   * the creatives use the bundled display face.
   *
   * The named family must be bundled in assets/fonts -- preflight verifies it
   * and says so if not, because fontconfig's answer to an unknown family is a
   * silent substitution, not an error.
   */
  headlineFont: z.string().optional(),
});

/**
 * One target market. Copy is supplied per market by the people accountable for
 * it -- translation is data, not a runtime model call, because localized claims
 * carry legal weight and need human sign-off.
 */
const MarketSchema = z.object({
  locale: z.string().min(1),
  name: z.string().optional(),
  message: z.string().min(1),
  callToAction: z.string().optional(),
  disclaimer: z.string().optional(),
});

/**
 * Brief ids come from user input and become directory names, which is why this
 * lives with the contract rather than with the reporting: it is the function
 * that decides what a brief is allowed to collide with.
 */
export function sanitizeId(id: string): string {
  const cleaned = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || "campaign";
}

/** Reports the first value that two entries map onto, or null when all differ. */
function firstCollision<T>(items: T[], key: (item: T) => string): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

export const CampaignBriefSchema = z
  .object({
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
     * The campaign's set: one physical world every product is photographed in.
     *
     * Without this the prompt describes a generic surface, so each product's
     * hero samples its own set independently and a two-product campaign comes
     * back as two unrelated stock photographs -- different room, different light,
     * different palette. A real campaign is one shoot. Supplying it once here is
     * what makes every hero in the campaign belong to the same one.
     */
    /**
     * The named look this campaign is shot in. One word, and the rest is chosen:
     * light, set, grade, optics, quality standard. Omitted, a campaign gets
     * `daylight`, the house style. Looks live in src/artDirection.ts.
     */
    look: z.enum(["daylight", "nocturne", "nordic"]).optional(),

    /**
     * Art direction, overriding individual slots of the look.
     *
     * A bare string is the SET, which is all this field has ever meant, so every
     * brief written before looks existed still says what it said. The object form
     * reaches the rest: light, grade, optics, materials, integrity.
     *
     * This grain exists because the old one caused a defect. The fragrance brief
     * asked for "a single low raking light and soft falloff into black" and the
     * pipeline silently prepended "soft natural window daylight, warm, with open
     * bounce fill" - two contradictory lighting instructions in one prompt,
     * because the only hatch that existed reached the set and nothing else.
     *
     * Composition and typography are absent on purpose and cannot be overridden.
     * Composition is derived from the crop arithmetic rather than from taste, and
     * overriding it slices the product in half. Typography is the rule that stops
     * a blank jar coming back printed with invented claims on a regulated
     * cosmetic, which has already happened once.
     */
    artDirection: z
      .union([
        z.string(),
        z.object({
          standard: z.string().optional(),
          optics: z.string().optional(),
          light: z.string().optional(),
          set: z.string().optional(),
          grade: z.string().optional(),
          materials: z.string().optional(),
          integrity: z.string().optional(),
        }),
      ])
      .optional(),
    /**
     * Overrides the standard the hero is shot to. Optional, because the default
     * is the suggestion: a campaign that says nothing gets art direction chosen
     * for it, and only a team with an opinion has to express one.
     */
    /**
     * Documented baseline for the "manual time saved" figure. Reported only
     * when supplied, and always labelled as an estimate from this number --
     * never invented.
     *
     * Prefer `manualBaseline` below, which says what the number is made of.
     */
    manualMinutesPerCreative: z.number().positive().optional(),

    /**
     * The same baseline, itemised.
     *
     * "25 minutes per creative" is one opaque number carrying the entire time-
     * saved claim, and the first thing anyone senior asks is what is in it. The
     * honest answer is that a human has to state it either way -- so let them
     * state the steps instead of the total, and derive the total by adding up.
     * Nothing here is measured by this pipeline and nothing is invented by it;
     * the line items are the client's assumption, and now they are visible and
     * arguable rather than folded into a single figure.
     *
     * When both forms are present preflight requires them to agree, so the total
     * cannot drift away from the work it claims to represent.
     */
    manualBaseline: z
      .array(z.object({ task: z.string().min(1), minutes: z.number().positive() }))
      .optional(),
    /**
     * Loaded cost of the studio hour this pipeline replaces. Optional and
     * deliberately without a default: money saved is only reported when a
     * human states the rate, because a plausible-looking guess here would be
     * the easiest number in the project to fake.
     */
    manualHourlyRateUsd: z.number().positive().optional(),

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
  })
  /**
   * "at least two DIFFERENT products" is the exercise's wording, and until this
   * existed only the count was enforced. Two products sharing an id - or two
   * whose ids merely sanitize to the same directory, like "Product A!" and
   * "Product A?" - wrote into the same folder, and the second silently
   * overwrote the first. The run then reported 8 creatives with 4 files on
   * disk, every validation green, and the assignment proof passing.
   *
   * The same hazard exists one level down: two markets sharing a locale write
   * the same <locale>.png.
   *
   * Refusing it here makes the collision unrepresentable and costs nothing,
   * rather than detecting the damage after it is done.
   */
  .superRefine((brief, ctx) => {
    const product = firstCollision(brief.products, (p) => sanitizeId(p.id));
    if (product) {
      ctx.addIssue({
        code: "custom",
        path: ["products"],
        message: `two products share the output folder "${product}" - ids must be different, and different after being made filesystem-safe`,
      });
    }
    const locale = firstCollision(brief.markets ?? [], (m) => sanitizeId(m.locale));
    if (locale) {
      ctx.addIssue({
        code: "custom",
        path: ["markets"],
        message: `two markets share the locale "${locale}" - each market writes ${locale}.png and would overwrite the other`,
      });
    }
  });

export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;
export type Market = z.infer<typeof MarketSchema>;

/**
 * Collapses the single-market and multi-market forms into one list, so the
 * pipeline only ever deals with an array of markets.
 */
/**
 * Minutes per creative the brief claims a human would spend.
 *
 * The itemised form wins when it is present, because it is the one a reader
 * can argue with. Preflight refuses a brief where the two forms disagree, so
 * this can never quietly pick a different number than the one on display.
 */
export function baselineMinutes(brief: CampaignBrief): number | undefined {
  if (brief.manualBaseline?.length) {
    return Number(brief.manualBaseline.reduce((sum, item) => sum + item.minutes, 0).toFixed(2));
  }
  return brief.manualMinutesPerCreative;
}

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

/**
 * The three the exercise names: "at least three aspect ratios (e.g., 1:1,
 * 9:16, 16:9)". 4:5 is delivered as well because it is the highest-performing
 * feed format, but only these three are load-bearing for compliance, and
 * `assignmentProof` in the report checks for exactly them.
 */
export const REQUIRED_RATIOS: RatioKey[] = ["1x1", "9x16", "16x9"];

/**
 * Which formats and markets a run will actually produce.
 *
 * pipeline.ts and estimate.ts both need this and both had their own copy of
 * it. estimate exists to PREDICT pipeline, so two implementations of the very
 * thing it predicts made their agreement coincidental: a change to one would
 * have made the dry run quietly wrong about the run it was quoting for, and
 * the test that compares them would have had to be wrong in the same way to
 * notice. One function, both callers.
 *
 * It throws on an empty selection rather than producing nothing, and it does
 * so here so the estimate refuses exactly what the run refuses.
 */
export function selectScope(
  brief: CampaignBrief,
  request: { ratios?: RatioKey[]; locales?: string[] } = {},
): { ratios: RatioKey[]; markets: Market[] } {
  const allRatios = Object.keys(RATIOS) as RatioKey[];
  const ratios = request.ratios?.length
    ? allRatios.filter((r) => request.ratios?.includes(r))
    : allRatios;

  const allMarkets = resolveMarkets(brief);
  const markets = request.locales?.length
    ? allMarkets.filter((m) => request.locales?.includes(m.locale))
    : allMarkets;

  if (markets.length === 0) throw new Error("No markets selected");
  if (ratios.length === 0) throw new Error("No formats selected");
  return { ratios, markets };
}

export type ValidationCheck = {
  id: string;
  status: "pass" | "warning" | "fail";
  message: string;
};

export type ValidationResult = {
  status: "pass" | "warning" | "fail";
  checks: ValidationCheck[];
};
