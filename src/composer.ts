import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { DISPLAY_FAMILY, FONT_FAMILY, measureText } from "./fonts.js";

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
  /** Opaque-pixel ratio of the whole text layer. */
  textInkRatio: number;
  /** Opaque-pixel ratio of the HEADLINE alone -- proof the campaign message drew. */
  headlineInkRatio: number;
  logoRendered: boolean;
  disclaimerRendered: boolean;
  ctaRendered: boolean;
  /** Bounding box of all rendered text/logo/CTA, for the safe-zone check. */
  textBounds: { top: number; bottom: number; left: number; right: number };
  enforceSafeZone: boolean;
  textColor: string;
  /** True when the copy sits on the photograph under a scrim, not on a panel. */
  scrimmed: boolean;
};

/**
 * Per-format art direction. Each is a deliberate layout, not a resize.
 *
 *   1:1   full-bleed hero, copy in the top band over a scrim (feed)
 *   4:5   same treatment, taller canvas                      (portrait feed)
 *   9:16  same again, copy inside the Meta safe zone         (story / reel)
 *   16:9  hero right, brand copy panel left                  (landscape)
 *
 * 9:16 is the demanding one: fitting a square hero to it costs about 41% of the
 * image's width. That is exactly why the crop is centred and why the art
 * direction insists on negative space on all sides -- the product has to
 * survive that crop, and one generation has to serve every format.
 */
/**
 * Meta's UNIFIED 9:16 safe zone: 14% top (~270px), 6% each side (~65px) and up
 * to 35% bottom (~672px) kept free of text, logos and other key elements, so
 * nothing important sits under the profile icon, caption tray or the
 * platform's own call-to-action.
 *
 * In March 2026 Meta consolidated Facebook Stories, Facebook Reels, Instagram
 * Stories and Instagram Reels into this single spec, taking the most
 * restrictive bottom (Reels, 35%) rather than the older Stories-only 20%.
 * Designing to it means ONE 9:16 export is safe across all four vertical
 * placements -- which is the whole point of generating the hero once.
 * Checked 2026-08-28.
 *
 * The photograph itself is full-bleed -- the restriction is on text and logos,
 * not on the image.
 */
const STORY_SAFE_ZONE = { top: 0.14, bottom: 0.35, sides: 0.06 } as const;

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
   * Y coordinate of the disclaimer baseline, or null when the legal line
   * follows the CTA instead of being anchored to the frame.
   *
   * Bottom-anchored on every format except the story, where the Meta safe zone
   * pushes copy up the frame and a fixed baseline stranded the legal line in
   * open photo, mid-frame and low contrast. There it follows the CTA instead,
   * so headline, CTA and disclaimer read as one block on the scrim.
   *
   * One field, not two. It was a coordinate plus a boolean saying to ignore
   * the coordinate, so the story template carried a baseline value nothing
   * could ever read -- and a test compared against it.
   */
  disclaimerY: number | null;
  /** True when this format must honour the Meta 9:16 safe zone. */
  enforceSafeZone: boolean;
  /**
   * True when copy sits on the photograph under a gradient scrim, false when
   * it sits on a solid brand panel. It was a three-state union carrying a
   * "bottom" variant no template returned, which kept about thirty lines of
   * scrim code and a header comment describing a layout that does not exist.
   */
  scrim: boolean;
  maxLines: number;
  maxFontSize: number;
  minFontSize: number;
};

export type { Template };

/**
 * Copy sits in the TOP band on every full-bleed format. That is forced by
 * geometry, not chosen: one hero serves all four, so either the copy zone
 * agrees across formats or the product shrinks until it misses the copy
 * everywhere. Meta reserves the bottom 35% of a 9:16 placement, leaving the top
 * as the only band all three can share. Derivation: docs/CREATIVE_STANDARDS.md
 * section 7.
 */
