import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { HeroGenerator } from "./providers/index.js";
import { withRetry } from "./retry.js";
import type { CampaignBrief, CanonicalHeroAsset, Product } from "./schema.js";

export type ResolveContext = {
  brief: CampaignBrief;
  generator: HeroGenerator;
  /** dev caches a successful generation; final always spends. */
  mode: "dev" | "final";
  /**
   * Where cached heroes live. Derived from the output root so a test run and a
   * real run can never share one -- the test suite was previously writing its
   * stand-in renders into the project cache, where a later real run picked them
   * up and reported them as generated.
   */
  cacheDir: string;
  emit: (event: string, detail?: Record<string, unknown>) => void;
};

/**
 * The one decision this whole product exists to make.
 *
 * If an approved hero is on disk we reuse it and spend nothing. Only when it
 * is genuinely absent do we pay a model to create one. The branch is driven
 * entirely by a real filesystem check -- delete the file and the same brief
 * takes the generate path on the next run.
 */
export async function resolveHero(
  product: Product,
  ctx: ResolveContext,
): Promise<CanonicalHeroAsset> {
  const approved = await findApprovedHero(product.approvedHeroPath);

  if (approved) {
    ctx.emit("asset_reused", { productId: product.id, path: approved });
    const meta = await sharp(approved).metadata();
    return {
      productId: product.id,
      source: "reused",
      localPath: approved,
      sourceAssetPath: approved,
      mimeType: mimeFor(approved),
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    };
  }

  const prompt = buildHeroPrompt(product, ctx.brief);
  const reference = await findApprovedHero(product.referenceAssetPath);

  // In dev, an already-paid-for hero is reused so that iterating on layout or
  // UI never costs another generation. It is labelled GENERATED · CACHED
  // everywhere it surfaces -- it is never presented as a fresh call.
  const cacheKey = hashKey(
    ctx.generator.provider,
    ctx.generator.model,
    product.id,
    prompt,
    reference ?? "",
  );
  if (ctx.mode === "dev") {
    const cached = await readCache(ctx.cacheDir, cacheKey);
    if (cached) {
      ctx.emit("asset_generated_cached", { productId: product.id });
      const meta = await sharp(cached.path).metadata();
      // A cached placeholder stays a placeholder. Only a cached real
      // generation may be reported as one.
      const cachedPlaceholder = cached.generation?.provider === "offline-placeholder";
      return {
        productId: product.id,
        source: cachedPlaceholder ? "placeholder" : "generated_cached",
        localPath: cached.path,
        mimeType: "image/png",
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        sourceAssetPath: reference,
        generation: cached.generation,
      };
    }
  }

  ctx.emit("generation_submitted", {
    productId: product.id,
    provider: ctx.generator.provider,
    model: ctx.generator.model,
    usingReference: Boolean(reference),
  });

  const generated = await withRetry(
    () =>
      ctx.generator.generateHero({
        productId: product.id,
        productName: product.name,
        campaignMessage: ctx.brief.message,
        region: ctx.brief.region,
        audience: ctx.brief.audience,
        brandName: ctx.brief.brand.name,
        prompt,
        referenceAssetPath: reference,
      }),
    {
      onRetry: (attempt, delayMs, error) =>
        ctx.emit("generation_retry", {
          productId: product.id,
          attempt,
          delayMs,
          reason: error.message.slice(0, 120),
        }),
    },
  );

  const outPath = path.join(ctx.cacheDir, `${cacheKey}.png`);
  await mkdir(ctx.cacheDir, { recursive: true });
  await writeFile(outPath, generated.bytes);

  const generation = {
    provider: generated.provider,
    operation: generated.operation,
    model: generated.model,
    prompt,
    durationMs: generated.durationMs,
    requestId: generated.requestId,
  };
  await writeFile(path.join(ctx.cacheDir, `${cacheKey}.json`), JSON.stringify(generation, null, 2));

  const meta = await sharp(outPath).metadata();
  ctx.emit("asset_generated", { productId: product.id, durationMs: generated.durationMs });

  return {
    productId: product.id,
    // A placeholder is never reported as generative output.
    source: ctx.generator.provider === "offline-placeholder" ? "placeholder" : "generated",
    localPath: outPath,
    mimeType: generated.mimeType,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    sourceAssetPath: reference,
    generation,
  };
}

/**
 * A deliberately tiny filesystem adapter. This is the seam a customer's DAM,
 * AEM, or S3 bucket replaces -- it returns a local path or nothing, and that
 * is the entire contract the pipeline depends on.
 */
export async function findApprovedHero(maybePath?: string): Promise<string | undefined> {
  if (!maybePath) return undefined;
  const resolved = path.resolve(maybePath);
  try {
    await access(resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic art direction. Pure string composition -- no LLM call, so the
 * same brief always produces the same prompt and the same cache key.
 *
 * Everything here is aimed at one goal: a hero that survives being re-cut into
 * three very different shapes. Hence centred subject, generous negative space,
 * and an explicit ban on typography the compositor is going to draw itself.
 */
export function buildHeroPrompt(product: Product, brief: CampaignBrief): string {
  if (product.generationPrompt) return product.generationPrompt;

  const tone = brief.toneOfVoice ? `Art direction tone: ${brief.toneOfVoice}.` : "";
  const objective = brief.objective ? `Campaign objective: ${brief.objective}.` : "";

  return [
    `Professional commercial advertising photography of ${product.name}`,
    `by the brand ${brief.brand.name}.`,
    `Campaign audience: ${brief.audience}. Market: ${brief.region}.`,
    objective,
    tone,
    "The product is the hero: centred, sharp, and framed with generous negative",
    "space on all sides so the image can be re-cropped to square, vertical and",
    "landscape formats without cutting the product.",
    "Clean studio lighting, soft natural shadows, calm minimal background,",
    "premium editorial colour grading.",
    "Absolutely no text, no lettering, no typography, no logos, no watermarks,",
    "and no packaging claims of any kind in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 16);
}

async function readCache(
  cacheDir: string,
  key: string,
): Promise<{ path: string; generation: CanonicalHeroAsset["generation"] } | null> {
  const imgPath = path.join(cacheDir, `${key}.png`);
  const metaPath = path.join(cacheDir, `${key}.json`);
  try {
    await access(imgPath);
    const generation = JSON.parse(await readFile(metaPath, "utf8"));
    return { path: imgPath, generation };
  } catch {
    return null;
  }
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
