import { useMemo, useState } from "react";
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
      <div className="metrics">
        <Metric v={m.productsProcessed} l="Products" />
        <Metric v={m.marketsProcessed} l="Markets" />
        <Metric v={m.variantsCreated} l="Creatives" />
        <Metric v={m.approvedAssetsReused} l="Reused" />
        <Metric v={m.generationRequests} l="Paid calls" accent />
        <Metric v={`${m.validationPassed}/${m.variantsCreated}`} l="Passed" accent={m.validationFailed === 0} />
        <Metric v={`${(report.durationMs / 1000).toFixed(1)}s`} l="Elapsed" />
        {report.estimatedCostUsd && (
          <Metric v={`$${report.estimatedCostUsd.totalUsd.toFixed(3)}`} l="Spend" accent />
        )}
      </div>

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
              (locale === "all" || c.locale === locale) &&
              (ratio === "all" || c.ratio === ratio),
          );
          if (shown.length === 0) return null;

          return (
            <div key={product.productId} className="product">
              <div className="product-head">
                <h3>{product.productName}</h3>
                <SourceBadge source={product.hero.source} />
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
        <Lightbox
          creative={zoom.creative}
          product={zoom.product}
          onClose={() => setZoom(null)}
        />
      )}
    </>
  );
}

function Metric({ v, l, accent }: { v: string | number; l: string; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? "accent" : ""}`}>
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
      <button className={value === "all" ? "on" : ""} onClick={() => onChange("all")}>
        {allLabel}
      </button>
      {options.map((o) => (
        <button key={o} className={value === o ? "on" : ""} onClick={() => onChange(o)}>
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
      <button className="shot" onClick={onZoom} title="View full size">
        <img src={`/outputs/${c.outputPath}`} alt={`${product.productName} ${c.ratio} ${c.locale}`} />
      </button>
      <figcaption>
        <strong>{c.ratio.replace("x", ":")}</strong>
        <span className="loc">{c.locale}</span>
        <span className="dim">{c.width}×{c.height}</span>
      </figcaption>
      <button className={`checkbar ${c.validation.status}`} onClick={() => setOpen((o) => !o)}>
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
  return (
    <div className="lightbox" onClick={onClose} role="presentation">
      <div className="lb-inner" onClick={(e) => e.stopPropagation()} role="presentation">
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
          <button className="ghost" onClick={onClose}>Close</button>
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
