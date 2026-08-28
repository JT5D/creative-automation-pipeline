import type { Insights as InsightsData } from "../types.js";

/**
 * Learning across runs, which is the business goal a per-run report cannot
 * serve. Reuse rate is the number that matters: it is the share of heroes
 * served from assets a brand had already approved, and it is what makes the
 * cost curve bend as a catalogue matures.
 */
export function Insights({ data }: { data: InsightsData | null }) {
  if (!data || data.runs === 0) return null;

  const stats: [string, string][] = [
    ["Runs", String(data.runs)],
    ["Campaigns", String(data.campaigns)],
    ["Creatives", String(data.creatives)],
    ["Reuse rate", `${Math.round(data.reuseRate * 100)}%`],
    ["Model calls", String(data.generationRequests)],
    ["Spend", `$${data.totalCostUsd.toFixed(3)}`],
    ["Per creative", `$${data.costPerCreativeUsd.toFixed(4)}`],
  ];
  if (data.totalSavedMinutes > 0) {
    stats.push(["Time saved", `${Math.round(data.totalSavedMinutes / 60)}h`]);
  }

  return (
    <div className="insights">
      <span className="ins-title">Across all runs</span>
      {stats.map(([l, v]) => (
        <span key={l} className="ins">
          <b>{v}</b>
          {l}
        </span>
      ))}
    </div>
  );
}
