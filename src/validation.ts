import { access } from "node:fs/promises";
import path from "node:path";
import type { ComposedCreative } from "./composer.js";
import { safeBoundsFor } from "./composer.js";
import { availableFamilies } from "./fonts.js";
import type {
  CampaignBrief,
  Market,
  RatioKey,
  ValidationCheck,
  ValidationResult,
} from "./schema.js";
import { RATIOS } from "./schema.js";
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

  // Legal / MLR scan across every piece of copy that can reach a final image.
  // Screen every string that can reach a rendered creative, in every market.
  const copy = [
    brief.message,
    brief.callToAction,
    brief.brand.disclaimer,
    ...(brief.markets ?? []).flatMap((m) => [m.message, m.callToAction, m.disclaimer]),
  ]
    .filter(Boolean)
    .join(" ");
  const hits = findProhibited(copy, brief.brand.prohibitedWords);
  checks.push({
    id: "legal.prohibitedWords",
    status: hits.length === 0 ? "pass" : "fail",
    message:
      hits.length === 0
        ? `No prohibited terms found (${brief.brand.prohibitedWords.length} screened)`
        : `Prohibited term(s) in campaign copy: ${hits.join(", ")}`,
  });

  if (brief.brand.logoPath) {
    const ok = await exists(brief.brand.logoPath);
    checks.push({
      id: "brand.logoFile",
      status: ok ? "pass" : "warning",
      message: ok
        ? `Logo found at ${brief.brand.logoPath}`
        : `Logo configured but not found at ${brief.brand.logoPath} — creatives will render without it`,
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

  checks.push({
    id: "brand.colors",
    status: isHex(brief.brand.primaryColor) && isHex(brief.brand.secondaryColor) ? "pass" : "fail",
    message: "Brand colours are valid hex values",
  });

  return rollup(checks);
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
      : `Headline typeface "${named}" is not in assets/fonts — creatives would render in a substituted face; add the file or remove the field`,
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
      : `No headline glyphs detected (${(rendered.headlineInkRatio * 100).toFixed(4)}%) — the campaign message did not render`,
  };
};

const legibilityCheck: CreativeCheck = ({ rendered }) => ({
  id: "message.legible",
  status: rendered.copyFits ? "pass" : "warning",
  message: rendered.copyFits
    ? `Copy fits in ${rendered.lines.length} line(s) at ${rendered.fontSize}px`
    : `Copy exceeds the copy zone; truncated at the ${rendered.fontSize}px legibility floor rather than shrunk further`,
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

const logoCheck: CreativeCheck = ({ brief, rendered }) =>
  brief.brand.logoPath
    ? {
        id: "brand.logo",
        status: rendered.logoRendered ? "pass" : "warning",
        message: rendered.logoRendered
          ? "Brand logo composited"
          : "Logo configured but no logo pixels reached the creative",
      }
    : null;

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
      ? `Copy inside the Meta 9:16 safe zone (y ${b.top}–${b.bottom} within ${safe.top}–${safe.bottom})`
      : `Copy breaks the Meta 9:16 safe zone (y ${b.top}–${b.bottom}, allowed ${safe.top}–${safe.bottom}) — the platform overlay would cover it`,
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

/** Order here is the order a reviewer reads them in. */
const CREATIVE_CHECKS: CreativeCheck[] = [
  dimensionsCheck,
  messageRenderedCheck,
  legibilityCheck,
  contrastCheck,
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
