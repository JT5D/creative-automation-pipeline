import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { GenerationUnavailableError, type HeroGenerator } from "./providers/index.js";
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

  // The assignment's hard requirement is that a MISSING asset is produced by a
  // real GenAI image model. The offline renderer exists so a fresh clone runs
  // without an account -- it is not a generator, and letting it serve this
  // branch in `final` would produce a run that looks compliant and is not.
  // Reused approved assets still need no provider at all; only this branch does.
  if (ctx.mode === "final" && ctx.generator.provider === "offline-placeholder") {
    throw new GenerationUnavailableError(
      "Final mode requires a real GenAI provider for missing assets. Configure a " +
        "billing-enabled Gemini API key or an entitled Adobe Firefly Services project.",
    );
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
 * This is written as a photographic brief rather than a description, because
 * that is the difference between a stock-looking render and something a brand
 * would run. Every clause below is a decision a photographer or retoucher would
 * actually make on a beauty shoot:
 *
 *   optics    a long macro at a closed aperture, focus stacked -- the whole
 *             product sharp front to back. Shallow depth of field looks
 *             cinematic and destroys the packaging detail a brand is paying for.
 *   light     large soft key at 45 degrees, bounce fill opposite, a narrow
 *             kicker to draw an edge and lift the product off the background.
 *   set       honed stone or matte plaster, seamless tonal falloff.
 *   material  frosted glass has to transmit light correctly; a lacquered cap
 *             needs a crisp specular roll-off or it reads as untextured 3D.
 *   contents  the vessel is CLOSED and opaque. This one is load-bearing: asked
 *             for an open or translucent jar, the model renders the cream
 *             inside, and at 2K it comes out lumpy and curdled -- the single
 *             worst artefact in the first version of these creatives.
 *   retouch   catalogue standard, stated explicitly, because "professional"
 *             alone does not remove dust, fingerprints or warped ellipses.
 *
 * Reference is the category standard set by premium beauty campaigns -- the
 * craft conventions, not anyone's imagery. Style is not copyrightable and none
 * is reproduced; every pixel here is generated from this brief.
 */
export function buildHeroPrompt(product: Product, brief: CampaignBrief): string {
  if (product.generationPrompt) return product.generationPrompt;

  // The brief's prose already ends its own sentences; re-punctuating it gave
  // "never hype..", which is the kind of thing a model happily renders around.
  const sentence = (text?: string) => (text ? text.trim().replace(/\.*$/, "") : "");
  const tone = brief.toneOfVoice ? `Art direction: ${sentence(brief.toneOfVoice)}.` : "";
  const objective = brief.objective ? `Campaign objective: ${sentence(brief.objective)}.` : "";

  return [
    `Premium beauty campaign photograph of ${product.name} by ${brief.brand.name}.`,
    `Audience: ${brief.audience}. Market: ${brief.region}.`,
    objective,
    tone,

    // Optics -- the whole product sharp, not a shallow-focus mood shot.
    "Shot on a 100mm macro lens at f/9, focus stacked so the entire product is",
    "critically sharp from front to back. Tripod, no motion blur.",

    // Light -- named positions, controlled speculars.
    "Lighting is soft and directional from the upper left, with open fill from",
    "the right and a narrow highlight raking the product's edge to separate it",
    "from the background. Highlights are controlled and rolled off, never blown;",
    "shadows are soft and open. The lighting is felt, not seen: no softbox,",
    "reflector, light stand, modifier or any studio equipment appears in frame.",

    // Set and colour.
    "The product stands on a honed stone or matte plaster surface against a",
    "seamless background with a gentle tonal gradient. Restrained tonal colour",
    "grade, sympathetic to the brand palette without tinting the product itself.",

    // Material truth -- where AI product shots usually fail.
    "Materials must read as real: frosted glass transmits light correctly with a",
    "crisp polished rim, and the cap is smooth lacquered metal or resin with a",
    "clean specular roll-off and a precise machined edge.",

    // The decisive constraint.
    "The container is CLOSED with its cap fully seated, and is opaque: the",
    "contents are NOT visible. Do not render cream, lotion, product texture or",
    "any substance inside or on the vessel.",

    // Composition, so one hero survives every crop.
    // Width, not height, is the binding constraint: a 9:16 crop of a square
    // discards ~41% of the width, so anything wider than about half the frame
    // gets its edges sliced. This is the clause that keeps one generation
    // usable across every channel format.
    "WIDE SHOT. The camera is pulled well back and the product is SMALL and",
    "distant in a large empty set -- a single small jar alone on a wide expanse",
    "of surface. The product occupies only the central third of the image and",
    "is surrounded by a large amount of empty space on every side. Most of this",
    "picture is background. Do not fill the frame with the product; do not crop",
    "it; the entire product including its base is visible with room to spare.",

    // Retouch standard, stated rather than implied.
    "Retouched to catalogue standard: dust-free, fingerprint-free, symmetrical,",
    "circular openings drawn as true undistorted ellipses. No lumps, no curdling,",
    "no smears, no double lids, no warped geometry, no visible seams, and no",
    "second product, prop or duplicate of the item anywhere in the frame.",

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
