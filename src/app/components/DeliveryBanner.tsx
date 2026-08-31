import type { CampaignReport } from "../types.js";

/**
 * The five-second answer: what this run produced, and who has to look at it next.
 *
 * Three states, because two were a lie. The old banner could say "Ready to
 * deliver" and "1 item awaiting review" in the same breath -- software does not
 * grant approval, and a freshly generated hero has not been signed off by
 * anyone. It also said "passed every check" off a count that ignored warnings,
 * which is the same defect this project keeps finding: a label broader than the
 * measurement underneath it.
 *
 * The verdict answers the operator's question -- is this work finished, and by
 * whom -- and deliberately not `assignmentProof.passed`, which answers whether
 * this particular run demonstrated every requirement the exercise names. The
 * two come apart whenever a hero is served from cache. The proof is reported
 * underneath, unchanged and just as strict.
 */
export function DeliveryBanner({
  report,
  restored,
}: {
  report: CampaignReport;
  /** Read back off disk rather than produced by this session. */
  restored?: boolean;
}) {
  const m = report.metrics;
  const proof = report.assignmentProof;
  const failedProof = proof.checks.filter((c) => !c.passed);

  // A hero this run did not take from an already-approved asset is new creative
  // work. It is validated, not approved.
  const review = report.products.filter((p) => p.hero.source !== "reused").length;
  const blocked = m.validationFailed > 0 || report.failures.length > 0;

  // The three metrics the assessment names are time saved, campaigns generated
  // and efficiency. Two of them were only reachable by opening report.json.
  const saved = report.successMetrics?.timeSaved;
  const state = blocked ? "no" : review > 0 ? "review" : "ok";
  const heading = blocked ? "Blocked" : review > 0 ? "Review required" : "Production complete";

  return (
    <div className={`delivery ${state}`}>
      <div className="verdict">
        <span className="tick" aria-hidden="true">
          {state === "ok" ? "✓" : state === "review" ? "◆" : "!"}
        </span>
        <div>
          <strong>{heading}</strong>
          {/* A finished run loaded from outputs/ is real, but it is not
              something that just happened in front of you, and a banner that
              cannot tell the two apart is a status that cannot report the
              truth. Says which one it is, and when. */}
          {restored && (
            <span className="restored">
              Loaded from disk. Completed {new Date(report.completedAt).toLocaleString()}.
            </span>
          )}
          {/* Exact counts only. Every clause below names the number it read. */}
          <span>
            {m.variantsCreated} creative{m.variantsCreated === 1 ? "" : "s"} exported ·{" "}
            {m.validationFailed} failed automated validation
            {m.validationWarnings > 0 && ` · ${m.validationWarnings} with warnings`}
            {report.failures.length > 0 &&
              ` · ${report.failures.length} product${report.failures.length === 1 ? "" : "s"} did not complete`}
          </span>
          {review > 0 && !blocked && (
            <span>
              {review} generated hero{review === 1 ? "" : "es"} need
              {review === 1 ? "s" : ""} human sign-off before publication
            </span>
          )}
          {!proof.passed && (
            <span className="verdict-proof">
              Assignment proof {proof.checks.length - failedProof.length}/{proof.checks.length} -{" "}
              {failedProof[0]?.message}
            </span>
          )}
        </div>

        <div className="dl-group">
          {/* A producer collects the folder, not one file at a time. */}
          <a className="ghost dl" href={`/api/campaigns/${report.campaignId}/archive`} download>
            Download all {m.variantsCreated}
          </a>
          <a className="ghost dl" href={`/outputs/${report.campaignId}/report.json`} download>
            report.json
          </a>
        </div>
      </div>

      <div className="dmetrics">
        <Cell v={m.variantsCreated} k="creatives exported" />
        <Cell
          v={m.approvedAssetsReused}
          k={m.approvedAssetsReused === 1 ? "approved hero reused" : "approved heroes reused"}
        />
        <Cell
          v={m.liveHeroGenerations}
          k={m.liveHeroGenerations === 1 ? "hero generated live" : "heroes generated live"}
        />
        <Cell v={`${(report.durationMs / 1000).toFixed(1)}s`} k="elapsed" />
        {/*
         * The two largest numbers on this banner are the two that were never
         * measured. They are the brief's own stated baseline multiplied out,
         * and saying "studio time saved" and "labour cost avoided" states them
         * as achievements. "estimated" is doing real work in these two labels:
         * it is the difference between a figure this pipeline observed and a
         * figure the client supplied an assumption for. The estimate panel
         * already says "illustrative"; the banner has to say it too, because
         * this is the screen a reviewer photographs.
         */}
        {saved && <Cell v={fmtHours(saved.minutes)} k="studio time saved (est.)" good />}
        {saved?.usd !== undefined && (
          <Cell v={`$${saved.usd.toLocaleString()}`} k="labour cost avoided (est.)" good />
        )}
        <Cell
          v={`${m.validationPassed}/${m.variantsCreated}`}
          k="creatives passed validation"
          good={m.validationFailed === 0}
        />
        {report.estimatedCostUsd && (
          <Cell v={`$${report.estimatedCostUsd.totalUsd.toFixed(3)}`} k="estimated GenAI cost" />
        )}
      </div>
    </div>
  );
}

/** Minutes read as noise past about an hour; hours are what a producer plans in. */
function fmtHours(minutes: number) {
  return minutes >= 90 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`;
}

function Cell({ v, k, good }: { v: string | number; k: string; good?: boolean }) {
  return (
    <div className={`dcell ${good ? "good" : ""}`}>
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}
