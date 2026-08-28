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
 * The set every product in one campaign is photographed in.
 *
 * Each hero is a separate generation, so a loosely described set let the model
 * choose its own per product -- and a two-product campaign came back as two
 * unrelated photographs. One named set, shared, is the fix. It makes the heroes
 * belong together; it does not make them identical, because this provider
 * exposes no seed (docs/MODEL_STRATEGY.md).
 */
const DEFAULT_SET =
  "on a honed travertine ledge against a seamless plaster wall, with soft " +
  "foliage shadow falling across the background";

/**
 * The standard this campaign is shot to.
 *
 * Three escape hatches, in widening order, and every one of them optional:
 * `styleBar` replaces the quality standard, `artDirection` replaces the set,
 * and a product's `generationPrompt` replaces the whole brief. A campaign that
 * sets none of them gets all of it chosen for it, which is the common case and
 * the one that should need no decisions.
 */
export function styleBar(brief: CampaignBrief): string {
  return brief.styleBar?.trim() || CINEMATIC_BAR;
}

export function campaignSet(brief: CampaignBrief): string {
  return brief.artDirection?.trim() || DEFAULT_SET;
}

/**
 * The quality bar, stated before anything brand-specific.
 *
 * Every clause below it was already a correct technical instruction and the
 * output still came back looking like stock photography. The reason is that a
 * precise catalogue brief produces a precise catalogue photograph: evenly lit,
 * everything in focus, nothing to look at. Naming the standard first, in the
 * language the reference imagery is captioned in, moves the whole distribution
 * before a single product detail is specified.
 *
 * It is brand-agnostic on purpose. Nothing here mentions a product, a palette
 * or a category, so it lifts any campaign the pipeline runs, not the sample.
 */
