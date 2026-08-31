/**
 * Published per-image output pricing, verified against
 * ai.google.dev/gemini-api/docs/pricing on 2026-08-28.
 *
 * One source of truth: the estimator, the report and the model picker all read
 * this, so a quoted price can never disagree with a charged one. Prices are
 * list prices used for a clearly-labelled estimate - never a billed amount.
 */
export const PRICING_SOURCE =
  "ai.google.dev/gemini-api/docs/pricing, 2K output, verified 2026-08-28";

/**
 * The output size the Gemini adapter asks for on every call.
 *
 * It is declared here rather than only in the adapter because the model picker
 * has to be able to prove it never offers a model that cannot serve it.
 */
export const REQUESTED_IMAGE_SIZE = "2K";

/**
 * A dollar amount, at the precision the amount actually has.
 *
 * Three decimals is enough for the frontier tier and not for the cheap one:
 * $0.0336 rounds to "$0.034", which overstates it, disagrees with every other
 * place this repo quotes that number, and made a one-generation preview show a
 * total of $0.034 above a unit price of $0.0336. A fourth decimal appears only
 * when it changes the number, and amounts over a dollar are plain currency.
 */
export function formatUsd(usd: number): string {
  if (Math.abs(usd) >= 1) return `$${usd.toFixed(2)}`;
  const three = usd.toFixed(3);
  return `$${Number(three) === Number(usd.toFixed(4)) ? three : usd.toFixed(4)}`;
}

export type ModelOption = {
  id: string;
  label: string;
  usdPer2K: number;
  /** Largest output this model accepts. Published, not inferred. */
  maxImageSize: "1K" | "2K";
  note: string;
};

/**
 * Every model with a published price. Used for costing any model id someone
 * configures - including the ones the runtime picker deliberately does not
 * offer, so a hand-set GEMINI_IMAGE_MODEL is still costed honestly.
 */
const MODEL_CATALOG: ModelOption[] = [
  {
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    usdPer2K: 0.134,
    maxImageSize: "2K",
    note: "Frontier tier. Best product fidelity - the default.",
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    usdPer2K: 0.101,
    maxImageSize: "2K",
    note: "Workhorse. ~25% cheaper, still strong reference adherence.",
  },
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Gemini 3.1 Flash Lite",
    usdPer2K: 0.0336,
    maxImageSize: "1K",
    note: "Cheapest, but 1K only - cannot serve this pipeline's 2K hero.",
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    usdPer2K: 0.039,
    maxImageSize: "1K",
    note: "Legacy generation, capped at 1024×1024. Kept for cost comparison.",
  },
];

/**
 * What the console may actually select.
 *
 * Derived, not hand-maintained: a model whose published ceiling is below the
 * size the adapter requests would fail at the API, so it is never offered.
 * That is the whole reason `maxImageSize` exists.
 */
export const MODEL_OPTIONS: ModelOption[] = MODEL_CATALOG.filter(
  (m) => m.maxImageSize === REQUESTED_IMAGE_SIZE,
);

/**
 * The cheapest model that can serve a 1K preview.
 *
 * Derived rather than named, so adding a cheaper 1K model to the catalogue
 * moves the preview onto it without anyone remembering to. At the time of
 * writing that is gemini-3.1-flash-lite-image at $0.0336 - a quarter of the
 * frontier tier, which is the whole point: iterate on art direction at three
 * cents and spend thirteen only on what ships.
 */
export const PREVIEW_MODEL: ModelOption = MODEL_CATALOG.filter((m) => m.maxImageSize === "1K").sort(
  (a, b) => a.usdPer2K - b.usdPer2K,
)[0];

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

/** Undefined for any model with no published price - never guessed. */
export function priceFor(model: string): number | undefined {
  return BY_ID.get(model)?.usdPer2K;
}

export function costEstimate(model: string, generations: number) {
  const unitPriceUsd = priceFor(model);
  if (unitPriceUsd === undefined) return undefined;
  return {
    generations,
    unitPriceUsd,
    totalUsd: Number((generations * unitPriceUsd).toFixed(4)),
    source: PRICING_SOURCE,
  };
}

/**
 * Time saved against a baseline the brief has to supply. Returns nothing when
 * it does not, because inventing a baseline would make the number fiction.
 */
export function timeSavedEstimate(
  baselineMinutesPerCreative: number | undefined,
  variants: number,
  durationMs: number,
  hourlyRateUsd?: number,
) {
  if (!baselineMinutesPerCreative) return undefined;
  const manualMinutes = baselineMinutesPerCreative * variants;
  const pipelineMinutes = durationMs / 60_000;
  const savedMinutes = Number((manualMinutes - pipelineMinutes).toFixed(2));
  return {
    baselineMinutesPerCreative,
    manualMinutes,
    pipelineMinutes: Number(pipelineMinutes.toFixed(3)),
    savedMinutes,
    // Only when the brief states a rate. No rate, no money figure.
    savedUsd: hourlyRateUsd ? Number(((savedMinutes / 60) * hourlyRateUsd).toFixed(2)) : undefined,
    hourlyRateUsd,
    basis:
      "Illustrative estimate: manualMinutesPerCreative from the brief × variants " +
      "produced, minus measured pipeline runtime. Not a measured comparison.",
  };
}
