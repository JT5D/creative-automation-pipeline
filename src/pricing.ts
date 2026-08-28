/**
 * Published per-image output pricing, verified against
 * ai.google.dev/gemini-api/docs/pricing on 2026-08-28.
 *
 * One source of truth: the estimator, the report and the model picker all read
 * this, so a quoted price can never disagree with a charged one. Prices are
 * list prices used for a clearly-labelled estimate — never a billed amount.
 */
export const PRICING_SOURCE =
  "ai.google.dev/gemini-api/docs/pricing, 2K output, verified 2026-08-28";

export type ModelOption = {
  id: string;
  label: string;
  usdPer2K: number;
  note: string;
};

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    usdPer2K: 0.134,
    note: "Frontier tier. Best product fidelity — the default.",
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    usdPer2K: 0.101,
    note: "Workhorse. ~25% cheaper, still strong reference adherence.",
  },
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Gemini 3.1 Flash Lite",
    usdPer2K: 0.0336,
    note: "Cheapest. 1K output only — fine for volume drafts.",
  },
  {
    id: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    usdPer2K: 0.039,
    note: "Legacy generation. Kept for cost comparison.",
  },
];

const BY_ID = new Map(MODEL_OPTIONS.map((m) => [m.id, m]));

/** Undefined for any model with no published price — never guessed. */
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
) {
  if (!baselineMinutesPerCreative) return undefined;
  const manualMinutes = baselineMinutesPerCreative * variants;
  const pipelineMinutes = durationMs / 60_000;
  return {
    baselineMinutesPerCreative,
    manualMinutes,
    pipelineMinutes: Number(pipelineMinutes.toFixed(3)),
    savedMinutes: Number((manualMinutes - pipelineMinutes).toFixed(2)),
    basis:
      "Illustrative estimate: manualMinutesPerCreative from the brief × variants " +
      "produced, minus measured pipeline runtime. Not a measured comparison.",
  };
}
