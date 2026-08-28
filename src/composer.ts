import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { FONT_FAMILY, measureText } from "./fonts.js";

/**
 * Derived from composite()'s own signature rather than reaching into sharp's
 * type namespace, which moved in 0.35. This cannot drift from the library.
 */
type Layer = Parameters<ReturnType<typeof sharp>["composite"]>[0][number];

import type {
  Brand,
  CampaignBrief,
  CanonicalHeroAsset,
  Market,
  Product,
  RatioKey,
} from "./schema.js";
import { RATIOS } from "./schema.js";
import { escapeXml, fitText, readableTextColor } from "./textLayout.js";

export type ComposeInput = {
  brief: CampaignBrief;
  product: Product;
  hero: CanonicalHeroAsset;
  ratio: RatioKey;
  market: Market;
};

export type ComposedCreative = {
  buffer: Buffer;
  width: number;
  height: number;
  /** Copy actually rasterized -- localized when the brief supplies it. */
  renderedMessage: string;
  fontSize: number;
  lines: string[];
  copyFits: boolean;
  /** Opaque-pixel ratio of the isolated text layer. Proof glyphs really drew. */
  textInkRatio: number;
  logoRendered: boolean;
  disclaimerRendered: boolean;
  ctaRendered: boolean;
  /** Bounding box of all rendered text/logo/CTA, for the safe-zone check. */
  textBounds: { top: number; bottom: number; left: number; right: number };
  enforceSafeZone: boolean;
  textColor: string;
};

/**
 * Per-format art direction. Each is a deliberate layout, not a resize.
 *
 *   1:1   full-bleed hero, copy over a bottom scrim          (feed)
 *   4:5   same treatment, taller canvas                      (portrait feed)
 *   9:16  full-bleed hero, copy inside the Meta safe zone    (story / reel)
 *   16:9  hero right, brand copy panel left                  (landscape)
 *
 * 9:16 is the demanding one: fitting a square hero to it costs about 41% of the
 * image's width. That is exactly why the crop is centred and why the art
 * direction insists on negative space on all sides -- the product has to
 * survive that crop, and one generation has to serve every format.
 */
/**
 * Meta's published safe zone for 9:16 placements: leave roughly 14% of the
 * top, 35% of the bottom and 6% of each side free of text, logos and other
 * key creative elements, so nothing important is covered by the profile icon
 * or the platform's own call-to-action.
 *
 * Source: Meta Ads Guide, Instagram Stories / Reels image ad specs (checked
 * 2026-08-28). Stories and Reels share these values.
 *
 * The photograph itself is full-bleed -- the restriction is on text and logos,
 * not on the image.
 */
export const STORY_SAFE_ZONE = { top: 0.14, bottom: 0.35, sides: 0.06 } as const;

export function safeBoundsFor(width: number, height: number) {
  return {
    top: Math.ceil(height * STORY_SAFE_ZONE.top),
    bottom: Math.floor(height * (1 - STORY_SAFE_ZONE.bottom)),
    left: Math.ceil(width * STORY_SAFE_ZONE.sides),
    right: Math.floor(width * (1 - STORY_SAFE_ZONE.sides)),
  };
}

type Template = {
  hero: { left: number; top: number; width: number; height: number };
  copy: { left: number; top: number; width: number; height: number };
  /** Brand lockup position. Explicit per format so it never straddles a seam. */
  logo: { left: number; top: number; maxWidth: number };
  /**
   * Gap between the last headline line and the CTA pill. The pill follows the
   * headline so the block reads as one unit; each template's worst case (max
   * lines at max font size) is proven to stay clear of the disclaimer and,
   * on 9:16, inside the Meta safe zone. A test pins that.
   */
  ctaGap: number;
  /**
   * Y coordinate of the disclaimer baseline.
   *
   * Bottom-anchored on every format except the story, where the Meta safe zone
   * pushes copy up the frame and a fixed baseline stranded the legal line in
   * open photo, mid-frame and low contrast. There it follows the CTA instead,
   * so headline, CTA and disclaimer read as one block on the scrim.
   */
  disclaimerY: number;
  /** Story only: place the disclaimer under the CTA rather than at disclaimerY. */
  disclaimerFollowsCta: boolean;
  /** True when this format must honour the Meta 9:16 safe zone. */
  enforceSafeZone: boolean;
  scrim: false | "bottom" | "top";
  maxLines: number;
  maxFontSize: number;
  minFontSize: number;
};

