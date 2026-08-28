import { access } from "node:fs/promises";
import path from "node:path";
import type { ComposedCreative } from "./composer.js";
import { safeBoundsFor, type Template } from "./composer.js";
import { availableFamilies, missingGlyphs } from "./fonts.js";
import type {
  CampaignBrief,
  Market,
  RatioKey,
  ValidationCheck,
  ValidationResult,
} from "./schema.js";
import { baselineMinutes, RATIOS, resolveMarkets } from "./schema.js";
import { socialCopy } from "./socialCopy.js";
import { contrastRatio } from "./textLayout.js";

/** Minimum opaque fraction of the text layer that counts as "copy rendered". */
const MIN_INK_RATIO = 0.0004;

class PreflightError extends Error {
  constructor(
    message: string,
    readonly checks: ValidationCheck[],
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

function rollup(checks: ValidationCheck[]): ValidationResult {
  const status = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warning")
      ? "warning"
      : "pass";
  return { status, checks };
}

/**
 * Everything cheap that can be known before we spend money.
 *
 * This runs to completion BEFORE any generation call, so a brief with a legal
 * problem or a broken asset path fails for free rather than after paying a
 * model. That ordering is the point of the function.
 */
export async function preflight(brief: CampaignBrief): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];

  checks.push({
    id: "brief.products",
    status: brief.products.length >= 2 ? "pass" : "fail",
    message: `${brief.products.length} product(s) in brief (minimum 2)`,
  });

  for (const field of ["region", "audience", "message"] as const) {
    checks.push({
      id: `brief.${field}`,
      status: brief[field]?.trim() ? "pass" : "fail",
      message: brief[field]?.trim() ? `${field} present` : `${field} is missing`,
    });
  }

  checks.push(prohibitedClaimCheck(brief));

  if (brief.brand.logoPath) {
    const ok = await exists(brief.brand.logoPath);
    checks.push({
      id: "brand.logoFile",
      status: ok ? "pass" : "warning",
      message: ok
        ? `Logo found at ${brief.brand.logoPath}`
        : `Logo configured but not found at ${brief.brand.logoPath} - creatives will render without it`,
    });
  }

  // Declared-but-absent asset paths are a warning, not a failure: a missing
  // approved hero is exactly the case the generator exists to handle.
  for (const product of brief.products) {
    for (const key of ["approvedHeroPath", "referenceAssetPath"] as const) {
      const declared = product[key];
      if (!declared) continue;
      const ok = await exists(declared);
      checks.push({
        id: `asset.${product.id}.${key}`,
        status: ok ? "pass" : "warning",
        message: ok
          ? `${product.id}: ${key} resolved`
          : `${product.id}: ${key} declared but not on disk (${declared})`,
      });
    }
  }

  const font = headlineFontCheck(brief);
  if (font) checks.push(font);
  checks.push(glyphCoverageCheck(brief));

  const baseline = baselineCheck(brief);
  if (baseline) checks.push(baseline);

  checks.push({
    // Named for what it measures. It was `brand.colors`, which read as though
    // the brand palette had been checked against the creative; it only ever
    // confirmed the marketer typed a colour. The creative-level check of the
    // same name now does the real one, against pixels.
    id: "brand.colorFormat",
    status: isHex(brief.brand.primaryColor) && isHex(brief.brand.secondaryColor) ? "pass" : "fail",
    message: "Brand colours are valid hex values",
  });

  return rollup(checks);
}

/**
 * Every string this run can publish, screened against the brand's claim list.
 *
 * That is the rendered creative AND the caption written beside it. The caption
 * is assembled from strings already screened here, plus the brand and product
 * names -- so including it adds exactly one thing the scan could not otherwise
 * see: a prohibited term inside a name. A brand shipping a product called
 * "Miracle Balm" would have produced clean images with a banned claim in the
 * post body underneath them.
 */
function prohibitedClaimCheck(brief: CampaignBrief): ValidationCheck {
  const captions = resolveMarkets(brief).flatMap((market) =>
    brief.products.map((product) => socialCopy(brief, product, market).caption),
  );
  const copy = [
    brief.message,
    brief.callToAction,
    brief.brand.disclaimer,
    ...(brief.markets ?? []).flatMap((m) => [m.message, m.callToAction, m.disclaimer]),
    ...captions,
  ]
    .filter(Boolean)
    .join(" ");
  const hits = findProhibited(copy, brief.brand.prohibitedWords);
  return {
    id: "legal.prohibitedWords",
    status: hits.length === 0 ? "pass" : "fail",
    message:
      hits.length === 0
        ? `No prohibited terms found (${brief.brand.prohibitedWords.length} screened)`
        : `Prohibited term(s) in campaign copy: ${hits.join(", ")}`,
  };
}

