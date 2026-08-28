import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { costEstimate, timeSavedEstimate } from "./pricing.js";
import {
  baselineMinutes,
  type CampaignBrief,
  type CanonicalHeroAsset,
  type RatioKey,
  REQUIRED_RATIOS,
  type ValidationResult,
} from "./schema.js";
import type { SocialCopy } from "./socialCopy.js";

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

/** A product the run could not complete, and why. */
export type ProductFailure = {
  productId: string;
  productName: string;
  stage: "resolve" | "compose";
  message: string;
};

export type ProductRecord = {
  productId: string;
  productName: string;
  hero: CanonicalHeroAsset;
  creatives: CreativeRecord[];
  /**
   * Caption and hashtags per market, assembled from the brief's own approved
   * copy. One per market rather than one per creative: the words do not change
   * with the aspect ratio, and writing the same caption into twelve files would
   * be a count, not an artifact.
   */
  socialCopy: SocialCopy[];
};

/** One machine-checkable assignment requirement, answered from real records. */
export type AssignmentCheck = { id: string; passed: boolean; message: string };

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
    productsFailed: number;
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
    liveHeroGenerations: number;
  };
  /**
   * The three metrics the assessment FAQ names when asked what matters most:
   * "time saved, number of campaigns generated, and overall efficiency."
   * Reported together, in that language, rather than left for a reader to
   * assemble from the raw counters above, and shown in the console.
   *
   * Against the brief's business goals: time saved and campaigns generated are
   * goal 1 (campaign velocity); efficiency is the cost half of goal 4 (ROI).
   * The other half of goal 4 -- CTR and conversions -- is deliberately absent.
   * This pipeline never publishes, so it cannot measure them, and a fabricated
   * conversion rate would be the easiest and worst lie in the project.
   */
  successMetrics: {
    /** Illustrative, from the baseline the brief supplies. Absent without one. */
    timeSaved?: {
      minutes: number;
      /** Only when the brief states manualHourlyRateUsd. */
      usd?: number;
      baselineMinutesPerCreative: number;
      /** What that per-creative figure is made of, when the brief itemises it. */
      baselineBreakdown?: { task: string; minutes: number }[];
      basis: string;
    };
    campaignsGenerated: { campaigns: number; creatives: number; markets: number };
    efficiency: {
      /** How much output each paid call produced. The headline number. */
      creativesPerGenerationCall: number | null;
      costPerCreativeUsd: number | null;
      /** Share of heroes served from already-approved assets. */
      reuseRate: number;
      secondsPerCreative: number;
    };
  };
  /**
   * The exercise's own minimum requirements, asserted by the run rather than
   * claimed by the README. Every check is derived from records this run
   * actually produced -- an offline preview reports `passed: false`, because
   * it demonstrably has not met the "generate missing assets with a GenAI
   * image model" requirement.
   */
  assignmentProof: { passed: boolean; checks: AssignmentCheck[] };
  products: ProductRecord[];
  /** Products that failed. Empty on a clean run; the run still completes. */
  failures: ProductFailure[];
  warnings: string[];
  /**
   * Estimated spend for this run: generation calls x published list price for
   * the model used. Omitted when no verified price is known for that model.
   * An estimate from published pricing, not a billed amount.
   */
  estimatedCostUsd?: {
    generations: number;
    unitPriceUsd: number;
    totalUsd: number;
    source: string;
  };
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
    savedUsd?: number;
    hourlyRateUsd?: number;
    basis: string;
  };
};

/** Every number here is counted off the records we actually produced. */
export function createReport(args: {
  brief: CampaignBrief;
  /** The markets actually produced, which may be a subset of the brief's. */
  markets: { locale: string; message: string }[];
  products: ProductRecord[];
  failures: ProductFailure[];
  preflight: ValidationResult;
  mode: "dev" | "final";
  provider: { provider: string; model: string };
  startedAt: number;
  completedAt: number;
  warnings: string[];
}): CampaignReport {
  const { brief, markets, products, failures, preflight, mode, provider, startedAt, completedAt } =
    args;
  const creatives = products.flatMap((p) => p.creatives);

  // One pass over the heroes. Every hero figure below reads from this tally, so
  // two metrics sitting next to each other cannot disagree about the same run.
  const heroes = { reused: 0, generated: 0, generated_cached: 0, placeholder: 0 };
  for (const product of products) heroes[product.hero.source]++;

  const cost = costEstimate(provider.model, heroes.generated);
  // Only creatives that passed. Time and money "saved" were being paid out on
  // every file the run wrote, including the ones it had just declared failed --
  // a denominator of the produced set rather than the surviving set, which is
  // the same shape as every false green this project has found. Nobody saves
  // studio hours by producing an asset they cannot ship.
  const shippable = creatives.filter((c) => c.validation.status === "pass").length;
  const timeSaved = timeSavedEstimate(
    baselineMinutes(brief),
    shippable,
    completedAt - startedAt,
    brief.manualHourlyRateUsd,
  );

  return {
    campaignId: brief.id,
    campaignName: brief.name,
    region: brief.region,
    audience: brief.audience,
    message: brief.message,
    markets: markets.map((m) => ({ locale: m.locale, message: m.message })),
    mode,
    provider,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    preflight,
    metrics: {
      productsProcessed: products.length,
      productsFailed: failures.length,
      marketsProcessed: markets.length,
      approvedAssetsReused: heroes.reused,
      heroesGenerated: heroes.generated,
      heroesFromCache: heroes.generated_cached,
      heroesPlaceholder: heroes.placeholder,
      variantsCreated: creatives.length,
      validationPassed: creatives.filter((c) => c.validation.status === "pass").length,
      validationWarnings: creatives.filter((c) => c.validation.status === "warning").length,
      validationFailed: creatives.filter((c) => c.validation.status === "fail").length,
      // Heroes produced by a live model call in THIS run. A cache hit and an
      // offline placeholder are both excluded, and neither is ever a generation.
      liveHeroGenerations: heroes.generated,
    },
    successMetrics: {
      timeSaved: timeSaved && {
        minutes: timeSaved.savedMinutes,
        usd: timeSaved.savedUsd,
        baselineMinutesPerCreative: timeSaved.baselineMinutesPerCreative,
        baselineBreakdown: brief.manualBaseline,
        basis: timeSaved.basis,
      },
      campaignsGenerated: {
        campaigns: 1,
        creatives: creatives.length,
        markets: markets.length,
      },
      efficiency: {
        creativesPerGenerationCall:
          heroes.generated > 0 ? Number((creatives.length / heroes.generated).toFixed(1)) : null,
        costPerCreativeUsd: cost ? Number((cost.totalUsd / creatives.length).toFixed(5)) : null,
        reuseRate: products.length > 0 ? Number((heroes.reused / products.length).toFixed(3)) : 0,
        secondsPerCreative: Number(
          ((completedAt - startedAt) / 1000 / Math.max(1, creatives.length)).toFixed(2),
        ),
      },
    },
    assignmentProof: proveAssignment(products, brief.products.length),
    products,
    failures,
    warnings: args.warnings,
    estimatedCostUsd: cost,
    estimatedTimeSaved: timeSaved,
  };
}