export type { Template };

export function templateFor(ratio: RatioKey): Template {
  const { width, height } = RATIOS[ratio];

  if (ratio === "1x1") {
    const margin = 72;
    return {
      hero: { left: 0, top: 0, width, height },
      copy: { left: margin, top: 610, width: Math.round(width * 0.6), height: 250 },
      // Top-left lockup, the conventional brand position on a full-bleed post.
      logo: { left: margin, top: margin, maxWidth: 300 },
      ctaGap: 52,
      disclaimerY: height - 46,
      disclaimerFollowsCta: false,
      enforceSafeZone: false,
      scrim: "bottom",
      maxLines: 3,
      maxFontSize: 74,
      minFontSize: 38,
    };
  }

  // 4:5 -- Instagram's portrait feed placement. Same full-bleed treatment as
  // 1:1 with a taller canvas, so the copy block simply sits lower.
  if (ratio === "4x5") {
    const margin = 76;
    return {
      hero: { left: 0, top: 0, width, height },
      copy: { left: margin, top: 850, width: Math.round(width * 0.62), height: 260 },
      logo: { left: margin, top: margin, maxWidth: 300 },
      ctaGap: 52,
      disclaimerY: height - 46,
      disclaimerFollowsCta: false,
      enforceSafeZone: false,
      scrim: "bottom",
      maxLines: 3,
      maxFontSize: 74,
      minFontSize: 38,
    };
  }

  if (ratio === "9x16") {
    // Full-bleed hero: Meta restricts text and logos in the safe zone, not the
    // photograph. All copy is placed inside the safe band instead.
    const safe = safeBoundsFor(width, height);
    const margin = 80; // > the 65px the 6% side rule requires

    return {
      hero: { left: 0, top: 0, width, height },
      copy: { left: margin, top: 470, width: width - margin * 2, height: 330 },
      logo: { left: margin, top: safe.top + 34, maxWidth: 260 },
      ctaGap: 52,
      disclaimerY: safe.bottom - 40,
      disclaimerFollowsCta: true,
      enforceSafeZone: true,
      scrim: "top",
      maxLines: 3,
      maxFontSize: 88,
      minFontSize: 42,
    };
  }

  // 16x9 -- hero right, copy left
  const heroWidth = 1120; // 1120x1080 -- near-square crop
  const margin = 88;
  return {
    hero: { left: width - heroWidth, top: 0, width: heroWidth, height },
    copy: {
      left: margin,
      top: 380,
      width: width - heroWidth - margin * 2,
      height: 340,
    },
    logo: { left: margin, top: 200, maxWidth: 240 },
    ctaGap: 48,
    disclaimerY: height - 46,
    disclaimerFollowsCta: false,
    enforceSafeZone: false,
    scrim: false,
    maxLines: 4,
    maxFontSize: 72,
    minFontSize: 36,
  };
}

/**
 * Mean luminance (0–1) of a horizontal band of the hero.
 *
 * A fixed scrim opacity is a guess: over a dark photo it is wasted, and over a
 * bright one the copy still fails. Sampling the band the copy will actually sit
 * on lets the scrim be exactly as strong as that image needs -- which is what
 * kept a gold wordmark legible over a sunlit wall.
 */
