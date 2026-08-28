import { useState } from "react";
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
  report_written: "Report written",
  complete: "Campaign complete",
  failed: "Run failed",
};

const VARIANT_EVENTS = new Set(["variant_composing", "variant_saved"]);

/** A run of per-variant events for one product, folded into one line. */
type VariantRow = { kind: "variants"; productId: string; exported: PipelineEvent[] };
type Row = { kind: "event"; event: PipelineEvent } | VariantRow;

/**
 * Folds the per-variant chatter into one row per product.
 *
 * A 24-creative run emits 48 near-identical "composing / exported" lines, which
 * buries the six events that actually tell the story: what was reused, what was
 * generated, and what it cost. The decisions stay expanded; the file-by-file
 * detail is one click away, because it is still worth being able to see.
 */
function fold(events: PipelineEvent[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    if (!VARIANT_EVENTS.has(event.event)) {
      rows.push({ kind: "event", event });
      continue;
    }
    const productId = String(event.detail?.productId ?? "");
    const tail = rows.at(-1);

    let group: VariantRow;
    if (tail?.kind === "variants" && tail.productId === productId) {
      group = tail;
    } else {
      group = { kind: "variants", productId, exported: [] };
      rows.push(group);
    }

    // Composing and exporting are a pair; only the export is worth counting.
    if (event.event === "variant_saved") group.exported.push(event);
  }
  return rows;
}

export function Timeline({
  events,
  status,
}: {
  events: PipelineEvent[];
  status?: RunState["status"];
}) {
  const [open, setOpen] = useState<number | null>(null);

  if (events.length === 0) {
    return (
      <p className="empty">
        <strong>Not started</strong>
        Each step appears here as the pipeline emits it - which asset was reused, which was
        generated, and what that cost.
      </p>
    );
  }

  const rows = fold(events);

  return (
    <ol className="timeline">
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        const spinner = status === "running" && last;

        if (row.kind === "event") {
          const d = row.event.detail ?? {};
          const meta = [d.productId, d.ratio, d.locale].filter(Boolean).join(" · ");
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only log, position is identity
            <li key={i} className={`ev ${row.event.event}`}>
              <span className="tick">
                {spinner ? "◐" : row.event.event === "failed" ? "✕" : "✓"}
              </span>
              <span className="label">{LABELS[row.event.event] ?? row.event.event}</span>
              {meta && <span className="meta">{meta}</span>}
            </li>
          );
        }

        const isOpen = open === i;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only log, position is identity
          <li key={i} className="ev variants">
            <span className="tick">{spinner ? "◐" : "✓"}</span>
            <button type="button" className="label fold" onClick={() => setOpen(isOpen ? null : i)}>
              {row.exported.length} channel variant{row.exported.length === 1 ? "" : "s"} exported
              <span className="caret">{isOpen ? "−" : "+"}</span>
            </button>
            <span className="meta">{row.productId}</span>
            {isOpen && (
              <ul className="fold-detail">
                {row.exported.map((e) => (
                  <li key={String(e.detail?.outputPath)}>{String(e.detail?.outputPath)}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
