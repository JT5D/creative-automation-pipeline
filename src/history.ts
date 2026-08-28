import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CampaignReport } from "./report.js";

/**
 * Append-only run history.
 *
 * The per-run report answers "what happened this time". The business goal the
 * brief actually states is learning across runs -- how much of the catalogue is
 * already approved, what that saves, and whether it is improving. One JSONL
 * line per run is enough for that and needs no database.
 */
export type RunHistoryEntry = {
  at: string;
  campaignId: string;
  campaignName: string;
  mode: "dev" | "final" | "preview";
  provider: string;
  model: string;
  products: number;
  markets: number;
  formats: number;
  variants: number;
  reused: number;
  generated: number;
  liveHeroGenerations: number;
  costUsd: number;
  durationMs: number;
  savedMinutes: number;
  validationPassed: number;
  validationFailed: number;
};

export type Insights = {
  runs: number;
  campaigns: number;
  creatives: number;
  liveHeroGenerations: number;
  /** Share of heroes served from already-approved assets. The thesis metric. */
  reuseRate: number;
  totalCostUsd: number;
  costPerCreativeUsd: number;
  totalSavedMinutes: number;
  avgDurationMs: number;
  history: RunHistoryEntry[];
};

const FILE = "runs.jsonl";

export async function recordRun(report: CampaignReport, outputRoot: string): Promise<void> {
  const m = report.metrics;
  const entry: RunHistoryEntry = {
    at: report.completedAt,
    campaignId: report.campaignId,
    campaignName: report.campaignName,
    mode: report.mode,
    provider: report.provider.provider,
    model: report.provider.model,
    products: m.productsProcessed,
    markets: m.marketsProcessed,
    formats: m.variantsCreated / Math.max(1, m.productsProcessed * m.marketsProcessed),
    variants: m.variantsCreated,
    reused: m.approvedAssetsReused,
    generated: m.heroesGenerated + m.heroesFromCache + m.heroesPlaceholder,
    liveHeroGenerations: m.liveHeroGenerations,
    costUsd: report.estimatedCostUsd?.totalUsd ?? 0,
    durationMs: report.durationMs,
    savedMinutes: report.estimatedTimeSaved?.savedMinutes ?? 0,
    validationPassed: m.validationPassed,
    validationFailed: m.validationFailed,
  };

  await mkdir(outputRoot, { recursive: true });
  await appendFile(path.join(outputRoot, FILE), `${JSON.stringify(entry)}\n`);
}

export async function readInsights(outputRoot: string): Promise<Insights> {
  let lines: string[] = [];
  try {
    lines = (await readFile(path.join(outputRoot, FILE), "utf8")).split("\n").filter(Boolean);
  } catch {
    // No history yet is a normal state, not an error.
  }

  const history = lines
    .map((l) => {
      try {
        return JSON.parse(l) as RunHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is RunHistoryEntry => e !== null);

  const sum = (pick: (e: RunHistoryEntry) => number) => history.reduce((a, e) => a + pick(e), 0);

  const creatives = sum((e) => e.variants);
  const heroes = sum((e) => e.reused + e.generated);
  const totalCostUsd = Number(sum((e) => e.costUsd).toFixed(4));

  return {
    runs: history.length,
    campaigns: new Set(history.map((e) => e.campaignId)).size,
    creatives,
    liveHeroGenerations: sum((e) => e.liveHeroGenerations),
    reuseRate: heroes === 0 ? 0 : Number((sum((e) => e.reused) / heroes).toFixed(4)),
    totalCostUsd,
    costPerCreativeUsd: creatives === 0 ? 0 : Number((totalCostUsd / creatives).toFixed(5)),
    totalSavedMinutes: Number(sum((e) => e.savedMinutes).toFixed(1)),
    avgDurationMs: history.length === 0 ? 0 : Math.round(sum((e) => e.durationMs) / history.length),
    history: history.slice(-25).reverse(),
  };
}
