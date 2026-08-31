import { useRef, useState } from "react";
import { formatUsd } from "../../pricing.js";
import type { BriefSummary, CampaignEstimate, FormatOption, LookOption } from "../types.js";

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
  /**
   * Supply an approved hero for a product the run would otherwise pay to
   * generate.
   *
   * The same write the Inspector offers, placed where the decision is visible
   * rather than three steps past the moment a person can see that this product
   * is about to cost money. A capability nobody can find is not a capability.
   */
  onApproveAsset: (productId: string, file: File) => Promise<void>;
  looks: LookOption[];
  look: string;
  onLook: (id: string) => void;
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
/**
 * Hand the run an approved hero for one product, before it spends anything.
 *
 * Deliberately a plain file input behind a button rather than a drop zone: the
 * whole point is that the reuse branch is a real filesystem check, and the
 * shortest way to show that is to put a file on disk and let the next estimate
 * flip the row from GENERATE to REUSE on its own.
 */
function SupplyHero({
  productId,
  onApproveAsset,
}: {
  productId: string;
  onApproveAsset: (productId: string, file: File) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await onApproveAsset(productId, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => send(e.target.files?.[0])}
      />
      <button
        type="button"
        className="supply"
        onClick={() => input.current?.click()}
        disabled={busy}
        title="Supply an approved hero for this product. The next run reuses it instead of paying to generate one."
      >
        {busy ? "Saving…" : "Supply approved hero"}
      </button>
      {error && <span className="err">{error}</span>}
    </>
  );
}

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
    onApproveAsset,
    looks,
    look,
    onLook,
  } = props;

  const [editing, setEditing] = useState(false);
  const current = library.find((b) => b.file === active);

  return (
    <>
      {/*
       * The control rail: what runs, who it is for, where it goes, what it
       * costs. Read top to bottom it is the brief itself, in the order a
       * producer fills one in, and it sits beside the creatives rather than
       * above them so the work is never pushed off the screen by its controls.
       */}
      <div className="rail">
        <section className="rail-block">
          <span className="rail-k">Campaign</span>
          {/* Checkboxes, not a dropdown. The client in this exercise launches
              hundreds of campaigns a month, and a control that can only hold
              one of them cannot express that. Clicking a name previews that
              brief; the box decides what runs. */}
          <div className="briefs">
            {library.map((b) => (
              <label key={b.file} className={selectedBriefs.includes(b.file) ? "on" : ""}>
                <input
                  type="checkbox"
                  checked={selectedBriefs.includes(b.file)}
                  onChange={() => onToggleBrief(b.file)}
                />
                <span className="brief-body">
                  <button type="button" onClick={() => onSelect(b.file)}>
                    {b.label}
                  </button>
                  <em>{b.expect}</em>
                </span>
              </label>
            ))}
          </div>
          <button type="button" className="link" onClick={() => setEditing(true)}>
            Edit source: {current?.file ?? active}
          </button>
        </section>

        {/* Audience and objective are two of the four things the exercise
            requires a brief to carry, and both were readable only by opening
            the YAML. They are inputs to the prompt, so they belong beside the
            proposition rather than behind Edit source. */}
        <section className="rail-block">
          <span className="rail-k">Campaign message</span>
          <p className="rail-msg">{message || "-"}</p>
          {estimate?.region && (
            <span className="rail-sub">
              <b>Region</b> {estimate.region}
            </span>
          )}
          {estimate?.audience && (
            <span className="rail-sub">
              <b>Audience</b> {estimate.audience}
            </span>
          )}
          {estimate?.objective && (
            <span className="rail-sub">
              <b>Objective</b> {estimate.objective}
            </span>
          )}
        </section>

        {/* Art direction sits with the brief it directs, not in the app
            chrome. It is a property of this run in exactly the way the markets
            and the formats are. */}
        {looks.length > 0 && (
          <section className="rail-block">
            <span className="rail-k">Art direction</span>
            <select
              className="rail-select"
              value={look}
              onChange={(e) => onLook(e.target.value)}
              title="The brief's own look is used unless you pick one."
            >
              <option value="">From the brief</option>
              {looks.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="rail-note">
              {looks.find((l) => l.id === look)?.description ??
                "One word that sets optics, light, set and grade together."}
            </span>
          </section>
        )}

        <section className="rail-block">
          <span className="rail-k">Markets</span>
          {locales.length > 0 ? (
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
          ) : (
            /* A brief with no `markets:` block still runs, in one market
               derived from its region. An empty panel under a label reads as
               broken, and this brief is not broken. */
            <span className="rail-note">
              {estimate?.locales.join(" · ") ?? "One market, from the brief's region."}
            </span>
          )}
        </section>

        <section className="rail-block">
          <span className="rail-k">Formats</span>
          <div className="chips">
            {formats.map((f) => (
              <button
                type="button"
                key={f.key}
                className={selectedFormats.includes(f.key) ? "on" : ""}
                onClick={() => onToggleFormat(f.key)}
                title={`${f.width}x${f.height} · ${f.label}${f.required ? " · required by the exercise" : ""}`}
              >
                {f.key.replace("x", ":")}
              </button>
            ))}
          </div>
          <span className="rail-note">
            Another format or market costs <strong>no extra generation</strong>.
          </span>
        </section>

        {estimate && !editing && (
          <EstimateCard estimate={estimate} onApproveAsset={onApproveAsset} />
        )}

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
                <b>{formatUsd(batchEstimate.costUsd)}</b>
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
            {estimate && <EstimateCard estimate={estimate} onApproveAsset={onApproveAsset} />}
          </div>
        </div>
      )}
    </>
  );
}

