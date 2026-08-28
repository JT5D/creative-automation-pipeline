import { useCallback, useEffect, useMemo, useState } from "react";
import { BatchResults } from "./components/BatchResults.js";
import { CampaignStrip } from "./components/CampaignStrip.js";
import { ConsoleHeader } from "./components/ConsoleHeader.js";
import { DeliveryBanner } from "./components/DeliveryBanner.js";
import { Inspector } from "./components/Inspector.js";
import { Results, type Selection } from "./components/Results.js";
import { RunDetails } from "./components/RunDetails.js";
import type {
  BriefSummary,
  FormatOption,
  Insights as InsightsData,
  LookOption,
  ModelOption,
  ProviderStatus,
  RunState,
} from "./types.js";
import { useCampaign } from "./useCampaign.js";

export function App() {
  const [brief, setBrief] = useState("");
  const [library, setLibrary] = useState<BriefSummary[]>([]);
  const [active, setActive] = useState("campaign.yaml");
  /**
   * The campaigns this run will produce.
   *
   * The exercise's client launches hundreds of localized campaigns a month, so
   * the console takes a list rather than one brief. One selected behaves
   * exactly as it always has; more than one runs them as a batch, each with its
   * own full scope, which is what `npm run portfolio` has always done.
   */
  const [selectedBriefs, setSelectedBriefs] = useState<string[]>(["campaign.yaml"]);

  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [selectedFormats, setSelectedFormats] = useState<string[]>([]);
  const [selectedLocales, setSelectedLocales] = useState<string[]>([]);

  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  // Empty means "whatever the brief asks for", which is not the same as
  // "daylight": the fragrance brief says nocturne and picking a look here has
  // to be a deliberate act, not the default state of the control.
  const [looks, setLooks] = useState<LookOption[]>([]);
  const [look, setLook] = useState("");
  /**
   * Preview runs the hero at 1K on the cheapest model that can serve it, which
   * is half the price of shipping and the reason `--preview` exists. It was CLI
   * only, so the console offered exactly one price. Iterating on art direction
   * is the expensive habit, not shipping, and the cheap tier is the answer to
   * that - it is worth a control rather than a paragraph in a doc.
   */
  const [preview, setPreview] = useState(false);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);

  const [insights, setInsights] = useState<InsightsData | null>(null);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [filterLocale, setFilterLocale] = useState("all");
  const [filterRatio, setFilterRatio] = useState("all");

  // The formats this run actually produced. Both filters are driven off what
  // the report contains rather than off what was requested, so a filter can
  // never offer a value the stage has nothing for.
  const refreshInsights = useCallback(() => {
    fetch("/api/insights")
      .then((r) => r.json())
      .then(setInsights)
      .catch(() => {});
  }, []);

  /**
   * The campaign lifecycle, which is not this component's job.
   *
   * App holds what is on screen. useCampaign holds what the server is doing:
   * the run, the batch, the estimate, the poll timer, busy and error. The split
   * is why this file can be read as a layout again.
   */
  const campaign = useCampaign({
    brief,
    setBrief,
    selectedBriefs,
    model,
    look,
    preview,
    ratios: selectedFormats,
    locales: selectedLocales,
    // Filters and the open inspector belong to the run being replaced. A second
    // run used to land filtered to a market it no longer contained, and since
    // the filter row only appears for multi-market runs there was then no
    // control on screen to clear it.
    onReset: useCallback(() => {
      setSelected(null);
      setFilterLocale("all");
      setFilterRatio("all");
    }, []),
    onRunFinished: refreshInsights,
  });

  const {
    run,
    batch,
    estimate,
    batchEstimate,
    activeRun,
    busy,
    error,
    onEstimate,
    onEstimateBatch,
    onRun,
    onRunBatch,
    onApproveAsset,
  } = campaign;

  useEffect(() => {
    /**
     * Seven identical fetch-then-set blocks, collapsed.
     *
     * Every one of them was the same four lines: get, parse, hand to a setter,
     * swallow the failure. The swallow is deliberate and shared - a console
     * that cannot reach one endpoint should still render everything else, and
     * the pieces that matter announce their own absence - so the shape is
     * worth naming once instead of typing seven times.
     */
    const load = <T,>(path: string, apply: (value: T) => void) =>
      fetch(path)
        .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
        .then((value) => {
          if (value !== null) apply(value);
        })
        .catch(() => {});

    load<BriefSummary[]>("/api/briefs", setLibrary);
    load<ProviderStatus>("/api/provider", setProvider);
    load<FormatOption[]>("/api/formats", (f) => {
      setFormats(f);
      // Default to exactly the formats the exercise asks for. 4:5 is one click
      // away and demonstrates that scale is free -- but the first run a
      // reviewer does should be unambiguously the assignment.
      setSelectedFormats(f.filter((x) => x.required).map((x) => x.key));
    });
    load<{ models: ModelOption[] }>("/api/models", (d) => {
      setModels(d.models);
      setModel((m) => m || d.models[0]?.id || "");
    });
    // Show the last campaign that is still on disk, so opening the console
    // after a restart shows creatives instead of an empty state.
    //
    // Only when it is the campaign currently selected. Without that test the
    // console put a dry run for one brief directly above the finished
    // creatives of another: "$0.134 estimated" over "$0.000 spent", six
    // creatives over eight, one product's headline over a different product's
    // pictures. Every number on screen was individually true and the screen as
    // a whole was a lie, which is the same defect as a label broader than its
    // measurement, wearing a different coat.
    load<RunState>("/api/last-run", campaign.setRestored);
    load<{ looks: LookOption[] }>("/api/looks", (d) => setLooks(d.looks));
    refreshInsights();
  }, [refreshInsights, campaign.setRestored]);

  /**
   * Locales come from the brief text, so the toggles track what you typed.
   *
   * Both formats have to work here. A YAML-shaped regex found nothing in a JSON
   * brief, so the market chips silently vanished on the sample that advertises
   * itself as the same campaign in JSON. The format test is the same one
   * parseBrief uses on the server: a leading brace means JSON.
   */
  const locales = useMemo(() => {
    const text = brief.trim();
    if (text.startsWith("{")) {
      try {
        const markets = (JSON.parse(text) as { markets?: { locale?: string }[] }).markets ?? [];
        return [...new Set(markets.map((m) => m.locale).filter(Boolean) as string[])];
      } catch {
        return []; // mid-edit JSON: no chips rather than wrong chips
      }
    }
    const found = [...text.matchAll(/^\s*-?\s*locale:\s*["']?([\w-]+)/gm)].map((m) => m[1]);
    return [...new Set(found)];
  }, [brief]);

  /** The proposition, read from the brief so the strip shows the real input. */
  const message = useMemo(() => {
    const text = brief.trim();
    if (text.startsWith("{")) {
      try {
        return (JSON.parse(text) as { message?: string }).message ?? "";
      } catch {
        return "";
      }
    }
    return /^\s*message:\s*(.+?)\s*(?:#.*)?$/m.exec(text)?.[1]?.trim() ?? "";
  }, [brief]);

  // One market by default -- the first in the brief, which is the English one.
  // The exercise requires the message in English at minimum; the other markets
  // are the localization bonus and cost nothing to add.
  useEffect(() => {
    setSelectedLocales(locales.slice(0, 1));
  }, [locales]);

  const loadBrief = useCallback(
    (file: string) => {
      setActive(file);
      campaign.clearRun();
      campaign.setError(null);
      fetch(`/api/briefs/${file}`)
        .then((r) => r.text())
        .then(setBrief)
        .catch(() => {});
    },
    [campaign.clearRun, campaign.setError],
  );

  useEffect(() => {
    loadBrief("campaign.yaml");
  }, [loadBrief]);

  /**
   * Every write this console makes, in one shape.
   *
   * Five call sites were the same eight lines: post JSON, parse it, decide
   * whether the server refused, set an error from its message, and translate a
   * thrown fetch into "the local server is not running". The last two are the
   * ones worth having in a single place - a refusal is the server's sentence
   * and should be shown verbatim, and a network throw means something entirely
   * different and should never be reported as a server refusal.
   *
   * Returns the parsed body on success and null on any failure, so callers read
   * as `const r = await post(...); if (!r) return;` rather than as a nest of
   * try, ok and catch.
   */

  const producedRatios = activeRun?.report
    ? [...new Set(activeRun.report.products.flatMap((p) => p.creatives.map((c) => c.ratio)))]
    : [];
  const reportMarkets = activeRun?.report?.markets;

  const shownLocale =
    filterLocale === "all" || reportMarkets?.some((m) => m.locale === filterLocale)
      ? filterLocale
      : "all";

  const shownRatio =
    filterRatio === "all" ||
    activeRun?.report?.products.some((p) => p.creatives.some((c) => c.ratio === filterRatio))
      ? filterRatio
      : "all";

  // What the stage is actually showing, counted the same way Results filters.
  const shownCount =
    activeRun?.report?.products
      .flatMap((p) => p.creatives)
      .filter(
        (c) =>
          (shownLocale === "all" || c.locale === shownLocale) &&
          (shownRatio === "all" || c.ratio === shownRatio),
      ).length ?? 0;

  // A finished multi-market run opens on its first market. Set from the report
  // rather than at request time, because the run decides which markets exist.
  useEffect(() => {
    if (reportMarkets && reportMarkets.length > 1) setFilterLocale(reportMarkets[0].locale);
  }, [reportMarkets]);

  /**
   * Stale-state guards, and the reason they are guards rather than more setters.
   *
   * loadBrief cleared the run, the estimate and the error by hand, and the list
   * was incomplete: a creative selected from campaign A stayed open in the
   * inspector after switching to campaign B, showing A's image, A's provenance
   * and A's checks beside B's brief. A market filter chosen on a three-market
   * run survived into a one-market run, where nothing matched it and the stage
   * read "0 of 8 creatives" with no way to see why.
   *
   * Both are the defect that put one campaign's results under another's
   * estimate, and adding two more setters to loadBrief would fix these two
   * instances and leave the next one to be found by opening the app. So the
   * check happens where the value is USED: a selection that does not belong to
   * the run on screen cannot render, and a filter the run has no market for
   * behaves as "all". Forgetting to clear something is no longer possible,
   * because nothing depends on remembering.
   */
  const shownSelection =
    selected &&
    activeRun?.report?.products.some((p) =>
      p.creatives.some((c) => c.outputPath === selected.creative.outputPath),
    )
      ? selected
      : null;

  // One brief behaves exactly as it always has. More than one is a batch.
  const batching = selectedBriefs.length > 1;

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <div className="app">
      <ConsoleHeader
        models={models}
        model={model}
        onModel={setModel}
        looks={looks}
        look={look}
        onLook={setLook}
        preview={preview}
        onPreview={setPreview}
        provider={provider}
        busy={busy}
        batching={batching}
        batchCount={selectedBriefs.length}
        running={run?.status === "running" || batch?.status === "running"}
        canRun={batching || Boolean(brief.trim())}
        onEstimate={batching ? onEstimateBatch : onEstimate}
        onRun={batching ? onRunBatch : onRun}
      />

      <CampaignStrip
        library={library}
        active={active}
        onSelect={loadBrief}
        selectedBriefs={selectedBriefs}
        onToggleBrief={(file) => toggle(selectedBriefs, setSelectedBriefs, file)}
        batchEstimate={batchEstimate}
        onApproveAsset={onApproveAsset}
        brief={brief}
        onBriefChange={setBrief}
        message={message}
        formats={formats}
        selectedFormats={selectedFormats}
        onToggleFormat={(k) => toggle(selectedFormats, setSelectedFormats, k)}
        locales={locales}
        selectedLocales={selectedLocales}
        onToggleLocale={(l) => toggle(selectedLocales, setSelectedLocales, l)}
        estimate={estimate}
      />

      {(error || run?.error) && <p className="error">{error ?? run?.error}</p>}

      {activeRun?.report && !batch && (
        <DeliveryBanner report={activeRun.report} restored={activeRun.restored} />
      )}

      <main className="stage">
        <div className="work">
          {batch && <BatchResults batch={batch} selected={selected} onSelect={setSelected} />}
          {activeRun?.report && !batch && producedRatios.length > 0 && (
            <div className="filters">
              {/* Each filter appears when its own axis has more than one value.
                  The format filter used to be gated on the number of MARKETS,
                  so a default run producing three formats in one market showed
                  no way to narrow them.

                  Markets open on ONE language rather than all of them. A
                  producer reviews a campaign one market at a time -- mixed
                  together, the same headline appears in three languages beside
                  itself and nothing is comparable. The count beside the tabs
                  says how much of the run is on screen, because a banner
                  reading "24 creatives exported" over eight visible cards is
                  the dead end this console has already shipped once. */}
              {activeRun.report.markets.length > 1 && (
                <>
                  <Chips
                    value={filterLocale}
                    onChange={setFilterLocale}
                    options={activeRun.report.markets.map((m) => m.locale)}
                    allLabel="All markets"
                  />
                  <span className="showing">
                    {shownCount} of {activeRun.report.metrics.variantsCreated} creatives
                  </span>
                </>
              )}
              <Chips
                value={filterRatio}
                onChange={setFilterRatio}
                options={producedRatios}
                allLabel="All formats"
                format={(r) => r.replace("x", ":")}
              />
            </div>
          )}
          {!batch && (
            <Results
              report={activeRun?.report}
              brief={brief}
              filterLocale={filterLocale}
              filterRatio={filterRatio}
              selected={shownSelection}
              onSelect={setSelected}
            />
          )}
        </div>

        <Inspector
          creative={shownSelection?.creative ?? null}
          product={shownSelection?.product ?? null}
          onClose={() => setSelected(null)}
          onApproveAsset={onApproveAsset}
        />
      </main>

      <RunDetails
        report={activeRun?.report}
        events={activeRun?.events ?? []}
        status={activeRun?.status}
        insights={insights}
      />
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
