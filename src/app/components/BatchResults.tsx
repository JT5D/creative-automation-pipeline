import { useState } from "react";
import { formatUsd } from "../../pricing.js";
import type { BatchCampaign, BatchState } from "../types.js";
import { DeliveryBanner } from "./DeliveryBanner.js";
import { Results, type Selection } from "./Results.js";

/**
 * Several campaigns as one job.
 *
 * The exercise opens with a client launching hundreds of localized campaigns a
 * month. Twenty-four creatives from one brief does not show that; a list of
 * campaigns that all ran from one click does.
 *
 * Rows collapse to a line each, because the point of the view is the count and
 * the spend rather than any individual picture. Expanding a row renders the
 * SAME banner and gallery a single run uses, so there is no second gallery to
 * keep in step with the first.
 */
export function BatchResults({
  batch,
  selected,
  onSelect,
}: {
  batch: BatchState;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  // A batch of one is just a run. Open it, and skip the accordion entirely.
  const single = batch.campaigns.length === 1;
  const [open, setOpen] = useState<string | null>(single ? batch.campaigns[0].file : null);

  const done = batch.campaigns.filter((c) => c.status !== "queued" && c.status !== "running");
  const totals = done.reduce(
    (acc, c) => ({
      creatives: acc.creatives + (c.report?.metrics.variantsCreated ?? 0),
      reused: acc.reused + (c.report?.metrics.approvedAssetsReused ?? 0),
      live: acc.live + (c.report?.metrics.liveHeroGenerations ?? 0),
      cost: acc.cost + (c.report?.estimatedCostUsd?.totalUsd ?? 0),
      refused: acc.refused + (c.status === "refused" ? 1 : 0),
    }),
    { creatives: 0, reused: 0, live: 0, cost: 0, refused: 0 },
  );

  return (
    <div className="batch">
      {!single && (
        <div className="batch-head">
          <strong>
            {done.length}/{batch.campaigns.length} campaigns
            {batch.status === "running" ? " running" : " complete"}
          </strong>
          {/* Counted off the reports, never off what was requested. */}
          <span>
            {totals.creatives} creatives · {totals.reused} heroes reused · {totals.live} generated
            live · {formatUsd(totals.cost)}
            {totals.refused > 0 && ` · ${totals.refused} refused`}
          </span>
        </div>
      )}

      {batch.campaigns.map((campaign) => (
        <CampaignRow
          key={campaign.file}
          campaign={campaign}
          single={single}
          open={open === campaign.file}
          onToggle={() => setOpen(open === campaign.file ? null : campaign.file)}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function CampaignRow({
  campaign,
  single,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  campaign: BatchCampaign;
  single: boolean;
  open: boolean;
  onToggle: () => void;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const m = campaign.report?.metrics;

  return (
    <section className={`brow ${campaign.status}`}>
      {!single && (
        <button type="button" className="brow-head" onClick={onToggle} disabled={!campaign.report}>
          <span className={`bdot ${campaign.status}`} />
          <strong>{campaign.label}</strong>
          <span className="bmeta">
            {campaign.status === "queued" && "queued"}
            {campaign.status === "running" && "running…"}
            {campaign.status === "refused" && "refused at the gate"}
            {m &&
              `${m.variantsCreated} creatives · ${m.approvedAssetsReused} reused · ${m.liveHeroGenerations} generated live`}
          </span>
          {campaign.report && <span className="caret">{open ? "−" : "+"}</span>}
        </button>
      )}

      {/* A refused brief is a correct outcome, so it says which gate stopped it
          rather than presenting as an error the batch failed on. */}
      {campaign.status === "refused" && <p className="brow-refused">{campaign.error}</p>}

      {open && campaign.report && (
        <div className="brow-body">
          <DeliveryBanner report={campaign.report} />
          <Results
            report={campaign.report}
            filterLocale="all"
            filterRatio="all"
            selected={selected}
            onSelect={onSelect}
          />
        </div>
      )}
    </section>
  );
}