async function bandLuminance(
  hero: Buffer,
  top: number,
  height: number,
  width: number,
): Promise<number> {
  const safeTop = Math.max(0, Math.round(top));
  const safeHeight = Math.max(1, Math.round(height));
  try {
    const stats = await sharp(hero)
      .extract({ left: 0, top: safeTop, width, height: safeHeight })
      .greyscale()
      .stats();
    return (stats.channels[0]?.mean ?? 128) / 255;
  } catch {
    // Out-of-bounds band: assume mid grey rather than fail the render.
    return 0.5;
  }
}

/** Brighter backgrounds need a stronger scrim; dark ones need almost none. */
function scrimOpacity(luminance: number, floor: number, ceiling: number): number {
  return Number((floor + (ceiling - floor) * luminance).toFixed(3));
}

export async function composeVariant(input: ComposeInput): Promise<ComposedCreative> {
  const { brief, hero, ratio, market } = input;
  const brand = brief.brand;
  const { width, height } = RATIOS[ratio];
  const tpl = templateFor(ratio);

  // Copy comes from the market, which the market team signed off on.
  const message = market.message;
  const callToAction = market.callToAction ?? brief.callToAction;
  const disclaimer = market.disclaimer ?? brand.disclaimer;

  // 1. Base canvas in the brand colour, so any uncovered area is on-brand.
  const canvas = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: brand.primaryColor,
    },
  });

  const layers: Layer[] = [];

  // 2. Hero, cover-fitted into its zone. `cover` crops rather than distorts,
  //    and the crop is CENTRED on purpose.
  //
  //    This used sharp's `attention` saliency heuristic, which on 9:16 has to
  //    discard about 41% of a square hero's width and chose a region that cut
  //    the product in half. The art direction already guarantees the invariant
  //    that heuristic was guessing at -- "the product is the hero: centred ...
  //    with generous negative space on all sides so the image can be re-cropped
  //    to square, vertical and landscape without cutting the product" -- so a
  //    centre crop honours the prompt instead of second-guessing it, and it is
  //    deterministic, which `attention` is not.
  const heroBuffer = await sharp(await readFile(hero.localPath))
    .resize(tpl.hero.width, tpl.hero.height, { fit: "cover", position: "centre" })
    .toBuffer();
  layers.push({ input: heroBuffer, left: tpl.hero.left, top: tpl.hero.top });

  // 3. Copy zone treatment. On the full-bleed 1:1 the copy sits over the photo,
  //    so it needs a gradient scrim to stay readable; the panel formats do not.
  const textColor = tpl.scrim ? "#FFFFFF" : readableTextColor(brand.primaryColor);

  if (tpl.scrim === "bottom") {
    const scrimTop = Math.max(0, tpl.copy.top - 180);
    const copyLum = await bandLuminance(heroBuffer, scrimTop, height - scrimTop, width);
    const topLum = await bandLuminance(heroBuffer, 0, 300, width);
    const copyPeak = scrimOpacity(copyLum, 0.62, 0.9);
    const copyMid = scrimOpacity(copyLum, 0.34, 0.66);
    const topPeak = scrimOpacity(topLum, 0.34, 0.78);
    const scrimSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height - scrimTop}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="45%" stop-color="#000000" stop-opacity="${copyMid}"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="${copyPeak}"/>
      </linearGradient></defs>
      <rect width="${width}" height="${height - scrimTop}" fill="url(#g)"/>
    </svg>`;
    layers.push({ input: Buffer.from(scrimSvg), left: 0, top: scrimTop });

    // A short top scrim so the corner lockup stays legible over a bright hero.
    const topSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${scrimTop}">
      <defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="${topPeak}"/>
        <stop offset="55%" stop-color="#000000" stop-opacity="${scrimOpacity(topLum, 0.06, 0.2)}"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="${width}" height="${scrimTop}" fill="url(#t)"/>
    </svg>`;
    layers.push({ input: Buffer.from(topSvg), left: 0, top: 0 });
  } else if (tpl.scrim === "top") {
    // 9:16 puts its copy in the upper safe band, so the scrim is strongest
    // there and clears the lower frame where the product sits.
    const fade = Math.min(height, tpl.disclaimerY + 260);
    const bandLum = await bandLuminance(heroBuffer, 0, fade, width);
    const peak = scrimOpacity(bandLum, 0.5, 0.82);
    const mid = scrimOpacity(bandLum, 0.4, 0.72);
    const scrimSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fade}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="${peak}"/>
        <stop offset="55%" stop-color="#000000" stop-opacity="${mid}"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="${width}" height="${fade}" fill="url(#g)"/>
    </svg>`;
    layers.push({ input: Buffer.from(scrimSvg), left: 0, top: 0 });
  } else {
    // Solid brand panel fills everything outside the hero zone.
    const panel =
      ratio === "9x16"
        ? { left: 0, top: tpl.hero.height, width, height: height - tpl.hero.height }
        : { left: 0, top: 0, width: width - tpl.hero.width, height };
    const panelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panel.width}" height="${panel.height}">
      <rect width="${panel.width}" height="${panel.height}" fill="${brand.primaryColor}"/>
    </svg>`;
    layers.push({ input: Buffer.from(panelSvg), left: panel.left, top: panel.top });
  }

  // 4. Text layer, rendered in isolation so we can prove ink actually landed.
  const fit = fitText(message, tpl.copy.width, tpl.maxLines, tpl.maxFontSize, tpl.minFontSize);

  const logoBuffer = await loadLogo(brand, tpl.logo.maxWidth);
  const textLayer = buildTextLayer({
    width,
    height,
    tpl,
    fit,
    textColor,
    accent: brand.secondaryColor,
    callToAction,
    disclaimer,
  });

  const textPng = await sharp(Buffer.from(textLayer)).png().toBuffer();
  const textInkRatio = await inkRatio(textPng);
  layers.push({ input: textPng, left: 0, top: 0 });

  if (logoBuffer) {
    layers.push({ input: logoBuffer, left: tpl.logo.left, top: tpl.logo.top });
  }

  const buffer = await canvas.composite(layers).png({ quality: 95 }).toBuffer();

  return {
    buffer,
    width,
    height,
    renderedMessage: message,
    fontSize: fit.fontSize,
    lines: fit.lines,
    copyFits: fit.fits,
    textInkRatio,
    logoRendered: Boolean(logoBuffer),
    disclaimerRendered: Boolean(disclaimer),
    ctaRendered: Boolean(callToAction?.trim()),
    enforceSafeZone: tpl.enforceSafeZone,
    textBounds: {
      top: logoBuffer ? tpl.logo.top : tpl.copy.top - 34,
      bottom: textBlockBottom(tpl, fit, Boolean(disclaimer), callToAction),
      left: tpl.copy.left,
      right: tpl.copy.left + tpl.copy.width,
    },
    textColor,
  };
}

