import type { CampaignReport, Creative, ProductRecord } from "../types.js";

export type Selection = { creative: Creative; product: ProductRecord };

/**
 * The exported files, grouped by product, at their true aspect ratio.
 *
 * These are the largest thing on screen because they are what the run is for.
 * Cards carry no check list any more -- that detail moved to the inspector,
 * where it applies to one creative instead of stacking eight lines under each
 * of twenty-four.
 */
export function Results({
  report,
  filterLocale,
  filterRatio,
  selected,
  onSelect,
}: {
  report?: CampaignReport;
  filterLocale: string;
  filterRatio: string;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  if (!report)
    return (
      <p className="empty">
        <strong>No creatives yet</strong>
        Run the campaign to produce them. Every file shown here is read from disk, not re-rendered
        in the browser.
      </p>
    );

  return (
    <>
      {report.failures.length > 0 && (
        <div className="failures">
          <strong>{report.failures.length} product(s) did not complete</strong>
          <ul>
            {report.failures.map((f) => (
              <li key={f.productId}>
                <b>{f.productName}</b> — {f.message}
              </li>
            ))}
          </ul>
          <p>Every other product was still exported.</p>
        </div>
      )}

      <div className="workspace">
        {report.products.map((product) => {
          const shown = product.creatives.filter(
            (c) =>
              (filterLocale === "all" || c.locale === filterLocale) &&
              (filterRatio === "all" || c.ratio === filterRatio),
          );
          if (shown.length === 0) return null;

          return (
            <section key={product.productId} className="product">
              <div className="product-head">
                <div>
                  <h3>{product.productName}</h3>
                  <p className="prov">{provenance(product)}</p>
                </div>
                <SourceBadge source={product.hero.source} />
                <ReviewBadge product={product} />
              </div>

              <div className="shots">
                {shown.map((c) => {
                  const on =
                    selected?.creative.outputPath === c.outputPath &&
                    selected?.product.productId === product.productId;
                  return (
                    <button
                      type="button"
                      key={`${c.ratio}-${c.locale}`}
                      className={`shot ${on ? "on" : ""}`}
                      style={{
                        flexBasis: `${BASIS[c.ratio] ?? 236}px`,
                        flexGrow: BASIS[c.ratio] ?? 236,
                      }}
                      onClick={() => onSelect({ creative: c, product })}
                    >
                      <span className="frame" style={{ aspectRatio: `${c.width} / ${c.height}` }}>
                        <img
                          src={`/outputs/${c.outputPath}`}
                          alt={`${product.productName} ${c.ratio} ${c.locale}`}
                        />
                      </span>
                      <span className="cap">
                        <b>{c.ratio.replace("x", ":")}</b>
                        <span className="loc">{c.locale}</span>
                        <span className={`dot ${c.validation.status}`} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

/**
 * Flex bases in the ratio's own proportion, so a row of mixed formats stays
 * aspect-true and equal-height at any width without a media query. These are
 * bases, never heights -- the cards grow past them to fill the row.
 */
const BASIS: Record<string, number> = { "1x1": 236, "4x5": 190, "9x16": 133, "16x9": 420 };

/**
 * The brief names slow approval cycles as a pain point, so say plainly which
 * products a human still has to look at. Derived here rather than stored:
 * anything a new model produced, or anything that did not pass cleanly, needs
 * eyes. Reused approved assets that passed every check do not.
 */
function ReviewBadge({ product }: { product: ProductRecord }) {
  const clean = product.creatives.every((c) => c.validation.status === "pass");
  const label =
    product.hero.source === "reused" && clean
      ? "Approved source"
      : clean
        ? "Review generated hero"
        : "Review required";
  return (
    <span className={`review ${label === "Approved source" ? "auto" : "needed"}`}>{label}</span>
  );
}

export function provenance(product: ProductRecord): string {
  const h = product.hero;
  if (h.source === "reused") {
    return `Reused approved asset · ${h.sourceAssetPath?.split("/").pop() ?? ""}`;
  }
  const g = h.generation;
  return `${g?.provider} · ${g?.model} · ${g?.operation} · ${((g?.durationMs ?? 0) / 1000).toFixed(1)}s`;
}

function SourceBadge({ source }: { source: string }) {
  const label =
    source === "reused"
      ? "Reused"
      : source === "generated"
        ? "Generated"
        : source === "placeholder"
          ? "Offline preview — not a GenAI run"
          : "Generated earlier · review";
  return <span className={`badge ${source}`}>{label}</span>;
}
