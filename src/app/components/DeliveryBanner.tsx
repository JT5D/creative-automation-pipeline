import type { CampaignReport } from "../types.js";

/**
 * The five-second answer: are these creatives deliverable, and what did it take.
 *
 * The verdict answers the operator's question -- did everything this run
 * produced pass -- and deliberately not `assignmentProof.passed`, which answers
 * whether this particular run demonstrated every requirement the exercise
 * names. The two come apart whenever a hero is served from cache. The proof is
 * reported underneath, unchanged and just as strict.
 */
export function DeliveryBanner({ report }: { report: CampaignReport }) {
  const m = report.metrics;
  const proof = report.assignmentProof;
  const failedProof = proof.checks.filter((c) => !c.passed);
  const review = report.products.filter((p) => p.hero.source !== "reused").length;

  // Deliverable means every creative passed and no product dropped out. It is
  // not the same question as whether this run demonstrated every assignment
  // requirement, which is what `assignmentProof` answers.
  const shippable = m.validationFailed === 0 && report.failures.length === 0;

  return (
    <div className={`delivery ${shippable ? "ok" : "no"}`}>
      <div className="verdict">
        <span className="tick" aria-hidden="true">
          {shippable ? "✓" : "!"}
        </span>
        <div>
          <strong>{shippable ? "Ready to deliver" : "Not ready to deliver"}</strong>
          <span>
            {shippable
              ? `All ${m.variantsCreated} creatives passed every check`
              : `${m.validationFailed} creative(s) did not pass`}
            {review > 0 && ` · ${review} item${review === 1 ? "" : "s"} awaiting review`}
          </span>
          {!proof.passed && (
            <span className="verdict-proof">
              Assignment proof {proof.checks.length - failedProof.length}/{proof.checks.length} —{" "}
              {failedProof[0]?.message}
            </span>
          )}
        </div>
      </div>

      <div className="dmetrics">
        <Cell v={m.variantsCreated} k="creatives exported" />
        <Cell v={m.approvedAssetsReused} k="approved heroes reused" />
        <Cell
          v={m.heroesGenerated}
          k={m.heroesGenerated === 1 ? "hero generated" : "heroes generated"}
        />
        <Cell v={`${(report.durationMs / 1000).toFixed(1)}s`} k="elapsed" />
        <Cell
          v={`${m.validationPassed}/${m.variantsCreated}`}
          k="creatives passed validation"
          good={m.validationFailed === 0}
        />
        {report.estimatedCostUsd && (
          <Cell v={`$${report.estimatedCostUsd.totalUsd.toFixed(3)}`} k="estimated GenAI cost" />
        )}
      </div>

      <a className="ghost dl" href={`/outputs/${report.campaignId}/report.json`} download>
        report.json
      </a>
    </div>
  );
}

function Cell({ v, k, good }: { v: string | number; k: string; good?: boolean }) {
  return (
    <div className={`dcell ${good ? "good" : ""}`}>
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}