/**
 * Answers the exercise's minimum requirements from the run's own records.
 *
 * Deliberately small and deliberately not a compliance framework: nine facts,
 * each one countable off the products and creatives that exist on disk. It is
 * here because "the README says so" is the weakest possible evidence, and this
 * is the strongest cheap one.
 *
 * `requested` is the count of products the BRIEF asked for, and every coverage
 * denominator below uses it rather than the products that survived. Measuring
 * against the survivors would let a run that dropped a product still prove the
 * assignment -- a three-product brief passing on the two that worked.
 */
function proveAssignment(
  products: ProductRecord[],
  requested: number,
): {
  passed: boolean;
  checks: AssignmentCheck[];
} {
  const creatives = products.flatMap((p) => p.creatives);
  const generated = products.filter(
    (p) => p.hero.source === "generated" && p.hero.generation?.provider !== "offline-placeholder",
  );
  // A cached hero came from a real model call, with full provenance -- but it
  // was not called in THIS run, so it cannot be this run's evidence. Saying
  // which of the two it is beats a bare "not met".
  const cached = products.filter((p) => p.hero.source === "generated_cached");
  const placeholders = products.filter((p) => p.hero.source === "placeholder");
  // The exercise requires the campaign message ON the post -- which means all
  // of it. Ink alone proves something drew; it does not prove the message was
  // not cut in half at the legibility floor. Both, or this check would stay
  // green over a truncated headline.
  const messageComplete = creatives.filter(
    (c) =>
      c.validation.checks.some((k) => k.id === "message.rendered" && k.status === "pass") &&
      c.validation.checks.some((k) => k.id === "message.legible" && k.status === "pass"),
  );
  const failed = creatives.filter((c) => c.validation.status === "fail");
  const warned = creatives.filter((c) => c.validation.status === "warning");

  const checks: AssignmentCheck[] = [
    {
      id: "minimum_products",
      passed: requested >= 2,
      message: `brief requests ${requested} products (minimum 2)`,
    },
    {
      id: "all_products_produced",
      passed: requested > 0 && products.length === requested,
      message: `${products.length}/${requested} requested products produced`,
    },
    ...REQUIRED_RATIOS.map((ratio) => {
      const covered = products.filter((p) => p.creatives.some((c) => c.ratio === ratio));
      return {
        id: `required_ratio_${ratio}`,
        passed: requested > 0 && covered.length === requested,
        message: `${ratio.replace("x", ":")} produced for ${covered.length}/${requested} products`,
      };
    }),
    {
      id: "real_genai_demonstrated",
      passed: generated.length > 0,
      message: generated.length
        ? `${generated.length} missing hero(es) generated by ${generated[0].hero.generation?.provider}`
        : cached.length
          ? `${cached.length} hero(es) served from a cached real generation - run with MVP_MODE=final for a live call`
          : "no missing asset was generated by a real GenAI model in this run",
    },
    {
      id: "no_placeholder_output",
      passed: placeholders.length === 0,
      message: placeholders.length
        ? `${placeholders.length} hero(es) came from the offline renderer`
        : "no offline placeholder in any output",
    },
    {
      id: "campaign_message_rasterized",
      passed: creatives.length > 0 && messageComplete.length === creatives.length,
      message: `campaign message measured complete in the pixels of ${messageComplete.length}/${creatives.length} creatives`,
    },
    {
      id: "no_failed_creative_validation",
      passed: failed.length === 0,
      // Says what it counted. "Every creative passed" was broader than
      // `failed.length === 0`: a creative carrying warnings is not a creative
      // that passed, and this check has never measured warnings.
      message: `${creatives.length - failed.length - warned.length} passed, ${warned.length} with warnings, ${failed.length} failed`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

/**
 * Keeps provenance reproducible on someone else's machine.
 *
 * An absolute path is correct at runtime and wrong in a published artifact: an
 * earlier committed report.json carried `/Users/<name>/...` all the way into
 * the repo. Anything inside the project becomes project-relative; anything
 * outside it is reduced to a filename rather than leaking a home directory.
 */
export function portablePath(absolute: string): string {
  const rel = path.relative(process.cwd(), absolute);
  return rel.startsWith("..") ? path.basename(absolute) : rel;
}

export async function writeReport(report: CampaignReport, outputRoot: string): Promise<string> {
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