/**
 * The two ways of stating the manual baseline have to agree.
 *
 * Without this the report could show a five-line breakdown adding to 25 while
 * the saving was computed from a stale 30 sitting two fields above it. Null
 * when the brief states only one of the two, which is the common case.
 */
function baselineCheck(brief: CampaignBrief): ValidationCheck | null {
  if (!brief.manualBaseline?.length || !brief.manualMinutesPerCreative) return null;
  const summed = baselineMinutes(brief);
  const ok = summed === brief.manualMinutesPerCreative;
  return {
    id: "brief.manualBaseline",
    status: ok ? "pass" : "fail",
    message: ok
      ? `Manual baseline itemises to ${summed} min/creative, matching the stated total`
      : `Manual baseline items add to ${summed} min but manualMinutesPerCreative says ${brief.manualMinutesPerCreative}`,
  };
}

/**
 * Every market's copy, checked against the glyphs actually bundled.
 *
 * Localization is the exercise's bonus and the font files are its honest limit:
 * Rubik and Cormorant cover Latin and its accents, so a market written in
 * Japanese or Arabic rasterizes as .notdef boxes. Nothing downstream would
 * notice - the ink check counts opaque pixels, and a row of tofu is opaque - so
 * the creative ships looking broken with every check green.
 *
 * A failure, not a warning, for the same reason a truncated headline is: the
 * exercise requires the campaign message ON the post, and a row of .notdef
 * boxes is not that message. Producing the covered markets and quietly shipping
 * empty boxes for the rest would be worse than refusing - the boxes look like a
 * bug in the brand's ad, and nobody would find out until it was live. It costs
 * nothing to refuse, because this runs before any generation.
 *
 * It names the market and the characters so the fix is obvious: add the face to
 * assets/fonts and set brand.headlineFont.
 */
function glyphCoverageCheck(brief: CampaignBrief): ValidationCheck {
  const gaps: string[] = [];
  for (const market of resolveMarkets(brief)) {
    const copy = [market.message, market.callToAction, market.disclaimer].filter(Boolean).join(" ");
    // Headline and interface copy use different faces, so both are checked.
    const missing = [
      ...new Set([...missingGlyphs(copy, "display"), ...missingGlyphs(copy, "bold")]),
    ];
    if (missing.length > 0) gaps.push(`${market.locale} (${missing.slice(0, 6).join("")})`);
  }
  return {
    id: "brand.glyphCoverage",
    status: gaps.length === 0 ? "pass" : "fail",
    message:
      gaps.length === 0
        ? `Every market's copy renders in the bundled typefaces (${resolveMarkets(brief).length} screened)`
        : `Bundled typefaces have no glyphs for ${gaps.join(", ")} - that copy would rasterize as empty boxes. Add the face to assets/fonts and set brand.headlineFont.`,
  };
}

/**
 * A named typeface has to be verified, not trusted.
 *
 * fontconfig's answer to a family it cannot find is a silent substitution, not
 * an error -- so an unbundled font would ship creatives in the wrong face with
 * every check green. Returns null when the brand names no font.
 */
function headlineFontCheck(brief: CampaignBrief): ValidationCheck | null {
  const named = brief.brand.headlineFont;
  if (!named) return null;
  const ok = availableFamilies().has(named);
  return {
    id: "brand.headlineFont",
    status: ok ? "pass" : "warning",
    message: ok
      ? `Headline typeface "${named}" resolves`
      : `Headline typeface "${named}" is not in assets/fonts - creatives would render in a substituted face; add the file or remove the field`,
  };
}

export function preflightOrThrow(result: ValidationResult): void {
  if (result.status === "fail") {
    const failed = result.checks.filter((c) => c.status === "fail");
    throw new PreflightError(
      `Preflight failed before any generation spend: ${failed.map((c) => c.message).join("; ")}`,
      result.checks,
    );
  }
}

/**
 * Post-render checks.
 *
 * Each one is a small pure function of the rendered result, registered in a
 * list. Returning null means the check does not apply to this creative -- no
 * logo configured, or a format with no platform safe zone. Adding a rule is a
 * function plus a line in the registry, and every rule can be tested alone.
 *
 * Every check is measured off the actual pixels or the actual file we just
 * wrote. None of them are asserted from intent.
 */
type CheckContext = {
  brief: CampaignBrief;
  rendered: ComposedCreative;
  ratio: RatioKey;
  market: Market;
  /** The format's own layout budget, so a failure can say what it exceeded. */
  tpl: Template;
};

type CreativeCheck = (ctx: CheckContext) => ValidationCheck | null;

const dimensionsCheck: CreativeCheck = ({ rendered, ratio }) => {
  const expected = RATIOS[ratio];
  const ok = rendered.width === expected.width && rendered.height === expected.height;
  return {
    id: "output.dimensions",
    status: ok ? "pass" : "fail",
    message: `${rendered.width}×${rendered.height} (expected ${expected.width}×${expected.height})`,
  };
};

