import { useState } from "react";
import type { BriefSummary, CampaignEstimate, FormatOption } from "../types.js";

type Props = {
  library: BriefSummary[];
  active: string;
  onSelect: (file: string) => void;
  brief: string;
  onBriefChange: (v: string) => void;
  message: string;
  formats: FormatOption[];
  selectedFormats: string[];
  onToggleFormat: (key: string) => void;
  locales: string[];
  selectedLocales: string[];
  onToggleLocale: (locale: string) => void;
  estimate: CampaignEstimate | null;
  /** Every campaign this run will produce. One is a run; more is a batch. */
  selectedBriefs: string[];
  onToggleBrief: (file: string) => void;
  batchEstimate: {
    campaigns: number;
    refused: number;
    variants: number;
    generations: number;
    costUsd: number;
  } | null;
};

/**
 * What this run is, in one row: which brief, which markets, which formats, and
 * the proposition that will be rasterized into every creative.
 *
 * The raw brief is still a real input contract, so it stays one click away
 * behind Edit source -- but it is a YAML file, and a YAML file is not the
 * default view of a production tool. Selection lives here rather than in a
 * side panel because changing a format or a market is the thing an operator
 * does most, and it has to sit next to what it changes.
 */
export function CampaignStrip(props: Props) {
  const {
    library,
    active,
    onSelect,
    brief,
    onBriefChange,
    message,
    formats,
    selectedFormats,
    onToggleFormat,
    locales,
    selectedLocales,
    onToggleLocale,
    estimate,
    selectedBriefs,
    onToggleBrief,
    batchEstimate,
  } = props;

  const [editing, setEditing] = useState(false);
  const current = library.find((b) => b.file === active);

  return (
    <>
      <div className="strip">
        <div className="cell wide">
          <span className="cell-k">Campaigns</span>
          {/* Checkboxes, not a dropdown. The client in this exercise launches
              hundreds of campaigns a month, and a control that can only hold
              one of them cannot express that. Clicking a label previews that
              brief; the box decides what runs. */}
          <div className="briefs">
            {library.map((b) => (
              <label key={b.file} className={selectedBriefs.includes(b.file) ? "on" : ""}>
                <input
                  type="checkbox"
                  checked={selectedBriefs.includes(b.file)}
                  onChange={() => onToggleBrief(b.file)}
                />
                <button type="button" onClick={() => onSelect(b.file)}>
                  {b.label}
                </button>
              </label>
            ))}
          </div>
          <div className="cell-v">
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Edit source: {current?.label ?? active}
            </button>
          </div>
          {current && <span className="cell-note">{current.expect}</span>}
        </div>

        <div className="cell">
          <span className="cell-k">Markets</span>
          <div className="chips">
            {locales.map((l) => (
              <button
                type="button"
                key={l}
                className={selectedLocales.includes(l) ? "on" : ""}
                onClick={() => onToggleLocale(l)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="cell">
          <span className="cell-k">Formats</span>
          <div className="chips">
            {formats.map((f) => (
              <button
                type="button"
                key={f.key}
                className={selectedFormats.includes(f.key) ? "on" : ""}
                onClick={() => onToggleFormat(f.key)}
                title={`${f.width}×${f.height} · ${f.label}${f.required ? " · required by the exercise" : ""}`}
              >
                {f.key.replace("x", ":")}
              </button>
            ))}
          </div>
          <span className="cell-note">
            Adding a format or a market costs <strong>no extra generation</strong>.
          </span>
        </div>

        <div className="cell wide">
          <span className="cell-k">Message</span>
          <span className="cell-v msg">{message || "-"}</span>
        </div>
      </div>

      {editing && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Edit brief source">
          <button
            type="button"
            className="lb-backdrop"
            aria-label="Close"
            onClick={() => setEditing(false)}
          />
          <div className="modal-inner">
            <div className="modal-head">
              <strong>{current?.label ?? active}</strong>
              <span>{current?.teaches}</span>
            </div>
            <textarea
              className="brief"
              value={brief}
              spellCheck={false}
              onChange={(e) => onBriefChange(e.target.value)}
            />
            <div className="modal-foot">
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Done
              </button>
            </div>
            {estimate && <EstimateCard estimate={estimate} />}
          </div>
        </div>
      )}

      {estimate && !editing && <EstimateCard estimate={estimate} />}

      {/* The batch guardrail: what all of it costs, before any of it is spent. */}
      {batchEstimate && (
        <div className="estimate">
          <div className="est-head">
            <strong>Dry run · {batchEstimate.campaigns} campaigns</strong>
            <span>nothing generated</span>
          </div>
          <div className="est-figs">
            <div>
              <b>{batchEstimate.variants}</b>
              <span>creatives</span>
            </div>
            <div>
              <b>{batchEstimate.generations}</b>
              <span>generations</span>
            </div>
            <div>
              <b>${batchEstimate.costUsd.toFixed(3)}</b>
              <span>est. spend</span>
            </div>
            {batchEstimate.refused > 0 && (
              <div>
                <b>{batchEstimate.refused}</b>
                <span>refused at the gate</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The answer to "what will this cost" - shown before anything is spent. */
function EstimateCard({ estimate: e }: { estimate: CampaignEstimate }) {
  return (
    <div className={`estimate ${e.blocked ? "blocked" : ""}`}>
      <div className="est-head">
        <strong>{e.blocked ? "Blocked at preflight" : "Dry run"}</strong>
        <span>nothing generated</span>
      </div>

      {e.blocked ? (
        <ul className="est-fails">
          {e.preflight.checks
            .filter((c) => c.status === "fail")
            .map((c) => (
              <li key={c.id}>{c.message}</li>
            ))}
        </ul>
      ) : (
        <>
          <div className="est-figs">
            <div>
              <b>{e.variants}</b>
              <span>creatives</span>
            </div>
            <div>
              <b>{e.generations}</b>
              <span>generations</span>
            </div>
            <div>
              <b>{e.estimatedCostUsd ? `$${e.estimatedCostUsd.totalUsd.toFixed(3)}` : "-"}</b>
              <span>est. spend</span>
            </div>
          </div>

          <ul className="est-plan">
            {e.products.map((p) => (
              <li key={p.productId} className={p.action}>
                <span className={`tag ${p.action}`}>
                  {p.action === "reuse" ? "REUSE" : "GENERATE"}
                </span>
                {p.productName}
                <em>
                  {p.action === "reuse"
                    ? p.sourceAssetPath?.split("/").pop()
                    : p.usingReference
                      ? "from packshot reference"
                      : "text-to-image"}
                </em>
              </li>
            ))}
          </ul>

          {e.estimatedTimeSaved && (
            <p className="est-note">
              ≈{Math.round(e.estimatedTimeSaved.savedMinutes)} min saved - illustrative, against a{" "}
              {e.estimatedTimeSaved.baselineMinutesPerCreative} min/creative baseline stated in the
              brief.
            </p>
          )}
        </>
      )}
    </div>
  );
}
