import type { Brand, CampaignBrief, Market, Product } from "./schema.js";

export type SocialCopy = {
  locale: string;
  /** The post body, ready to paste. */
  caption: string;
  hashtags: string[];
  /**
   * Alt text for the post.
   *
   * Derivable honestly because both halves are verified rather than guessed:
   * the product is the one the hero resolved to, and the message is measured
   * present in the pixels by the campaign_message_rasterized check.
   */
  altText: string;
};

/**
 * The words that go beside the picture.
 *
 * A creative is not a post. Producing the image and leaving the copy stops one
 * step short of the thing being automated.
 *
 * Assembled, not generated. Every line is a string the brief already carries
 * and a human already signed off: the market's message, call to action,
 * disclaimer, product and brand. No model runs and nothing is translated at
 * runtime, so no claim appears that was not approved for that market - the only
 * version of this a regulated category could use.
 *
 * Screened by the same prohibited-term scan as the rendered copy, in preflight,
 * before any spend. A caption is published copy.
 */
export function socialCopy(brief: CampaignBrief, product: Product, market: Market): SocialCopy {
  const cta = market.callToAction ?? brief.callToAction;
  const disclaimer = market.disclaimer ?? brief.brand.disclaimer;

  const caption = [
    market.message,
    `${product.name} - ${brief.brand.name}.`,
    cta ? `${cta}.` : "",
    disclaimer,
  ]
    .map((line) => line?.trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    locale: market.locale,
    caption,
    hashtags: hashtags(brief.brand, product),
    altText: `${product.name} by ${brief.brand.name}. Campaign message: "${market.message}"`,
  };
}

/**
 * Tags built only from names the brief supplies.
 *
 * Brand and product, nothing else. The obvious next move is to add the region
 * or a campaign theme, and both would be invented: "#Germany" is not a tag this
 * brand has agreed to appear under, and a made-up campaign hashtag is a
 * marketing decision, not a string transformation. Two owned nouns is what can
 * be derived honestly, so it is what gets derived.
 */
function hashtags(brand: Brand, product: Product): string[] {
  const derived = [pascal(brand.name), pascal(product.name)]
    .filter((t) => t.length > 1)
    .map((t) => `#${t}`);
  // Brief-supplied tags lead, because they are the campaign's own and the
  // derived pair is only ever a floor. Normalised so a brief may write them
  // with or without the hash.
  const stated = brand.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`));
  return [...new Set([...stated, ...derived])];
}

/** "Radiance Vitamin C Serum" -> "RadianceVitaminCSerum". */
function pascal(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
}

/** The pasteable file that ships next to the creatives. */
export function renderCopyFile(copy: SocialCopy): string {
  return `${copy.caption}\n\n${copy.hashtags.join(" ")}\n\nALT: ${copy.altText}\n`;
}