export function templateFor(ratio: RatioKey): Template {
  const { width, height } = RATIOS[ratio];

  // 1:1 and 4:5 are the same treatment on two canvases -- full-bleed hero,
  // scrim and copy in the top band, lockup top-left. They differ only in the
  // numbers below. Since the copy band moved to the top they stopped differing
  // in anything else, so they share a builder rather than two near-identical
  // literals that could drift apart.
  if (ratio === "1x1" || ratio === "4x5") {
    const square = ratio === "1x1";
    const margin = square ? 72 : 76;
    return {
      hero: { left: 0, top: 0, width, height },
      copy: {
        left: margin,
        top: square ? 268 : 300,
        width: Math.round(width * (square ? 0.68 : 0.7)),
        height: square ? 250 : 260,
      },
      // Top-left lockup, the conventional brand position on a full-bleed post.
      logo: { left: margin, top: margin, maxWidth: 300 },
      ctaGap: 52,
      // Bottom-anchored, unlike the story. Trailing the CTA pushed the legal
      // line into the lower half of the frame, which is exactly where the art
      // direction puts the product -- it was composited across the jar lid on
      // every square creative.
      disclaimerY: height - 46,
      enforceSafeZone: false,
      scrim: true,
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
      disclaimerY: null,
      enforceSafeZone: true,
      scrim: true,
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
    enforceSafeZone: false,
    scrim: false,
    maxLines: 4,
    maxFontSize: 72,
    minFontSize: 36,
  };
}

/**
 * Mean luminance (0-1) of a horizontal band of the hero.
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

  // Fit the copy first: the scrim has to cover the block it makes readable,
  // and that block's height is not known until the headline has been wrapped.
  const fit = fitText(message, tpl.copy.width, tpl.maxLines, tpl.maxFontSize, tpl.minFontSize);
  const geometry = textGeometry(tpl, fit, Boolean(disclaimer), callToAction);

  // 3. Copy zone treatment. On the three full-bleed formats the copy sits on
  //    the photograph, so it needs a gradient scrim sized to the luminance of
  //    the band it will occupy. 16:9 puts it on a brand panel and needs none.
  const textColor = tpl.scrim ? "#FFFFFF" : readableTextColor(brand.primaryColor);

  if (tpl.scrim) {
    // The scrim ends just past the copy, not at the bottom of the frame.
    //
    // It used to fade to `disclaimerY + 260`, which is mid-frame on a 9:16 and
    // the very bottom on a 1:1 -- so when the square formats moved their copy to
    // the top band, their scrim stretched over the whole image and went thin
    // everywhere. White copy then sat on a sunlit plaster wall at almost no
    // contrast.
    //
    // It is `scrimBottom`, not the bottom of the whole text block. Where the
    // legal line is bottom-anchored it has its own foot scrim below, so
    // including it here stretched this gradient across the entire frame again
    // and dimmed the product -- the same defect, arrived at from the other
    // direction, while this comment claimed it was fixed.
    const fade = Math.min(height, geometry.scrimBottom + 200);
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

    // A bottom-anchored legal line sits on bare photo, below where the top
    // scrim reaches. It is the one piece of copy with regulatory weight, so it
    // gets its own short fade instead of depending on whatever the hero
    // happens to put behind it -- measured on this creative it was white on
    // sunlit travertine.
    if (disclaimer && tpl.disclaimerY !== null) {
      // Independent of the copy scrim above it -- they may overlap. Clamping
      // this to `fade` produced a zero-height layer whenever the copy block
      // reached the bottom of the frame, and libvips rejects that outright.
      const footTop = Math.max(0, Math.min(height - 16, geometry.disclaimerY - 78));
      const footHeight = height - footTop;
      const footLum = await bandLuminance(heroBuffer, footTop, footHeight, width);
      const footPeak = scrimOpacity(footLum, 0.55, 0.88);
      const footSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footHeight}">
        <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
          <stop offset="60%" stop-color="#000000" stop-opacity="${(footPeak * 0.8).toFixed(3)}"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="${footPeak}"/>
        </linearGradient></defs>
        <rect width="${width}" height="${footHeight}" fill="url(#f)"/>
      </svg>`;
      layers.push({ input: Buffer.from(footSvg), left: 0, top: footTop });
    }
  } else {
    // Solid brand panel fills the column beside the hero. 16:9 is the only
    // format that takes this branch: the hero is inset from the right edge and
    // everything left of it is panel. The other three are full-bleed and
    // scrimmed, so this used to carry a `ratio === "9x16"` case that nothing
    // could reach.
    const panelWidth = width - tpl.hero.width;
    const panelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${height}">
      <rect width="${panelWidth}" height="${height}" fill="${brand.primaryColor}"/>
    </svg>`;
    layers.push({ input: Buffer.from(panelSvg), left: 0, top: 0 });
  }

  // 4. Text layer, rendered in isolation so we can prove ink actually landed.

  const logoBuffer = await loadLogo(brand, tpl.logo.maxWidth);
  const textLayer = buildTextLayer({
    width,
    height,
    tpl,
    fit,
    geometry,
    textColor,
    accent: brand.secondaryColor,
    callToAction,
    disclaimer,
    headlineFamily: brand.headlineFont ?? DISPLAY_FAMILY,
  });

  const textPng = await sharp(Buffer.from(textLayer.svg)).png().toBuffer();

  // Every element is rasterized ALONE and its ink counted.
  //
  // One combined layer could not prove the campaign message rendered: the CTA
  // pill and the disclaimer draw into the same layer, so their ink alone would
  // satisfy the check while the headline was missing. And `ctaRendered` used to
  // be Boolean(callToAction), which proves the brief had a CTA, not that one
  // reached the pixels. Measuring each separately is the only version of these
  // checks that can actually go red.
  const inkOf = async (svg: string) => inkRatio(await sharp(Buffer.from(svg)).png().toBuffer());
  const headlineInkRatio = await inkOf(textLayer.headlineSvg);
  const textInkRatio = await inkRatio(textPng);
  const ctaInkRatio = textLayer.ctaSvg ? await inkOf(textLayer.ctaSvg) : 0;
  const disclaimerInkRatio = textLayer.disclaimerSvg ? await inkOf(textLayer.disclaimerSvg) : 0;
  // The logo is measured too, and for the same reason. This was the last
  // element still reporting Boolean(fileLoaded): a logo PNG that decoded and
  // resized perfectly but carried no opaque pixels rendered nothing and still
  // reported "Brand logo composited". Sharp already refuses an out-of-bounds
  // composite, so visible ink is the one remaining thing worth measuring.
  const logoInkRatio = logoBuffer ? await inkRatio(logoBuffer) : 0;
  layers.push({ input: textPng, left: 0, top: 0 });

  if (logoBuffer) {
    layers.push({ input: logoBuffer, left: tpl.logo.left, top: tpl.logo.top });
  }

  // Truecolor, deliberately. `quality` on a PNG is not JPEG quality: it puts
  // libvips into palette mode, and every exported creative was coming out
  // quantised to 256 colours. That is invisible on flat artwork and very
  // visible on a soft background falloff, which is most of what the art
  // direction now produces. It also spent 4x the encode time to do it.
  const buffer = await canvas.composite(layers).png().toBuffer();

  return {
    buffer,
    width,
    height,
    renderedMessage: message,
    fontSize: fit.fontSize,
    lines: fit.lines,
    copyFits: fit.fits,
    textInkRatio,
    headlineInkRatio,
    logoRendered: logoInkRatio > 0,
    disclaimerRendered: disclaimerInkRatio > 0,
    ctaRendered: ctaInkRatio > 0,
    enforceSafeZone: tpl.enforceSafeZone,
    scrimmed: tpl.scrim,
    textBounds: {
      top: logoInkRatio > 0 ? tpl.logo.top : tpl.copy.top - 34,
      bottom: geometry.blockBottom,
      left: tpl.copy.left,
      right: tpl.copy.left + tpl.copy.width,
    },
    textColor,
  };
}

/** Gap between the CTA pill and a disclaimer that trails it. */
const DISCLAIMER_GAP = 46;

export type TextGeometry = {
  lineHeight: number;
  /** Baseline of the last headline line. */
  headlineBottom: number;
  ctaFontSize: number;
  ctaPadY: number;
  ctaTop: number;
  /** Bottom of the CTA pill, or the headline baseline when there is no CTA. */
  ctaBottom: number;
  /** Baseline the legal line is actually drawn on. */
  disclaimerY: number;
  /** Lowest pixel any text element occupies. Feeds the safe-zone check. */
  blockBottom: number;
  /**
   * How far down the copy scrim has to stay strong.
   *
   * Not the same as blockBottom. Where the legal line is bottom-anchored it
   * gets its own short foot scrim, so the copy scrim only has to cover the
   * headline and the CTA -- sizing it to blockBottom stretched it over the
   * entire frame, which is the exact failure the code above says it fixed.
   * Where the line trails the CTA it is part of the block and included.
   */
  scrimBottom: number;
};

/**
 * Where every text element lands, computed once.
 *
 * This used to be two functions: buildTextLayer positioned the elements, and
 * textBlockBottom re-derived the same coordinates for the safe-zone check with
 * a comment saying it "has to mirror buildTextLayer exactly". It did not quite
 * -- the CTA height rounded its font size before taking the padding in one and
 * after it in the other, so the two agreed on the sample by arithmetic luck and
 * would have drifted on a different headline size. A check computed from a
 * second copy of the layout is a check on the copy.
 */
export function textGeometry(
  tpl: Template,
  fit: { lines: string[]; fontSize: number },
  hasDisclaimer: boolean,
  callToAction?: string,
): TextGeometry {
  const lineHeight = Math.round(fit.fontSize * 1.16);
  const headlineBottom =
    tpl.copy.top + fit.fontSize + Math.max(0, fit.lines.length - 1) * lineHeight;

  const ctaFontSize = Math.round(Math.max(24, fit.fontSize * 0.36));
  const ctaPadY = Math.round(ctaFontSize * 0.62);
  const ctaTop = headlineBottom + tpl.ctaGap;
  const ctaBottom = callToAction?.trim() ? ctaTop + ctaFontSize + ctaPadY * 2 : headlineBottom;

  // Bottom-anchored, except on the story where it rides with the copy block:
  // a fixed baseline there stranded the legal line in open photo, mid-frame.
  const disclaimerY = tpl.disclaimerY ?? ctaBottom + DISCLAIMER_GAP;

  return {
    lineHeight,
    headlineBottom,
    ctaFontSize,
    ctaPadY,
    ctaTop,
    ctaBottom,
    disclaimerY,
    blockBottom: hasDisclaimer ? disclaimerY : ctaBottom,
    scrimBottom: tpl.disclaimerY === null ? disclaimerY : ctaBottom,
  };
}

function buildTextLayer(args: {
  width: number;
  height: number;
  tpl: Template;
  fit: { lines: string[]; fontSize: number };
  /** Where each element lands. Computed once by textGeometry, never here. */
  geometry: TextGeometry;
  textColor: string;
  accent: string;
  /** The brand's headline face, or the bundled display face. */
  headlineFamily: string;
  callToAction?: string;
  disclaimer?: string;
}): {
  /** What actually gets composited. */
  svg: string;
  /** Each element alone, on the full canvas, so its ink can be counted. */
  headlineSvg: string;
  ctaSvg: string | null;
  disclaimerSvg: string | null;
} {
  const {
    width,
    height,
    tpl,
    fit,
    geometry,
    textColor,
    accent,
    callToAction,
    disclaimer,
    headlineFamily,
  } = args;
  const { lineHeight } = geometry;
  // Two voices, deliberately. The headline is the advertisement speaking; the
  // CTA and the legal line are the interface speaking. Both families are
  // bundled, and fontconfig is pointed only at that directory, so the fallback
  // names below can never actually be reached -- they are there so the SVG is
  // still valid markup if it is ever opened outside this pipeline.
  const display = `${headlineFamily}, Georgia, 'Times New Roman', serif`;
  const font = `${FONT_FAMILY}, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

  const lines = fit.lines
    .map(
      (line, i) =>
        `<text x="${tpl.copy.left}" y="${tpl.copy.top + fit.fontSize + i * lineHeight}" ` +
        `font-family="${display}" font-size="${fit.fontSize}" ` +
        `letter-spacing="-0.2" fill="${textColor}">${escapeXml(line)}</text>`,
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
  if (cta) {
    const { ctaFontSize, ctaPadY, ctaTop, ctaBottom } = geometry;
    const padX = Math.round(ctaFontSize * 0.9);
    const boxW = Math.round(measureText(cta, ctaFontSize, "bold") + padX * 2);
    const boxH = ctaBottom - ctaTop;
    ctaSvg =
      `<rect x="${tpl.copy.left}" y="${ctaTop}" width="${boxW}" height="${boxH}" ` +
      `rx="${Math.round(boxH / 2)}" fill="${accent}"/>` +
      `<text x="${tpl.copy.left + padX}" y="${ctaTop + ctaPadY + ctaFontSize * 0.8}" ` +
      `font-family="${font}" font-size="${ctaFontSize}" font-weight="700" ` +
      `letter-spacing="0.6" fill="#141815">${escapeXml(cta)}</text>`;
  }

  const disclaimerSvg = disclaimer
    ? `<text x="${tpl.copy.left}" y="${geometry.disclaimerY}" font-family="${font}" ` +
      `font-size="24" fill="${textColor}" opacity="0.72">${escapeXml(disclaimer)}</text>`
    : "";

  const canvasSvg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`;

  return {
    svg: canvasSvg(`${rule}\n${lines}\n${ctaSvg}\n${disclaimerSvg}`),
    headlineSvg: canvasSvg(lines),
    ctaSvg: ctaSvg ? canvasSvg(ctaSvg) : null,
    disclaimerSvg: disclaimerSvg ? canvasSvg(disclaimerSvg) : null,
  };
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
async function inkRatio(pngBuffer: Buffer): Promise<number> {
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
