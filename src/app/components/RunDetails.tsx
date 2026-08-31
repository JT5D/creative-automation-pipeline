import { useState } from "react";
import type {
  CampaignReport,
  Insights as InsightsData,
  PipelineEvent,
  RunState,
} from "../types.js";
import { Timeline } from "./Timeline.js";

/**
 * Everything a run produced that is not the answer.
 *
 * Collapsed by default, and that is the design decision worth defending: an
 * operator must never need to open this to know whether the run succeeded --
 * the delivery banner already said so. What lives here is evidence for when
 * the answer is disputed: the event stream, the eleven assignment checks the
 * run asserted about itself, and the reuse rate across every run on this
 * machine.
 */
export function RunDetails({
  report,
  events,
  status,
  insights,
}: {
  report?: CampaignReport;
  events: PipelineEvent[];
  status?: RunState["status"];
  insights: InsightsData | null;
}) {
  const [open, setOpen] = useState(false);
  const proof = report?.assignmentProof;

  const summary = report
    ? `${report.products.length} products · ${(report.durationMs / 1000).toFixed(1)}s · ` +
      `${report.metrics.liveHeroGenerations} live hero generation${report.metrics.liveHeroGenerations === 1 ? "" : "s"} · ` +
      `${report.warnings.length === 0 ? "no warnings" : `${report.warnings.length} warning(s)`}`
    : events.length > 0
      ? `${events.length} events`
      : "nothing has run yet";

  return (
    <section className="details">
      <button type="button" className="details-head" onClick={() => setOpen((o) => !o)}>
        <strong>Run details</strong>
        <span>{summary}</span>
        <span className="caret">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="details-body">
          <div>
            <span className="insp-label">Pipeline events</span>
            <Timeline events={events} status={status} />
          </div>

          {proof && (
            <div>
              <span className="insp-label">
                Assignment proof - asserted by the run, not by this panel
              </span>
              <ul className="checks">
                {proof.checks.map((c) => (
                  <li key={c.id} className={c.passed ? "pass" : "fail"}>
                    <span>{c.passed ? "✓" : "✕"}</span>
                    {c.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights && insights.runs > 0 && (
            <div>
              <span className="insp-label">Across all runs on this machine</span>
              <ul className="checks plain">
                <li>
                  {insights.runs} runs · {insights.creatives} creatives
                </li>
                <li>{Math.round(insights.reuseRate * 100)}% of heroes reused</li>
                <li>
                  {insights.liveHeroGenerations} live hero generations · $
                  {insights.totalCostUsd.toFixed(3)}
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
