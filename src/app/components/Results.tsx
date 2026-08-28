import { useEffect, useMemo, useState } from "react";
import type { CampaignReport, Creative, ProductRecord } from "../types.js";

/** Compact, filterable gallery of the files that actually shipped. */
export function Results({ report }: { report?: CampaignReport }) {
  const [locale, setLocale] = useState("all");
  const [ratio, setRatio] = useState("all");
  const [zoom, setZoom] = useState<{ creative: Creative; product: ProductRecord } | null>(null);

  const ratios = useMemo(
    () => [...new Set(report?.products.flatMap((p) => p.creatives.map((c) => c.ratio)) ?? [])],
    [report],
  );

  if (!report) return <p className="empty">Exported creatives appear here.</p>;

  const locales = report.markets.map((m) => m.locale);
  const m = report.metrics;

  return (
    <>
      <AssignmentProof proof={report.assignmentProof} />

      <SuccessMetrics report={report} />

      <div className="metrics">
        <Metric v={m.productsProcessed} l="Products" />
        <Metric v={m.marketsProcessed} l="Markets" />
        <Metric v={m.variantsCreated} l="Creatives" />
        <Metric v={m.approvedAssetsReused} l="Reused" />
        <Metric v={m.generationRequests} l="Paid calls" accent />
        <Metric
          v={`${m.validationPassed}/${m.variantsCreated}`}
          l="Passed"
          good={m.validationFailed === 0}
        />
        <Metric v={`${(report.durationMs / 1000).toFixed(1)}s`} l="Elapsed" />
        {report.estimatedCostUsd && (
          <Metric v={`$${report.estimatedCostUsd.totalUsd.toFixed(3)}`} l="Spend" accent />
        )}
      </div>

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
          <p>Everything below shipped anyway.</p>
        </div>
      )}

      <div className="filters">
        {locales.length > 1 && (
          <Chips value={locale} onChange={setLocale} options={locales} allLabel="All markets" />
        )}
        {ratios.length > 1 && (
          <Chips
            value={ratio}
            onChange={setRatio}
            options={ratios}
            allLabel="All formats"
            format={(r) => r.replace("x", ":")}
          />
        )}
      </div>

      <div className="results">
        {report.products.map((product) => {
          const shown = product.creatives.filter(
            (c) =>
              (locale === "all" || c.locale === locale) && (ratio === "all" || c.ratio === ratio),
          );
          if (shown.length === 0) return null;

          return (
            <div key={product.productId} className="product">
              <div className="product-head">
                <h3>{product.productName}</h3>
                <SourceBadge source={product.hero.source} />
                <ReviewBadge product={product} />
              </div>
              <p className="prov">{provenance(product)}</p>

              <div className="grid">
                {shown.map((c) => (
                  <Card
                    key={`${c.ratio}-${c.locale}`}
                    creative={c}
                    product={product}
                    onZoom={() => setZoom({ creative: c, product })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {zoom && (
        <Lightbox creative={zoom.creative} product={zoom.product} onClose={() => setZoom(null)} />
      )}
    </>
  );
}

/**
 * The three success metrics the client asked for, in the client's own words:
 * "time saved, number of campaigns generated, and overall efficiency."
 *
 * Every figure is read from `report.successMetrics`, which is counted off the
 * run. Time saved is the soft one and is labelled as such -- it is derived from
 * the baseline the brief supplies, not from a stopwatch. There is deliberately
 * no CTR or conversion figure here: this pipeline never publishes, so it has no
 * way to know one, and inventing it would be the easiest lie in the project.
 */
function SuccessMetrics({ report }: { report: CampaignReport }) {
  const { timeSaved, campaignsGenerated: c, efficiency: e } = report.successMetrics;
  return (
    <dl className="success">
      {timeSaved && (
        <div>
          <dt>Time saved</dt>
          <dd>{formatMinutes(timeSaved.minutes)}</dd>
          <span>
            illustrative, vs {timeSaved.baselineMinutesPerCreative} min/creative in the brief
          </span>
        </div>
      )}
      <div>
        <dt>Campaigns generated</dt>
        <dd>
          {c.campaigns} campaign · {c.creatives} creatives
        </dd>
        <span>
          across {c.markets} market{c.markets === 1 ? "" : "s"}
        </span>
      </div>
      <div>
        <dt>Efficiency</dt>
        <dd>
          {e.creativesPerGenerationCall ?? "—"} per paid call
          {e.costPerCreativeUsd !== null && ` · $${e.costPerCreativeUsd.toFixed(4)} each`}
        </dd>
        <span>
          {Math.round(e.reuseRate * 100)}% of heroes reused · {e.secondsPerCreative}s per creative
        </span>
      </div>
    </dl>
  );
}

function formatMinutes(min: number): string {
  return min >= 90 ? `${(min / 60).toFixed(1)} hours` : `${Math.round(min)} min`;
}

/**
 * The exercise's own minimum requirements, answered by the run.
 *
 * It reads from `report.assignmentProof`, which is computed from the records
 * on disk -- so this is the run asserting compliance, not the UI claiming it.
 * An offline preview is the interesting case: it produces real files and still
 * reports `passed: false`, because it has not demonstrated the one thing the
 * exercise requires a model for.
 */
function AssignmentProof({ proof }: { proof: CampaignReport["assignmentProof"] }) {
  const [open, setOpen] = useState(false);
  const failed = proof.checks.filter((c) => !c.passed);

  return (
    <div className={`proof ${proof.passed ? "ok" : "no"}`}>
      <button type="button" className="proof-head" onClick={() => setOpen((o) => !o)}>
        <strong>
          {proof.passed
            ? `Assignment proof passed · ${proof.checks.length} checks`
            : `Assignment proof incomplete · ${failed.length} of ${proof.checks.length} not met`}
        </strong>
        <span className="caret">{open ? "−" : "+"}</span>
      </button>
      {!proof.passed && !open && <p className="proof-why">{failed[0]?.message}</p>}
      {open && (
        <ul className="checks">
          {proof.checks.map((c) => (
            <li key={c.id} className={c.passed ? "pass" : "fail"}>
              <span>{c.passed ? "✓" : "✕"}</span>
              {c.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
      ? "AUTO-CLEARED"
      : clean
        ? "REVIEW NEW HERO"
        : "REVIEW REQUIRED";
  return <span className={`review ${label === "AUTO-CLEARED" ? "auto" : "needed"}`}>{label}</span>;
}

function Metric({
  v,
  l,
  accent,
  good,
}: {
  v: string | number;
  l: string;
  accent?: boolean;
  good?: boolean;
}) {
  return (
    <div className={`metric ${accent ? "accent" : ""} ${good ? "good" : ""}`}>
      <span className="v">{v}</span>
      <span className="l">{l}</span>
    </div>
  );
}

function Chips({
  value,
  onChange,
  options,
  allLabel,
  format = (s: string) => s,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel: string;
  format?: (s: string) => string;
}) {
  return (
    <div className="chips">
      <button type="button" className={value === "all" ? "on" : ""} onClick={() => onChange("all")}>
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={value === o ? "on" : ""}
          onClick={() => onChange(o)}
        >
          {format(o)}
        </button>
      ))}
    </div>
  );
}

/**
 * Checks collapse to a single chip by default. Eight checks across two dozen
 * cards is a wall of text nobody reads; one click opens the ones you care about.
 */
function Card({
  creative: c,
  product,
  onZoom,
}: {
  creative: Creative;
  product: ProductRecord;
  onZoom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = c.validation.checks.filter((x) => x.status !== "pass").length;

  return (
    <figure className="card">
      <button
        type="button"
        className="shot"
        onClick={onZoom}
        title="View full size"
        style={{ aspectRatio: `${c.width} / ${c.height}` }}
      >
        <img
          src={`/outputs/${c.outputPath}`}
          alt={`${product.productName} ${c.ratio} ${c.locale}`}
        />
      </button>
      <figcaption>
        <strong>{c.ratio.replace("x", ":")}</strong>
        <span className="loc">{c.locale}</span>
        <span className="dim">
          {c.width}×{c.height}
        </span>
      </figcaption>
      <button
        type="button"
        className={`checkbar ${c.validation.status}`}
        onClick={() => setOpen((o) => !o)}
      >
        {c.validation.status === "pass"
          ? `${c.validation.checks.length} checks passed`
          : `${failed} of ${c.validation.checks.length} need attention`}
        <span className="caret">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ul className="checks">
          {c.validation.checks.map((chk) => (
            <li key={chk.id} className={chk.status}>
              <span>{chk.status === "pass" ? "✓" : chk.status === "warning" ? "!" : "✕"}</span>
              {chk.message}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function Lightbox({
  creative: c,
  product,
  onClose,
}: {
  creative: Creative;
  product: ProductRecord;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={product.productName}>
      <button type="button" className="lb-backdrop" aria-label="Close" onClick={onClose} />
      <div className="lb-inner">
        <img src={`/outputs/${c.outputPath}`} alt={`${product.productName} ${c.ratio}`} />
        <div className="lb-side">
          <h3>{product.productName}</h3>
          <p className="lb-meta">
            {c.ratio.replace("x", ":")} · {c.locale} · {c.width}×{c.height}
            <br />
            <code>{c.outputPath}</code>
          </p>
          <p className="prov">{provenance(product)}</p>
          <ul className="checks">
            {c.validation.checks.map((chk) => (
              <li key={chk.id} className={chk.status}>
                <span>{chk.status === "pass" ? "✓" : chk.status === "warning" ? "!" : "✕"}</span>
                {chk.message}
              </li>
            ))}
          </ul>
          <button type="button" className="ghost" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

function provenance(product: ProductRecord): string {
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
      ? "REUSED"
      : source === "generated"
        ? "GENERATED"
        : source === "placeholder"
          ? "PLACEHOLDER · NO MODEL CALLED"
          : "GENERATED · CACHED";
  return <span className={`badge ${source}`}>{label}</span>;
}
