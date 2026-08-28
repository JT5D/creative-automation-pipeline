import type { BriefSummary, CampaignEstimate, FormatOption } from "../types.js";

type Props = {
  library: BriefSummary[];
  active: string;
  onSelect: (file: string) => void;
  brief: string;
  onBriefChange: (v: string) => void;
  formats: FormatOption[];
  selectedFormats: string[];
  onToggleFormat: (key: string) => void;
  locales: string[];
  selectedLocales: string[];
  onToggleLocale: (locale: string) => void;
  estimate: CampaignEstimate | null;
  onEstimate: () => void;
  onRun: () => void;
  busy: boolean;
  running: boolean;
};

/**
 * Everything that happens before a run: pick a brief, edit it, choose what to
 * produce, and see what it will cost.
 */
export function BriefPanel(props: Props) {
  const {
    library,
    active,
    onSelect,
    brief,
    onBriefChange,
    formats,
    selectedFormats,
    onToggleFormat,
    locales,
    selectedLocales,
    onToggleLocale,
    estimate,
    onEstimate,
    onRun,
    busy,
    running,
  } = props;

  const current = library.find((b) => b.file === active);

  return (
    <section className="panel">
      <h2>1 · Campaign brief</h2>

      {library.length > 0 && (
        <>
          <div className="briefs">
            {library.map((b) => (
              <button
                type="button"
                key={b.file}
                className={active === b.file ? "on" : ""}
                onClick={() => onSelect(b.file)}
                title={b.teaches}
              >
                {b.label}
                {/* What the FULL brief produces — every format, every market.
                    A test asserts each of these against a real run. The current
                    selection is narrower by default; the hint below says so. */}
                <em title="the full brief: every format, every market">{b.expect}</em>
              </button>
            ))}
          </div>
          {current && <p className="teaches">{current.teaches}</p>}
        </>
      )}

      <textarea
        className="brief"
        value={brief}
        spellCheck={false}
        onChange={(e) => onBriefChange(e.target.value)}
      />

      <div className="opts">
        <div className="opt">
          <span className="opt-label">Formats</span>
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
        </div>

        {locales.length > 1 && (
          <div className="opt">
            <span className="opt-label">Markets</span>
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
        )}
      </div>

      <p className="hint">
        1:1, 9:16 and 16:9 are the three the exercise requires, and one market covers the English
        message — that is the run selected now. Adding 4:5 or another market multiplies the output
        at <strong>no extra generation</strong>.
      </p>

      <div className="actions">
        <button type="button" className="ghost" onClick={onEstimate} disabled={busy}>
          Estimate
        </button>
        <button type="button" className="run" onClick={onRun} disabled={busy || !brief.trim()}>
          {running ? "Running…" : "Run campaign"}
        </button>
      </div>

      {estimate && <EstimateCard estimate={estimate} />}
    </section>
  );
}

/** The answer to "what will this cost" — shown before anything is spent. */
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
              <b>{e.estimatedCostUsd ? `$${e.estimatedCostUsd.totalUsd.toFixed(3)}` : "—"}</b>
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
              ≈{Math.round(e.estimatedTimeSaved.savedMinutes)} min saved — illustrative, against a{" "}
              {e.estimatedTimeSaved.baselineMinutesPerCreative} min/creative baseline stated in the
              brief.
            </p>
          )}
        </>
      )}
    </div>
  );
}