/**
 * Lowest pixel any text element occupies, used by the safe-zone check.
 *
 * It has to mirror buildTextLayer exactly. When the disclaimer follows the CTA
 * the block grows with the headline, so the bottom cannot be read off a fixed
 * coordinate -- getting that wrong would have the safe-zone check measuring a
 * line that is no longer there.
 */
export function textBlockBottom(
  tpl: Template,
  fit: { lines: string[]; fontSize: number },
  hasDisclaimer: boolean,
  callToAction?: string,
): number {
  if (hasDisclaimer && !tpl.disclaimerFollowsCta) return tpl.disclaimerY;

  const lineHeight = Math.round(fit.fontSize * 1.16);
  const headlineBottom =
    tpl.copy.top + fit.fontSize + Math.max(0, fit.lines.length - 1) * lineHeight;

  const ctaBottom = callToAction?.trim()
    ? headlineBottom +
      tpl.ctaGap +
      Math.round(
        Math.max(24, fit.fontSize * 0.36) +
          Math.round(Math.max(24, fit.fontSize * 0.36) * 0.62) * 2,
      )
    : headlineBottom;

  return hasDisclaimer ? ctaBottom + 46 : ctaBottom;
}

function buildTextLayer(args: {
  width: number;
  height: number;
  tpl: Template;
  fit: { lines: string[]; fontSize: number };
  textColor: string;
  accent: string;
  callToAction?: string;
  disclaimer?: string;
}): string {
  const { width, height, tpl, fit, textColor, accent, callToAction, disclaimer } = args;
  const lineHeight = Math.round(fit.fontSize * 1.16);
  const headlineBottom =
    tpl.copy.top + fit.fontSize + Math.max(0, fit.lines.length - 1) * lineHeight;
  const font = `${FONT_FAMILY}, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

  const lines = fit.lines
    .map(
      (line, i) =>
        `<text x="${tpl.copy.left}" y="${tpl.copy.top + fit.fontSize + i * lineHeight}" ` +
        `font-family="${font}" font-size="${fit.fontSize}" font-weight="700" ` +
        `letter-spacing="-0.5" fill="${textColor}">${escapeXml(line)}</text>`,
    )
    .join("\n");

  // A short accent rule above the headline -- the kind of small brand device
  // that separates a produced ad from an image with words on it.
  const ruleY = tpl.copy.top - 34;
  const rule = `<rect x="${tpl.copy.left}" y="${ruleY}" width="88" height="6" fill="${accent}"/>`;

  // CTA sits directly under the headline as a pill -- the shape a viewer
  // reads as "this is the action", and how real social placements treat it.
  const cta = callToAction?.trim();
  let ctaSvg = "";
  let ctaBottom = headlineBottom;
  if (cta) {
    const ctaFont = Math.round(Math.max(24, fit.fontSize * 0.36));
    const padX = Math.round(ctaFont * 0.9);
    const padY = Math.round(ctaFont * 0.62);
    const textW = measureText(cta, ctaFont, 700);
    const boxW = Math.round(textW + padX * 2);
    const boxH = Math.round(ctaFont + padY * 2);
    const boxY = headlineBottom + tpl.ctaGap;
    ctaBottom = boxY + boxH;
    ctaSvg =
      `<rect x="${tpl.copy.left}" y="${boxY}" width="${boxW}" height="${boxH}" ` +
      `rx="${Math.round(boxH / 2)}" fill="${accent}"/>` +
      `<text x="${tpl.copy.left + padX}" y="${boxY + padY + ctaFont * 0.8}" ` +
      `font-family="${font}" font-size="${ctaFont}" font-weight="700" ` +
      `letter-spacing="0.6" fill="#141815">${escapeXml(cta)}</text>`;
  }

  // Bottom-anchored, except on the story where it rides with the copy block.
  const disclaimerY = tpl.disclaimerFollowsCta ? ctaBottom + 46 : tpl.disclaimerY;

  const disclaimerSvg = disclaimer
    ? `<text x="${tpl.copy.left}" y="${disclaimerY}" font-family="${font}" ` +
      `font-size="24" fill="${textColor}" opacity="0.72">${escapeXml(disclaimer)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${rule}
    ${lines}
    ${ctaSvg}
    ${disclaimerSvg}
  </svg>`;
}

/** Returns null rather than throwing: a missing logo is a warning, not a stop. */
async function loadLogo(brand: Brand, maxWidth: number): Promise<Buffer | null> {
  if (!brand.logoPath) return null;
  try {
    return await sharp(await readFile(brand.logoPath))
      .resize({ width: maxWidth, fit: "inside" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Fraction of the text layer that is opaque.
 *
 * This is the check that makes "campaign message rendered" a fact rather than
 * an assumption. If the font failed to resolve, or the copy zone collapsed, the
 * layer comes back empty and the creative is flagged -- the check can go red.
 */
export async function inkRatio(pngBuffer: Buffer): Promise<number> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  let opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] > 16) opaque++;
  }
  return opaque / pixels;
}
