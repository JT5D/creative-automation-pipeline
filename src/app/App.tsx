import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignReport, PipelineEvent, ProviderStatus, RunState } from "./types.js";

const POLL_MS = 750;

/** Human labels for the events the pipeline actually emits. */
const EVENT_LABELS: Record<string, string> = {
  brief_validated: "Brief validated",
  preflight_complete: "Preflight checks complete",
  provider_selected: "Generation provider selected",
  asset_resolving: "Resolving hero asset",
  asset_reused: "Approved asset found → REUSED",
  generation_submitted: "No approved hero → generating",
  asset_generated: "Hero generated",
  asset_generated_cached: "Hero from cache (GENERATED · CACHED)",
  variant_composing: "Composing channel variant",
  variant_saved: "Variant exported",
  report_written: "Report written",
  complete: "Campaign complete",
  failed: "Run failed",
};

export function App() {
  const [brief, setBrief] = useState("");
  const [locale, setLocale] = useState<string>("all");
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/sample-brief").then((r) => r.text()).then(setBrief).catch(() => {});
    fetch("/api/provider").then((r) => r.json()).then(setProvider).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const poll = useCallback((runId: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const res = await fetch(`/api/runs/${runId}`);
      if (!res.ok) return;
      const state: RunState = await res.json();
      setRun(state);
      if (state.status !== "running" && timer.current) clearInterval(timer.current);
    }, POLL_MS);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setRun(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to start run");
      return;
    }
    const { runId } = await res.json();
    poll(runId);
  }, [brief, poll]);

  const running = run?.status === "running";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>Creative Automation Pipeline</h1>
            <p>Brief → approved-asset reuse → GenAI for what is missing → channel variants</p>
          </div>
        </div>
        <ProviderPill provider={provider} />
      </header>

      <main className="columns">
        <section className="panel">
          <h2>1 · Campaign brief</h2>
          <p className="hint">YAML or JSON. Edit freely — it is parsed and validated on run.</p>
          <textarea
            className="brief"
            value={brief}
            spellCheck={false}
            onChange={(e) => setBrief(e.target.value)}
          />
          <button className="run" onClick={start} disabled={running || !brief.trim()}>
            {running ? "Running…" : "Run campaign"}
          </button>
          {error && <p className="error">{error}</p>}
          {run?.error && <p className="error">{run.error}</p>}
        </section>

        <section className="panel">
          <h2>2 · Pipeline</h2>
          <p className="hint">Live events emitted by the running pipeline.</p>
          <Timeline events={run?.events ?? []} status={run?.status} />
        </section>

        <section className="panel wide">
          <h2>3 · Creative results</h2>
          <p className="hint">Actual exported files, served from disk.</p>
          <Results report={run?.report} locale={locale} onLocale={setLocale} />
        </section>
      </main>

      {run?.report && <Summary report={run.report} />}
    </div>
  );
}

function ProviderPill({ provider }: { provider: ProviderStatus | null }) {
  if (!provider) return null;
  return (
    <div className={`pill ${provider.configured ? "ok" : "off"}`}>
      <span className="dot" />
      {provider.label}
    </div>
  );
}

function Timeline({
  events,
  status,
}: {
  events: PipelineEvent[];
  status?: RunState["status"];
}) {
  if (events.length === 0) {
    return <p className="empty">Run the campaign to see live pipeline state.</p>;
  }
  return (
    <ol className="timeline">
      {events.map((e, i) => {
        const detail = e.detail ?? {};
        const bits = [detail.productId, detail.ratio].filter(Boolean).join(" · ");
        const isLast = i === events.length - 1;
        return (
          <li key={i} className={`ev ${e.event}`}>
            <span className="tick">
              {status === "running" && isLast ? "◐" : e.event === "failed" ? "✕" : "✓"}
            </span>
            <span className="label">{EVENT_LABELS[e.event] ?? e.event}</span>
            {bits && <span className="meta">{bits}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Results({
  report,
  locale,
  onLocale,
}: {
  report?: CampaignReport;
  locale: string;
  onLocale: (l: string) => void;
}) {
  if (!report) return <p className="empty">Exported creatives appear here.</p>;

  const locales = report.markets.map((m) => m.locale);

  return (
    <div className="results">
      {locales.length > 1 && (
        <div className="locales">
          <button className={locale === "all" ? "on" : ""} onClick={() => onLocale("all")}>
            All markets
          </button>
          {locales.map((l) => (
            <button key={l} className={locale === l ? "on" : ""} onClick={() => onLocale(l)}>
              {l}
            </button>
          ))}
        </div>
      )}
      {report.products.map((product) => (
        <div key={product.productId} className="product">
          <div className="product-head">
            <h3>{product.productName}</h3>
            <SourceBadge source={product.hero.source} />
          </div>

          <p className="prov">
            {product.hero.source === "reused" ? (
              <>Reused approved asset · <code>{product.hero.sourceAssetPath?.split("/").pop()}</code></>
            ) : (
              <>
                {product.hero.generation?.provider} · {product.hero.generation?.model} ·{" "}
                {product.hero.generation?.operation} ·{" "}
                {((product.hero.generation?.durationMs ?? 0) / 1000).toFixed(1)}s
              </>
            )}
          </p>

          <div className="grid">
            {product.creatives
              .filter((c) => locale === "all" || c.locale === locale)
              .map((c) => (
              <figure key={`${c.ratio}-${c.locale}`} className={`card ${c.ratio}`}>
                <img src={`/outputs/${c.outputPath}`} alt={`${product.productName} ${c.ratio} ${c.locale}`} />
                <figcaption>
                  <strong>{c.ratio.replace("x", ":")}</strong>
                  <span className="loc">{c.locale}</span>
                  <span>{c.width}×{c.height}</span>
                  <span className={`v ${c.validation.status}`}>{c.validation.status}</span>
                </figcaption>
                <ul className="checks">
                  {c.validation.checks.map((chk) => (
                    <li key={chk.id} className={chk.status}>
                      <span>{chk.status === "pass" ? "✓" : chk.status === "warning" ? "!" : "✕"}</span>
                      {chk.message}
                    </li>
                  ))}
                </ul>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
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

function Summary({ report }: { report: CampaignReport }) {
  const m = report.metrics;
  const stats: [string, string | number][] = [
    ["Products processed", m.productsProcessed],
    ["Markets", m.marketsProcessed],
    ["Approved heroes reused", m.approvedAssetsReused],
    ["Heroes generated", m.heroesGenerated + m.heroesFromCache],
    ...(m.heroesPlaceholder ? ([["Offline placeholders", m.heroesPlaceholder]] as [string, number][]) : []),
    ["Channel variants created", m.variantsCreated],
    ["Validation passed", `${m.validationPassed} / ${m.variantsCreated}`],
    ["Paid generation calls", m.generationRequests],
    ["Elapsed", `${(report.durationMs / 1000).toFixed(1)}s`],
  ];

  return (
    <footer className="summary">
      <div className="stats">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <span className="value">{value}</span>
            <span className="label">{label}</span>
          </div>
        ))}
      </div>
      <p className="path">
        outputs/{report.campaignId}/ · mode <code>{report.mode}</code> ·{" "}
        {report.provider.provider} · {report.provider.model}
        {report.markets.length > 1 && (
          <> · {report.markets.length} markets: <code>{report.markets.map((x) => x.locale).join(", ")}</code></>
        )}
      </p>
    </footer>
  );
}