const CINEMATIC_BAR =
  "Award-winning cinematic advertising photography, editorial quality, shot for " +
  "a global luxury brand campaign. Rich, filmic colour grade with deep tonal " +
  "range. Beautiful shallow depth of field. Dramatic natural light with real " +
  "atmosphere and mood. Hyper-detailed, photorealistic, sharp on the subject. " +
  "Not a flat studio packshot, not a stock catalogue render.";

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
  if (product.generationPrompt) return product.generationPrompt;

  // The brief's prose already ends its own sentences; re-punctuating it gave
  // "never hype..", which is the kind of thing a model happily renders around.
  const sentence = (text?: string) => (text ? text.trim().replace(/\.*$/, "") : "");
  const tone = brief.toneOfVoice ? `Art direction: ${sentence(brief.toneOfVoice)}.` : "";
  const objective = brief.objective ? `Campaign objective: ${sentence(brief.objective)}.` : "";

  return [
    styleBar(brief),
    // Deliberately unstyled. The look is set once, in the style bar above, so
    // that overriding the bar cannot leave a contradicting adjective behind.
    `Campaign photograph of ${product.name} by ${brief.brand.name}.`,
    `Audience: ${brief.audience}. Market: ${brief.region}.`,
    objective,
    tone,

    // Optics. The product stays critically sharp, but the set behind it falls
    // away. The previous brief stacked focus across the WHOLE frame at f/9,
    // which is catalogue lighting: technically clean, flat, and the reason the
    // output read as stock. Depth is what separates an ad from a packshot.
    "Shot on a 100mm macro lens at f/4, focus stacked across the product itself",
    "so its label and edges are critically sharp, while the background falls",
    "into a soft, creamy out-of-focus wash with gentle bokeh. Tripod, no motion",
    "blur. Shallow, deliberate depth of field.",

    // Light. Natural daylight rather than a studio grid: warmer, directional,
    // and it gives the frame somewhere for the eye to travel.
    "Lit by soft natural window daylight raking in from the upper left, warm and",
    "directional, with open bounce fill from the right and a narrow rim of light",
    "separating the product's edge from the background. A faint atmospheric haze",
    "catches the light. Highlights roll off gently and are never blown; shadows",
    "are deep but open, with real tonal separation between the product and the",
    "set. The lighting is felt, not seen: no softbox, reflector, light stand,",
    "modifier or any studio equipment appears in frame.",

    // Set and colour -- ONE set for the whole campaign, which is the difference
    // between a campaign and a folder of product shots. See campaignSet().
    `The product stands ${campaignSet(brief)}.`,
    "Restrained tonal colour grade, sympathetic to the brand palette without",
    "tinting the product itself.",

    // Material truth -- where AI product shots usually fail.
    "Materials must read as real: frosted glass transmits light correctly with a",
    "crisp polished rim, and the cap is smooth lacquered metal or resin with a",
    "clean specular roll-off and a precise machined edge.",

    // The decisive constraint.
    "The container is CLOSED with its cap fully seated, and is opaque: the",
    "contents are NOT visible. Do not render cream, lotion, product texture or",
    "any substance inside or on the vessel.",

    // Composition, derived from the crop rather than guessed at.
    //
    // Every format is a centre crop of one square hero (see composeVariant,
    // fit "cover"). The narrowest is 9:16, which keeps 9/16 = 56% of the
    // width; 16:9 keeps the same fraction of the height. So the product has to
    // sit inside a centred square of 56% -- and nothing whatsoever is gained
    // by making it smaller than that.
    //
    // An earlier version of this clause said "SMALL and distant", "only the
    // central third", and "most of this picture is background". It was written
    // to stop the 9:16 crop slicing the product in half, and it did -- but it
    // over-corrected by nearly half, aiming at 33% when the safe area is 56%.
    // Every hero came back looking photographed from across the room. Say the
    // real number, once, as a positive instruction.
    "The product sits in the LOWER HALF of the frame, horizontally centred,",
    "and is large, close and unmistakably the subject -- it fills most of the",
    "central 50% of the width, with its base and lid entirely in frame. The",
    "UPPER HALF is quiet, empty background: no product, no props, nothing but",
    "surface and light, because the campaign headline is composited there.",
    "Do not crop the product and do not place it off to one side.",

    // Retouch standard, stated rather than implied.
    "Retouched to catalogue standard: dust-free, fingerprint-free, symmetrical,",
    "circular openings drawn as true undistorted ellipses. No lumps, no curdling,",
    "no smears, no double lids, no warped geometry, no visible seams, and no",
    "second product, prop or duplicate of the item anywhere in the frame.",

    // The last clause has to flip with the reference, or it fights itself.
    //
    // With no packshot the model is inventing the packaging, so any lettering
    // it draws is a fabricated claim on a regulated cosmetic -- prohibit all of
    // it. With an approved packshot we are paying for the opposite: the real
    // product, preserved. Telling the model "no logos" while handing it the
    // brand's own jar is an instruction to erase the thing we supplied.
    //
    // It asks for hue rather than "colours EXACTLY". The campaign light is
    // dramatic and directional by design, so the lid necessarily reads
    // different from the way it reads on a packshot's white sweep. An
    // instruction the art direction contradicts is not an instruction, and
    // "exactly" was a claim nothing in this repo measures. The drift is real
    // and is measured against the committed run rather than asserted here:
    // method and figures in docs/CREATIVE_STANDARDS.md section 8.
    hasReference
      ? "Preserve the supplied product's identity from the reference: its " +
        "geometry, proportions, cap, closure, surface finish, hue and any " +
        "label or brand mark already on it. Relighting it into this scene will " +
        "change how light and dark it reads, and that is expected; its shape, " +
        "material and colour family must not change. Do not restyle, redraw, " +
        "relabel or substitute the product."
      : "Absolutely no text, no lettering, no typography, no logos, no " +
        "watermarks, and no packaging claims of any kind in the image.",

    // Last clause in the prompt, and absolute in both branches.
    //
    // It was one sub-clause at the end of the reference branch, saying "add no
    // new packaging text", and the model ignored it: handed a completely blank
    // jar it returned one printed "Lumen Botanicals / Overnight Recovery
    // Cream". That text was accurate by luck -- an earlier run of the same
    // instruction produced "Skin plattored a. Overnigtrent cream" on a
    // regulated cosmetic. Nothing downstream can read pixels, so neither the
    // prohibited-claim scan nor any other check would have seen it.
    //
    // Phrased without needing to know whether the reference is labelled, which
    // this pipeline cannot determine: copy what is there, originate nothing.
    "TYPOGRAPHY RULE, absolute: do NOT write, draw, print, emboss or add any " +
      "text, lettering, numerals, wordmark or logo anywhere in this image. If " +
      "the reference product already carries printed text, reproduce exactly " +
      "that and nothing more. If it carries none, the product must stay " +
      "completely unlabelled and blank. Inventing packaging copy is the single " +
      "worst failure this image can have.",
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
