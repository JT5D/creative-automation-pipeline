import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BatchResults } from "./components/BatchResults.js";
import { CampaignStrip } from "./components/CampaignStrip.js";
import { DeliveryBanner } from "./components/DeliveryBanner.js";
import { Inspector } from "./components/Inspector.js";
import { Results, type Selection } from "./components/Results.js";
import { RunDetails } from "./components/RunDetails.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import type {
  BatchState,
  BriefSummary,
  CampaignEstimate,
  FormatOption,
  Insights as InsightsData,
  LookOption,
  ModelOption,
  ProviderStatus,
  RunState,
} from "./types.js";

const POLL_MS = 750;

/**
 * Writes an approved hero into the brief the console is holding.
 *
 * The brief is live editable text, so the change is visible: open Edit source
 * after supplying an asset and the new `approvedHeroPath` line is there. That
 * is deliberate -- the point being demonstrated is that the reuse branch is a
 * real path in a real file, not a mode the UI toggles.
 *
 * JSON round-trips through the parser. YAML is edited as text, because
 * re-serializing it would discard the comments that explain the brief, and
 * those comments are half of what the sample is for.
 */
function withApprovedHero(brief: string, productId: string, assetPath: string): string {
  const text = brief.trim();

  if (text.startsWith("{")) {
    const doc = JSON.parse(text) as { products?: { id?: string; approvedHeroPath?: string }[] };
    const product = doc.products?.find((p) => p.id === productId);
    if (product) product.approvedHeroPath = assetPath;
    return JSON.stringify(doc, null, 2);
  }

  const existing = new RegExp(
    `(- id:\\s*${productId}\\b[\\s\\S]*?\\n)(\\s*)approvedHeroPath:.*`,
    "m",
  );
  if (existing.test(brief)) {
    return brief.replace(existing, `$1$2approvedHeroPath: ${assetPath}`);
  }
  const idLine = new RegExp(`^(\\s*)- id:\\s*${productId}\\s*$`, "m");
  return brief.replace(
    idLine,
    (line, indent) => `${line}\n${indent}  approvedHeroPath: ${assetPath}`,
  );
}

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
  const [batch, setBatch] = useState<BatchState | null>(null);

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

  const [estimate, setEstimate] = useState<CampaignEstimate | null>(null);
  const [batchEstimate, setBatchEstimate] = useState<{
    campaigns: number;
    refused: number;
    variants: number;
    generations: number;
    costUsd: number;
  } | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [filterLocale, setFilterLocale] = useState("all");
  const [filterRatio, setFilterRatio] = useState("all");

  // The formats this run actually produced. Both filters are driven off what
  // the report contains rather than off what was requested, so a filter can
  // never offer a value the stage has nothing for.
  const producedRatios = run?.report
    ? [...new Set(run.report.products.flatMap((p) => p.creatives.map((c) => c.ratio)))]
    : [];

  // What the stage is actually showing, counted the same way Results filters.
  const shownCount =
    run?.report?.products
      .flatMap((p) => p.creatives)
      .filter(
        (c) =>
          (filterLocale === "all" || c.locale === filterLocale) &&
          (filterRatio === "all" || c.ratio === filterRatio),
      ).length ?? 0;

  // A finished multi-market run opens on its first market. Set from the report
  // rather than at request time, because the run decides which markets exist.
  const reportMarkets = run?.report?.markets;
  useEffect(() => {
    if (reportMarkets && reportMarkets.length > 1) setFilterLocale(reportMarkets[0].locale);
  }, [reportMarkets]);

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshInsights = useCallback(() => {
    fetch("/api/insights")
      .then((r) => r.json())
      .then(setInsights)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/briefs")
      .then((r) => r.json())
      .then(setLibrary)
      .catch(() => {});
    fetch("/api/provider")
      .then((r) => r.json())
      .then(setProvider)
      .catch(() => {});
    fetch("/api/formats")
      .then((r) => r.json())
      .then((f: FormatOption[]) => {
        setFormats(f);
        // Default to exactly the formats the exercise asks for. 4:5 is one
        // click away and demonstrates that scale is free -- but the first run
        // a reviewer does should be unambiguously the assignment.
        setSelectedFormats(f.filter((x) => x.required).map((x) => x.key));
      })
      .catch(() => {});
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { models: ModelOption[] }) => {
        setModels(d.models);
        setModel((m) => m || d.models[0]?.id || "");
      })
      .catch(() => {});
    // Show the last campaign that is still on disk, so opening the console
    // after a restart shows creatives instead of an empty state. Only ever
    // fills an empty slot; a live run always wins.
    fetch("/api/last-run")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RunState | null) => {
        if (d) setRun((current) => current ?? d);
      })
      .catch(() => {});
    fetch("/api/looks")
      .then((r) => r.json())
      .then((d: { looks: LookOption[] }) => setLooks(d.looks))
      .catch(() => {});
    refreshInsights();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refreshInsights]);

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

  const loadBrief = useCallback((file: string) => {
    setActive(file);
    setRun(null);
    setEstimate(null);
    setError(null);
    fetch(`/api/briefs/${file}`)
      .then((r) => r.text())
      .then(setBrief)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadBrief("campaign.yaml");
  }, [loadBrief]);

  const body = useCallback(
    () => ({
      brief,
      model,
      // Omitted rather than sent empty, so the server can tell "the operator
      // chose nothing" from "the operator chose daylight".
      ...(look ? { look } : {}),
      preview,
      ratios: selectedFormats,
      locales: selectedLocales,
    }),
    [brief, look, model, preview, selectedFormats, selectedLocales],
  );

  /**
   * What a batch will cost, before any of it is spent.
   *
   * The guardrail matters more here than on a single run: eight campaigns can
   * carry eight paid generations and nobody should discover that afterwards.
   * It reuses the single-brief estimate once per brief rather than adding a
   * second costing path that could disagree with the first.
   */
  const onEstimateBatch = useCallback(async () => {
    setBusy(true);
    setError(null);
    setBatchEstimate(null);
    try {
      const rows = await Promise.all(
        selectedBriefs.map(async (file) => {
          const text = await fetch(`/api/briefs/${file}`).then((r) => r.text());
          const res = await fetch("/api/estimate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brief: text, model }),
          });
          const json = await res.json();
          return { file, ok: res.ok, estimate: res.ok ? (json as CampaignEstimate) : null };
        }),
      );
      setBatchEstimate({
        campaigns: rows.length,
        // A brief the estimator refuses is a campaign that will be refused, so
        // it contributes nothing to the count and nothing to the bill.
        refused: rows.filter((r) => !r.ok || r.estimate?.blocked).length,
        variants: rows.reduce(
          (n, r) => n + (r.estimate?.blocked ? 0 : (r.estimate?.variants ?? 0)),
          0,
        ),
        generations: rows.reduce(
          (n, r) => n + (r.estimate?.blocked ? 0 : (r.estimate?.generations ?? 0)),
          0,
        ),
        costUsd: rows.reduce(
          (n, r) => n + (r.estimate?.blocked ? 0 : (r.estimate?.estimatedCostUsd?.totalUsd ?? 0)),
          0,
        ),
      });
    } catch {
      setError("Could not reach the local server. Is `npm run dev` still running?");
    } finally {
      setBusy(false);
    }
  }, [selectedBriefs, model]);

  const onEstimate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "Could not estimate");
      else setEstimate(json);
    } catch {
      setError("Could not reach the local server. Is `npm run dev` still running?");
    } finally {
      setBusy(false);
    }
  }, [body]);

  /**
   * Keep the dry run current without anyone asking for it.
   *
   * The estimate is the only place the console says what the products are, which
   * of them reuses an approved asset, which one is about to cost money, and
   * where to hand it an asset instead. All of that sat behind a button, so a
   * reviewer opening the console saw four filter panels and no product - and
   * someone looking straight at the screen asked whether there was an upload at
   * all. The answer was yes, two clicks away, which is the same as no.
   *
   * Safe to run on its own because a dry run is exactly that: it validates the
   * brief, resolves what each product would do, and constructs no provider and
   * spends nothing. The Estimate button stays, because re-checking on demand is
   * still a thing people want, and because a control that vanishes when it
   * starts happening automatically is worse than one that agrees with itself.
   *
   * Debounced, since the brief is a live textarea and this fires per keystroke
   * otherwise. Not run while the source editor is open, for the same reason.
   */
  useEffect(() => {
    if (!brief.trim() || selectedBriefs.length > 1) return;
    const t = setTimeout(() => {
      void onEstimate();
    }, 400);
    return () => clearTimeout(t);
  }, [brief, selectedBriefs, onEstimate]);

  /**
   * Several campaigns, one click.
   *
   * Formats and markets are not passed: a batch runs each brief at its own full
   * scope, because the chips belong to the brief being previewed and applying
   * one brief's locales to another brief's campaign would silently produce
   * markets that brief never asked for.
   */
  const onRunBatch = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setBatch(null);
    setEstimate(null);
    setSelected(null);

    const stop = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setBusy(false);
    };

    let batchId: string;
    try {
      const res = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selectedBriefs }),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Failed to start the batch");
        return stop();
      }
      batchId = (await res.json()).batchId;
    } catch {
      setError("Could not reach the local server. Is `npm run dev` still running?");
      return stop();
    }

    let misses = 0;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/batches/${batchId}`);
        if (!r.ok) throw new Error(String(r.status));
        misses = 0;
        const state: BatchState = await r.json();
        setBatch(state);
        if (state.status === "complete") {
          stop();
          refreshInsights();
        }
      } catch {
        if (++misses >= 5) {
          setError("Lost contact with the batch. Check the terminal running `npm run dev`.");
          stop();
        }
      }
    }, POLL_MS);
  }, [selectedBriefs, refreshInsights]);

  const onRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setBatch(null);
    setEstimate(null);
    setSelected(null);
    // Filters belong to the run that is being replaced. Carrying them over let
    // a second run land filtered to a market it no longer contains, and since
    // the filter row only appears for multi-market runs there was then no
    // control on screen to clear it: the banner reported six creatives above a
    // completely empty stage, recoverable only by reloading the page.
    setFilterLocale("all");
    setFilterRatio("all");

    // Every exit from here has to clear `busy`, including the ones that throw.
    // A dropped connection used to leave the button spinning forever with no
    // way back except a reload.
    const stop = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setBusy(false);
    };

    let runId: string;
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Failed to start run");
        return stop();
      }
      runId = (await res.json()).runId;
    } catch {
      setError("Could not reach the local server. Is `npm run dev` still running?");
      return stop();
    }

    // A run that cannot be polled is over as far as this screen is concerned.
    let misses = 0;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/runs/${runId}`);
        if (!r.ok) throw new Error(String(r.status));
        misses = 0;
        const state: RunState = await r.json();
        setRun(state);
        if (state.status !== "running") {
          stop();
          refreshInsights();
        }
      } catch {
        if (++misses >= 5) {
          setError("Lost contact with the run. Check the terminal running `npm run dev`.");
          stop();
        }
      }
    }, POLL_MS);
  }, [body, refreshInsights]);

  /**
   * Supplying an approved asset is the one write this console makes, and it
   * exists because it is the cheapest thing a person can do to a run: the file
   * lands on disk, the brief points at it, and the next run reuses it instead
   * of paying to generate one.
   */
  const onApproveAsset = useCallback(async (productId: string, file: File) => {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read that file"));
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.readAsDataURL(file);
    });

    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, mimeType: file.type, dataBase64 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Upload failed");

    setBrief((b) => withApprovedHero(b, productId, json.path));
    setEstimate(null);
    setSelected(null);
  }, []);

  // One brief behaves exactly as it always has. More than one is a batch.
  const batching = selectedBriefs.length > 1;

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

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

        <div className="controls">
          {models.length > 0 && provider?.provider === "google-gemini" && (
            <label className="model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {/* Unit price only. What makes it unambiguous is the
                        estimate panel underneath, which shows the total AND the
                        arithmetic: "1 x $0.134 per image". A unit price beside
                        "24 creatives" with no visible multiplicand invites the
                        wrong sum, $3.22 for a run that costs $0.134. */}
                    {m.label} - ${m.usdPer2K.toFixed(3)} per image
                  </option>
                ))}
              </select>
            </label>
          )}
          {looks.length > 0 && (
            <label
              className="model"
              title="Art direction. The brief's own look is used unless you pick one."
            >
              <select value={look} onChange={(e) => setLook(e.target.value)}>
                <option value="">Look: from brief</option>
                {looks.map((l) => (
                  <option key={l.id} value={l.id} title={l.description}>
                    Look: {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {provider && (
            <div className="provider">
              <div className={`pill ${provider.configured ? "ok" : "off"}`}>
                <span className="dot" />
                {provider.label}
              </div>
            </div>
          )}
          {/* Gold is money in this console, so the tier that spends less is
              not gold. It reads as a mode, because that is what it is. */}
          <div
            className="theme tier"
            title="Preview generates the hero at 1K on the cheapest model that can serve it. Half the price, and not the deliverable: 9:16 needs 1080x1920 out of a square hero, so a 1K source goes soft."
          >
            <button
              type="button"
              className={preview ? "on" : ""}
              aria-pressed={preview}
              onClick={() => setPreview(true)}
            >
              Preview
            </button>
            <button
              type="button"
              className={preview ? "" : "on"}
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
            >
              Ship
            </button>
          </div>
          <ThemeToggle />
          <button
            type="button"
            className="ghost"
            onClick={batching ? onEstimateBatch : onEstimate}
            disabled={busy}
          >
            Estimate
          </button>
          <button
            type="button"
            className="run"
            onClick={batching ? onRunBatch : onRun}
            disabled={busy || (!batching && !brief.trim())}
          >
            {busy && (run?.status === "running" || batch?.status === "running")
              ? "Running…"
              : batching
                ? `Run ${selectedBriefs.length} campaigns`
                : "Run campaign"}
          </button>
          {/* The hand-off, as a sentence. Not a Firefly button: this repo has no
              entitlement to run that adapter, and a control that quietly does
              nothing is worse than an absent one. Last child of the control row
              on purpose, so it takes its own line underneath rather than
              wedging five lines of caveat between two buttons. */}
          {provider?.handoff && <p className="handoff">{provider.handoff}</p>}
        </div>
      </header>

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

      {run?.report && !batch && <DeliveryBanner report={run.report} restored={run.restored} />}

      <main className="stage">
        <div className="work">
          {batch && <BatchResults batch={batch} selected={selected} onSelect={setSelected} />}
          {run?.report && !batch && producedRatios.length > 0 && (
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
              {run.report.markets.length > 1 && (
                <>
                  <Chips
                    value={filterLocale}
                    onChange={setFilterLocale}
                    options={run.report.markets.map((m) => m.locale)}
                    allLabel="All markets"
                  />
                  <span className="showing">
                    {shownCount} of {run.report.metrics.variantsCreated} creatives
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
              report={run?.report}
              brief={brief}
              filterLocale={filterLocale}
              filterRatio={filterRatio}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>

        <Inspector
          creative={selected?.creative ?? null}
          product={selected?.product ?? null}
          onClose={() => setSelected(null)}
          onApproveAsset={onApproveAsset}
        />
      </main>

      <RunDetails
        report={run?.report}
        events={run?.events ?? []}
        status={run?.status}
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
