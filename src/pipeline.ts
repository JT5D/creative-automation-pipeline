import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { LookName } from "./artDirection.js";
import { resolveHero } from "./assetResolver.js";
import { composeVariant, templateFor } from "./composer.js";
import { recordRun } from "./history.js";
import { PREVIEW_MODEL } from "./pricing.js";
import { type HeroGenerator, selectGenerator } from "./providers/index.js";
import {
  type CampaignReport,
  type CreativeRecord,
  createReport,
  type ProductFailure,
  type ProductRecord,
  portablePath,
  sanitizeId,
  writeReport,
} from "./report.js";
import { type CampaignBrief, CampaignBriefSchema, type RatioKey, selectScope } from "./schema.js";
import { renderCopyFile, socialCopy } from "./socialCopy.js";
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
  /**
   * Art-direction look for this run only, overriding whatever the brief says.
   *
   * Same grain as `ratios` and `locales`: the brief states the campaign's
   * intent, and the console may try something else without editing the file. It
   * sets the look and nothing below it, so a brief that overrode an individual
   * slot keeps that override on top.
   */
  look?: LookName;
  /**
   * Preview: generate the hero at 1K on the cheapest model that can serve it.
   *
   * Cost is per GENERATION rather than per creative, so a whole 24-creative
   * preview run costs about three cents against thirteen. Iterating on art
   * direction is the expensive habit, not shipping.
   *
   * A preview is never the deliverable and does not pretend to be: 9:16 needs
   * 1080x1920 out of a square hero, so a 1K source is upscaled about 1.9x and
   * goes soft. The report says `preview`, and assignmentProof fails, for the
   * same reason the offline renderer does.
   */
  preview?: boolean;
};

/**
 * Accepts JSON or YAML text; both normalize to the same validated object.
 *
 * Validation failures are rewritten into something a marketer can act on, since
 * the person editing a brief in the console is not the person who would enjoy a
 * JSON dump of Zod issue objects.
 */
export function parseBrief(raw: string): CampaignBrief {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("The brief is empty.");

  const data = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed);
  const result = CampaignBriefSchema.safeParse(data);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const field = issue.path.join(".") || "brief";
    // Zod says "expected string, received undefined" for a field that is simply
    // absent, which is a sentence for a developer reading a stack trace, not
    // for the person editing the brief. A missing required field is the single
    // most likely thing to be wrong with a brief, so it gets said plainly.
    const missing = issue.code === "invalid_type" && /received undefined/i.test(issue.message);
    return missing ? `${field} is required and is missing` : `${field}: ${issue.message}`;
  });
  throw new Error(
    problems.length === 1
      ? `Invalid brief - ${problems[0]}`
      : `Invalid brief:\n  · ${problems.join("\n  · ")}`,
  );
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
  const mode = options.preview
    ? "preview"
    : (options.mode ?? (process.env.MVP_MODE === "final" ? "final" : "dev"));
  const warnings: string[] = [];

  const emit = (event: string, detail?: Record<string, unknown>) =>
    options.onEvent?.({ at: new Date().toISOString(), event, detail });

  // 1. Contract. An invalid brief never reaches the rest of the system.
  const brief =
    typeof rawBrief === "string" ? parseBrief(rawBrief) : CampaignBriefSchema.parse(rawBrief);
  // Applied to the validated brief rather than threaded through every call
  // below it, so there is exactly one place where "what look is this run" is
  // decided and resolveArtDirection stays the only reader of it.
  if (options.look) brief.look = options.look;
  const { ratios, markets } = selectScope(brief, options);
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

  // 3. Provider is resolved once, up front, so a misconfigured key fails the
  //    run immediately rather than after the first product has been composed.
  const generator =
    options.generator ??
    selectGenerator(process.env, options.preview ? PREVIEW_MODEL.id : options.model);
  emit("provider_selected", { provider: generator.provider, model: generator.model });

  // Cache sits under the output root, so every run's cache is scoped to it and
  // a test can never write into the project's.
  const cacheDir = path.join(outputRoot, ".cache");
  /*
   * A run that overrides the look gets its own folder, so two looks of the same
   * brief cannot overwrite each other.
   *
   * Market-level art direction is how business goal 3 - "adapt messaging,
   * offers and CREATIVE to resonate with local cultures" - is reached here:
   * select the markets, pick a look, run. Suffixed only when the look is
   * overridden, so the default path stays one hero, every market, one folder.
   */
  const campaignDir = path.join(
    outputRoot,
    options.look ? `${sanitizeId(brief.id)}-${sanitizeId(options.look)}` : sanitizeId(brief.id),
  );
  const products: ProductRecord[] = [];
  const failures: ProductFailure[] = [];

  for (const product of brief.products) {
    // Which half of the product's work was running when it threw. Only two
    // stages are distinguishable without inventing precision the catch does
    // not have: getting a hero, and everything downstream of having one.
    let stage: ProductFailure["stage"] = "resolve";
    try {
      emit("asset_resolving", { productId: product.id });

      const hero = await resolveHero(product, {
        brief,
        generator,
        mode,
        cacheDir,
        emit,
        imageSize: options.preview ? "1K" : undefined,
      });
      stage = "compose";

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
          const validation = validateCreative({
            brief,
            rendered,
            ratio,
            market,
            tpl: templateFor(ratio),
          });

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

      // The words that go beside the picture, per market. Assembled from copy
      // the brief already carries, so this costs nothing and cannot invent a
      // claim; preflight has already screened it against the legal list.
      const copy = markets.map((market) => socialCopy(brief, product, market));
      await mkdir(path.join(productDir, "copy"), { recursive: true });
      for (const post of copy) {
        await writeFile(
          path.join(productDir, "copy", `${sanitizeId(post.locale)}.txt`),
          renderCopyFile(post),
        );
      }

      products.push({
        productId: product.id,
        productName: product.name,
        socialCopy: copy,
        hero: {
          ...hero,
          // Everything published is relative: report.json has to be readable
          // on a reviewer's machine, and an absolute path is both useless
          // there and a small privacy leak.
          localPath: path.relative(outputRoot, heroCopy),
          sourceAssetPath: hero.sourceAssetPath && portablePath(hero.sourceAssetPath),
        },
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
        stage,
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
    liveHeroGenerations: report.metrics.liveHeroGenerations,
    productsFailed: failures.length,
  });

  return report;
}