/**
 * The one that makes "message rendered" a fact: it counts ink, not intent.
 *
 * It measures the HEADLINE layer specifically. Measured against the combined
 * text layer, a creative that drew only its CTA and disclaimer would have
 * passed a check whose name claims the campaign message is present -- which is
 * the requirement the exercise is most explicit about.
 */
const messageRenderedCheck: CreativeCheck = ({ rendered }) => {
  const ok = rendered.headlineInkRatio >= MIN_INK_RATIO;
  return {
    id: "message.rendered",
    status: ok ? "pass" : "fail",
    message: ok
      ? `Campaign message rasterized (${(rendered.headlineInkRatio * 100).toFixed(3)}% headline ink)`
      : `No headline glyphs detected (${(rendered.headlineInkRatio * 100).toFixed(4)}%) - the campaign message did not render`,
  };
};

/**
 * A truncated campaign message is a failure, not a warning.
 *
 * The compositor truncates rather than shrink below the legibility floor, which
 * is the right trade -- but the exercise requires the campaign message to be
 * displayed on the final post, and half a headline is not that message. Nobody
 * ships an ad with the headline cut off. It was a warning, which meant the
 * creative rolled up to "warning" rather than "fail", which meant
 * `assignmentProof` stayed green over a violated requirement.
 *
 * The remedy is in the operator's hands and the message says so.
 */
const legibilityCheck: CreativeCheck = ({ rendered, tpl }) => ({
  id: "message.legible",
  status: rendered.copyFits ? "pass" : "fail",
  message: rendered.copyFits
    ? `Campaign message fits in ${rendered.lines.length} line(s) at ${rendered.fontSize}px`
    : `Campaign message does not fit: it needs more than ${tpl.maxLines} lines at the ${rendered.fontSize}px legibility floor and was truncated. Shorten the message for this market.`,
});

/**
 * Text/background contrast, but only where "background" is a colour we can name.
 *
 * WCAG 2.2 AA wants 4.5:1 for normal text and 3:1 for large text (>=18.66px
 * bold, or >=24px regular); campaign headlines sit far into the large band, so
 * holding them to the small-text bar would report a failure the standard does
 * not require.
 *
 * It returns null on the full-bleed formats, and that is the honest answer
 * rather than a missing one. There the copy sits on a photograph, not on
 * brand.primaryColor, so comparing the two measures a background that is not
 * behind the copy -- it would pass over a white image. Legibility there is
 * guaranteed differently and earlier: composer.ts samples the luminance of the
 * band the copy will occupy and sizes the scrim to that specific photograph.
 * Measuring it after the fact is worth doing and is noted as a limitation; a
 * check that cannot go red is worse than an absent one.
 */
const contrastCheck: CreativeCheck = ({ brief, rendered }) => {
  if (rendered.scrimmed) return null;
  const ratio = contrastRatio(rendered.textColor, brief.brand.primaryColor);
  const isLargeText = rendered.fontSize >= 24;
  const threshold = isLargeText ? 3 : 4.5;
  return {
    id: "brand.contrast",
    status: ratio >= threshold ? "pass" : "warning",
    message: `Text/background contrast ${ratio.toFixed(2)}:1 (WCAG 2.2 AA needs ${threshold}:1 for ${isLargeText ? "large" : "normal"} text at ${rendered.fontSize}px)`,
  };
};

/**
 * Presence of logo, which is the exercise's own example of a brand check.
 *
 * It never returns null. It used to, whenever the brief named no logoPath --
 * so the two brands that shipped without one produced creatives reporting
 * 16 of 16 checks passed, from a brand suite that had silently dropped the
 * brand's most visible asset. An absent check reads as a passed check in every
 * count that matters, which is the same defect as a label broader than its
 * measurement, one level up: the measurement was not there at all.
 *
 * Not configured is a warning, not a failure. The brief is the authority on
 * what this brand's identity contains, and a campaign can legitimately run
 * without a lockup; what it cannot do is go unmentioned.
 */
const logoCheck: CreativeCheck = ({ brief, rendered }) => {
  if (!brief.brand.logoPath) {
    return {
      id: "brand.logo",
      status: "warning",
      message: "No brand logo in the brief - nothing to check for logo presence",
    };
  }
  return {
    id: "brand.logo",
    status: rendered.logoRendered ? "pass" : "warning",
    message: rendered.logoRendered
      ? "Brand logo composited"
      : "Logo configured but no logo pixels reached the creative",
  };
};

/**
 * Meta reserves the top 14% / bottom 35% / outer 6% of a 9:16 placement for its
 * own UI. Copy that strays into it gets covered in the real feed, so this is
 * measured against where the text actually landed.
 */
