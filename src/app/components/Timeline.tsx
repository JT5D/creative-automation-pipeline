import type { PipelineEvent, RunState } from "../types.js";

/** Human labels for the events the pipeline actually emits. */
const LABELS: Record<string, string> = {
  brief_validated: "Brief validated",
  preflight_complete: "Preflight checks complete",
  provider_selected: "Generation provider selected",
  asset_resolving: "Resolving hero asset",
  asset_reused: "Approved asset found → REUSED",
  generation_submitted: "No approved hero → generating",
  asset_generated: "Hero generated",
  asset_generated_cached: "Hero from cache (GENERATED · CACHED)",
  variant_composing: "Composing channel variant",
  variant_saved: "Variant exported",
  report_written: "Report written",
  complete: "Campaign complete",
  failed: "Run failed",
};

export function Timeline({
  events,
  status,
}: {
  events: PipelineEvent[];
  status?: RunState["status"];
}) {
  if (events.length === 0) {
    return <p className="empty">Run the campaign to see live pipeline state.</p>;
  }

  return (
    <ol className="timeline">
      {events.map((e, i) => {
        const d = e.detail ?? {};
        const meta = [d.productId, d.ratio, d.locale].filter(Boolean).join(" · ");
        const last = i === events.length - 1;
        return (
          <li key={i} className={`ev ${e.event}`}>
            <span className="tick">
              {status === "running" && last ? "◐" : e.event === "failed" ? "✕" : "✓"}
            </span>
            <span className="label">{LABELS[e.event] ?? e.event}</span>
            {meta && <span className="meta">{meta}</span>}
          </li>
        );
      })}
    </ol>
  );
}