/** The answer to "what will this cost" - shown before anything is spent. */
function EstimateCard({
  estimate: e,
  onApproveAsset,
}: {
  estimate: CampaignEstimate;
  onApproveAsset: (productId: string, file: File) => Promise<void>;
}) {
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
            {/* The total, then the arithmetic that produced it, on its own row.
                A unit price on its own next to "24 creatives" invites the
                reader to multiply the wrong pair of numbers and arrive at
                $3.22 for a run that costs $0.134, so the count that is actually
                charged stays visible: missing heroes, never outputs. */}
            <div className="spend">
              <b>{e.estimatedCostUsd ? formatUsd(e.estimatedCostUsd.totalUsd) : "-"}</b>
              <span>est. spend</span>
              {e.estimatedCostUsd && (
                <em>
                  {e.estimatedCostUsd.generations} × {formatUsd(e.estimatedCostUsd.unitPriceUsd)}{" "}
                  per image
                </em>
              )}
            </div>
          </div>

          {/* What the money actually buys, readable before it is spent. The
              estimate has carried the exact prompt since it was added; the
              console never showed it, so the one decision with a real cost
              attached stayed the least inspectable thing on screen. */}
          <details className="est-art">
            <summary>
              Art direction: {e.look}
              {e.overriddenSlots.length > 0
                ? ` · ${e.overriddenSlots.length} slot${e.overriddenSlots.length > 1 ? "s" : ""} overridden by the brief (${e.overriddenSlots.join(", ")})`
                : " · nothing overridden"}
            </summary>
            {e.products.filter((p) => p.prompt).length === 0 ? (
              <pre>Every product reuses an approved hero, so no prompt is sent.</pre>
            ) : (
              e.products
                .filter((p) => p.prompt)
                .map((p) => (
                  <pre key={p.productId}>
                    {p.productName}
                    {"\n\n"}
                    {p.prompt}
                  </pre>
                ))
            )}
          </details>

          <ul className="est-plan">
            {e.products.map((p) => (
              <li key={p.productId} className={p.action}>
                <span className={`tag ${p.action}`}>
                  {p.action === "reuse" ? "REUSE" : "GENERATE"}
                </span>
                {p.productName}
                {p.action === "generate" && (
                  <SupplyHero productId={p.productId} onApproveAsset={onApproveAsset} />
                )}
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