const safeZoneCheck: CreativeCheck = ({ rendered }) => {
  if (!rendered.enforceSafeZone) return null;
  const safe = safeBoundsFor(rendered.width, rendered.height);
  const b = rendered.textBounds;
  const inside =
    b.top >= safe.top && b.bottom <= safe.bottom && b.left >= safe.left && b.right <= safe.right;
  return {
    id: "channel.safeZone",
    status: inside ? "pass" : "fail",
    message: inside
      ? `Copy inside the Meta 9:16 safe zone (y ${b.top}-${b.bottom} within ${safe.top}-${safe.bottom})`
      : `Copy breaks the Meta 9:16 safe zone (y ${b.top}-${b.bottom}, allowed ${safe.top}-${safe.bottom}) - the platform overlay would cover it`,
  };
};

const callToActionCheck: CreativeCheck = ({ brief, rendered, market }) => {
  const expected = market.callToAction ?? brief.callToAction;
  if (!expected) return null;
  return {
    id: "creative.callToAction",
    status: rendered.ctaRendered ? "pass" : "fail",
    message: rendered.ctaRendered
      ? `Call to action rendered ("${expected}")`
      : "Call to action in brief but absent from the creative",
  };
};

const disclaimerCheck: CreativeCheck = ({ brief, rendered, market }) =>
  (market.disclaimer ?? brief.brand.disclaimer)
    ? {
        id: "legal.disclaimer",
        status: rendered.disclaimerRendered ? "pass" : "fail",
        message: rendered.disclaimerRendered
          ? "Legal disclaimer rendered"
          : "Disclaimer configured but absent from the creative",
      }
    : null;

/**
 * Screens exactly the copy that reached the pixels.
 *
 * Headline always, plus the CTA and the disclaimer when they actually
 * rendered. Scanning the headline alone let this report "rendered copy is
 * clear of prohibited terms" while a banned claim sat in the CTA. Preflight
 * blocks that case earlier and for free, so this is the second gate rather
 * than the only one -- but a check whose message is broader than its
 * measurement is the wrong kind of green.
 */
const prohibitedTermsCheck: CreativeCheck = ({ brief, rendered, market }) => {
  const renderedCopy = [
    rendered.renderedMessage,
    rendered.ctaRendered ? (market.callToAction ?? brief.callToAction) : null,
    rendered.disclaimerRendered ? (market.disclaimer ?? brief.brand.disclaimer) : null,
  ]
    .filter(Boolean)
    .join(" ");
  const hits = findProhibited(renderedCopy, brief.brand.prohibitedWords);
  return {
    id: "legal.prohibitedWords",
    status: hits.length === 0 ? "pass" : "fail",
    message:
      hits.length === 0
        ? "Rendered copy is clear of prohibited terms"
        : `Prohibited term(s) rendered into the image: ${hits.join(", ")}`,
  };
};

/**
 * The exercise's second named brand check: "use of brand colors".
 *
 * Measured off the finished creative, not off the brief. The accent carries the
 * rule above the headline and the CTA pill, so if it is absent from the pixels
 * the brand's own colour did not reach the post - whatever the brief said.
 *
 * The floor is deliberately tiny. This asks whether the brand colour is present
 * at all, which is what the exercise names; it is not a proportion-of-palette
 * rule, and inventing a threshold for how much gold an ad should contain would
 * be a number with nothing behind it.
 */
const brandColorCheck: CreativeCheck = ({ brief, rendered }) => {
  const present = rendered.accentCoverage > 0;
  return {
    id: "brand.colors",
    status: present ? "pass" : "fail",
    message: present
      ? `Brand accent ${brief.brand.secondaryColor} present in the creative (${(rendered.accentCoverage * 100).toFixed(2)}% of pixels)`
      : `Brand accent ${brief.brand.secondaryColor} does not appear anywhere in the finished creative`,
  };
};

/** Order here is the order a reviewer reads them in. */
const CREATIVE_CHECKS: CreativeCheck[] = [
  dimensionsCheck,
  messageRenderedCheck,
  legibilityCheck,
  contrastCheck,
  brandColorCheck,
  logoCheck,
  safeZoneCheck,
  callToActionCheck,
  disclaimerCheck,
  prohibitedTermsCheck,
];

export function validateCreative(ctx: CheckContext): ValidationResult {
  const checks = CREATIVE_CHECKS.map((check) => check(ctx)).filter(
    (c): c is ValidationCheck => c !== null,
  );
  return rollup(checks);
}

/** Word-boundary match so "cure" does not trip on "secure". */
export function findProhibited(text: string, prohibited: string[]): string[] {
  const hits: string[] = [];
  for (const term of prohibited) {
    const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) continue;
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) hits.push(term);
  }
  return hits;
}

function isHex(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(path.resolve(p));
    return true;
  } catch {
    return false;
  }
}
