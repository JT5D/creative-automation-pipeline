import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COMPOSITION, resolveArtDirection, TYPOGRAPHY_RULE } from "./artDirection.js";
import { GenerationUnavailableError, type HeroGenerator } from "./providers/index.js";
import { withRetry } from "./retry.js";
import type { CampaignBrief, CanonicalHeroAsset, Product } from "./schema.js";

export type ResolveContext = {
  brief: CampaignBrief;
  generator: HeroGenerator;
  /** dev caches a successful generation; final always spends; preview is cheap. */
  mode: "dev" | "final" | "preview";
  /** 1K for a preview, 2K for anything that ships. */
  imageSize?: "1K" | "2K";
  /**
   * Where cached heroes live. Derived from the output root so a test run and a
   * real run can never share one: a suite writing stand-in renders into the
   * project cache means a later real run picks them up and reports them as
   * generated.
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

  // Resolved first: the art direction changes depending on whether we are
  // preserving a real product or inventing one.
  const reference = await findApprovedHero(product.referenceAssetPath);
  const prompt = buildHeroPrompt(product, ctx.brief, Boolean(reference));

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
  // A preview caches like dev: the whole point is cheap iteration, and paying
  // twice for the same look is the opposite of that.
  if (ctx.mode !== "final") {
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
        imageSize: ctx.imageSize,
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
 * One camera set-up, described as a framing rather than an angle.
 *
 * The campaign path generates ONE hero and crops it, so every format is the
 * same photograph. Coverage is what that gives up, and this is what buying it
 * back costs: one paid generation per set-up, only when a person asks.
 *
 * The prompt is short, leads with "keep everything, change only the camera",
 * and is anchored on THE HERO rather than the packshot, so set, light and grade
 * are inherited from the image instead of re-described. One degree of freedom.
 *
 * Boundary worth knowing before promising it to a client: this model
 * RECOMPOSES. It can crop, close in, pull back, tilt, occlude and change what
 * the frame is about. It cannot orbit to reveal geometry the reference never
 * showed - "from behind" and "focus pulled" both returned the reference frame
 * (drift 0.14 and 0.15, against 1.6 to 5.0 for the nine that work) and were
 * deleted. Orbiting needs several reference images, which this model accepts,
 * so it is a brief-and-assets change rather than a different architecture.
 */
export type Shot = { id: string; label: string; framing: string };

export const SHOT_SET: Shot[] = [
  {
    id: "crop",
    label: "Cropped",
    framing:
      "a tight crop that deliberately cuts the product at the frame edge, so " +
      "only part of it is in shot and the composition is built on what is left out",
  },
  {
    id: "macro",
    label: "Macro detail",
    framing:
      "an extreme close-up on surface detail alone - the shoulder, the rim, the " +
      "texture of the material - with the form of the product no longer readable",
  },
  {
    id: "wide",
    label: "Wide establishing",
    framing:
      "a wide establishing shot with the product small in the frame and the set " +
      "and its light doing the work, the environment as the subject",
  },
  {
    id: "overhead",
    label: "Overhead",
    framing:
      "an extreme bird's-eye perspective looking straight down from directly " +
      "above, the product flat in a wide field of surface",
  },
  {
    id: "worm",
    label: "Low angle",
    framing:
      "a low worm's-eye view from below the surface line, looking up at the " +
      "product so it towers against the background",
  },
  {
    id: "dutch",
    label: "Canted",
    framing:
      "a canted dutch angle with the horizon tilted well off level, the frame " +
      "deliberately unsettled",
  },
  {
    id: "through",
    label: "Through foreground",
    framing:
      "a shot taken through an out-of-focus foreground element that partly " +
      "occludes the product, the lens looking past it",
  },
  // The three below move the FOCUS and the SUBJECT OF ATTENTION rather than the
  // camera position. A real shoot covers the light and the surface as well as
  // the product, and this is also the axis the model is reliably good at: it
  // cannot orbit to reveal an unseen side, but it can rack focus and re-weight
  // what the frame is about.
  {
    id: "light",
    label: "Light study",
    framing:
      "a frame about the light rather than the product: the shadow pattern and " +
      "the falloff across the wall are the subject, the product incidental at " +
      "the edge of it",
  },
  {
    id: "surface",
    label: "Surface detail",
    framing:
      "a frame about the set itself - the grain and pitting of the stone, the " +
      "texture of the wall - with the product present only as a soft shape " +
      "beyond the plane of focus",
  },
];

/**
 * The fixed opening every shot prompt begins with, verbatim.
 *
 * "Keep the style and subject details similar and modify the camera" is doing
 * all the work: it tells the model that everything it can see is correct and
 * one thing is not. Rewriting it into our own voice is the failure mode this
 * replaced - the moment the sentence starts describing the scene again, the
 * model starts redesigning the scene.
 */
const SHOT_PREFIX =
  "Using the provided image, keep the style and subject details similar and " +
  "modify the camera to match this:";

/**
 * A camera variant of a hero that already exists.
 *
 * Deliberately NOT built from buildHeroPrompt. That function describes a scene
 * from nothing; this one changes a single property of a scene the model is
 * looking at, and mixing the two is exactly what stopped the last version
 * working. The only clause carried over is the typography rule, because a model
 * handed a blank product will letter it whatever else the prompt says.
 */
export function buildShotPrompt(shot: Shot): string {
  return [
    `${SHOT_PREFIX} ${shot.framing}.`,
    "Keep the product itself, its packaging, its colour and the set exactly as",
    "they appear in the provided image. Change only the camera and what it is",
    "focused on. Change the composition significantly while holding the style,",
    "the light and the grade identical to the reference.",
    TYPOGRAPHY_RULE,
  ].join(" ");
}

/**
 * Deterministic art direction. Pure string composition -- no LLM call, so the
 * same brief always produces the same prompt and the same cache key.
 *
 * Written as a photographic brief rather than a description, because that is
 * the difference between a stock render and something a brand would run. Each
 * clause is a decision a photographer would actually make:
 *
 *   optics    long macro, closed aperture, focus stacked -- the whole product
 *             sharp. Shallow depth of field destroys the packaging detail.
 *   light     soft key at 45 degrees, bounce fill, a narrow kicker for edge
 *             separation -- and no equipment in frame, or it renders the softbox.
 *   material  frosted glass must transmit light; a lacquered cap needs a crisp
 *             specular roll-off or it reads as untextured 3D.
 *   contents  the vessel is CLOSED and opaque. Load-bearing: asked for an open
 *             jar the model renders the cream, and at 2K it comes out curdled.
 *   retouch   catalogue standard, stated -- "professional" alone does not
 *             remove dust, fingerprints or warped ellipses.
 *
 * Composition is derived from the crop rather than chosen: docs/CREATIVE_STANDARDS.md
 * section 7. The reference is the category's craft conventions, not anyone's
 * imagery -- no style is reproduced and every pixel is generated from this brief.
 */
export function buildHeroPrompt(
  product: Product,
  brief: CampaignBrief,
  /** True when an approved packshot is being sent as an identity anchor. */
  hasReference = false,
): string {
  // The widest hatch, and it no longer bypasses the locks.
  //
  // A custom prompt replaces the art direction, not the two constraints that
  // are not art direction. Returning the brief's string alone would let a
  // product opt out of the typography rule, which is the only thing between a
  // blank jar and invented claims on a regulated cosmetic.
  if (product.generationPrompt) {
    return [product.generationPrompt.trim(), COMPOSITION, TYPOGRAPHY_RULE].join(" ");
  }

  // Which product this is, so the set rotates within the look rather than
  // every product in the campaign landing on the same ledge.
  const productIndex = Math.max(
    0,
    brief.products.findIndex((p) => p.id === product.id),
  );
  const { slots } = resolveArtDirection(brief, productIndex);

  // The brief's prose already ends its own sentences; re-punctuating it gave
  // "never hype..", which is the kind of thing a model happily renders around.
  const sentence = (text?: string) => (text ? text.trim().replace(/\.*$/, "") : "");
  const tone = brief.toneOfVoice ? `Art direction: ${sentence(brief.toneOfVoice)}.` : "";
  const objective = brief.objective ? `Campaign objective: ${sentence(brief.objective)}.` : "";

  return [
    slots.standard,
    // Deliberately unstyled. The look is set once, in the standard above, so
    // that overriding it cannot leave a contradicting adjective behind.
    `Campaign photograph of ${product.name} by ${brief.brand.name}.`,
    `Audience: ${brief.audience}. Market: ${brief.region}.`,
    objective,
    tone,

    slots.optics,
    slots.light,
    `The product stands ${slots.set}.`,
    slots.moment,
    slots.grade,
    slots.materials,
    slots.integrity,

    // Composition is LOCKED - derived from the crop arithmetic, not from taste.
    //
    // Every format is a centre crop of one square hero (see composeVariant, fit
    // "cover"). The narrowest is 9:16, which keeps 9/16 = 56% of the width;
    // 16:9 keeps the same fraction of the height. So the product has to sit
    // inside a centred square of 56%, and nothing whatsoever is gained by
    // making it smaller than that.
    //
    // Stated once, as the real number, as a positive instruction. Aiming at a
    // third when the safe area is 56% stops the 9:16 crop slicing the product
    // in half and pays for it by photographing everything from across the
    // room.
    COMPOSITION,

    // Retouch standard, stated rather than implied.
    "Retouched to catalogue standard: dust-free, fingerprint-free, symmetrical,",
    "circular openings drawn as true undistorted ellipses. No lumps, no curdling,",
    "no smears, no double lids, no warped geometry, no visible seams, and no",
    "second product, prop or duplicate of the item anywhere in the frame.",

    // The identity clause flips with the reference, or it fights itself.
    //
    // With no packshot the model is inventing the packaging, so any lettering it
    // draws is a fabricated claim on a regulated cosmetic. With an approved
    // packshot we are paying for the opposite: the real product, preserved.
    //
    // It asks for hue rather than "colours EXACTLY". The campaign light is
    // directional and dramatic by design, so the product reads differently from
    // the way it reads on a packshot's white sweep. An instruction the art
    // direction contradicts is not an instruction, and "exactly" was a claim
    // nothing measured. Method and figures: docs/CREATIVE_STANDARDS.md section 8.
    hasReference
      ? "Preserve the supplied product's identity from the reference: its " +
        "geometry, proportions, cap, closure, surface finish, hue and any " +
        "label or brand mark already on it. Relighting it into this scene will " +
        "change how light and dark it reads, and that is expected; its shape, " +
        "material and colour family must not change. Do not restyle, redraw, " +
        "relabel or substitute the product."
      : "Absolutely no text, no lettering, no typography, no logos, no " +
        "watermarks, and no packaging claims of any kind in the image.",

    // Typography is LOCKED, and last. A model handed a blank product will
    // letter it whatever else the prompt says: asked to preserve a completely
    // blank jar it returned one printed "Lumen Botanicals / Overnight Recovery
    // Cream", and an earlier run of the same instruction produced "Skin
    // plattored a. Overnigtrent cream" on a regulated cosmetic. Nothing
    // downstream reads pixels, so no check would ever have seen it.
    TYPOGRAPHY_RULE,
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
