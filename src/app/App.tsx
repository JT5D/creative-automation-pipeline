import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CampaignStrip } from "./components/CampaignStrip.js";
import { DeliveryBanner } from "./components/DeliveryBanner.js";
import { Inspector } from "./components/Inspector.js";
import { Results, type Selection } from "./components/Results.js";
import { RunDetails } from "./components/RunDetails.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import type {
  BriefSummary,
  CampaignEstimate,
  FormatOption,
  Insights as InsightsData,
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

  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [selectedFormats, setSelectedFormats] = useState<string[]>([]);
  const [selectedLocales, setSelectedLocales] = useState<string[]>([]);

  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<ProviderStatus | null>(null);

  const [estimate, setEstimate] = useState<CampaignEstimate | null>(null);
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
      ratios: selectedFormats,
      locales: selectedLocales,
    }),
    [brief, model, selectedFormats, selectedLocales],
  );

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

  const onRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRun(null);
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
                    {m.label} - ${m.usdPer2K.toFixed(3)}/image
                  </option>
                ))}
              </select>
            </label>
          )}
          {provider && (
            <div className={`pill ${provider.configured ? "ok" : "off"}`}>
              <span className="dot" />
              {provider.label}
            </div>
          )}
          <ThemeToggle />
          <button type="button" className="ghost" onClick={onEstimate} disabled={busy}>
            Estimate
          </button>
          <button type="button" className="run" onClick={onRun} disabled={busy || !brief.trim()}>
            {run?.status === "running" ? "Running…" : "Run campaign"}
          </button>
        </div>
      </header>

      <CampaignStrip
        library={library}
        active={active}
        onSelect={loadBrief}
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

      {run?.report && <DeliveryBanner report={run.report} />}

      <main className="stage">
        <div className="work">
          {run?.report && producedRatios.length > 0 && (
            <div className="filters">
              {/* Each filter appears when its own axis has more than one value.
                  The format filter used to be gated on the number of MARKETS,
                  so a default run producing three formats in one market showed
                  no way to narrow them. */}
              {run.report.markets.length > 1 && (
                <Chips
                  value={filterLocale}
                  onChange={setFilterLocale}
                  options={run.report.markets.map((m) => m.locale)}
                  allLabel="All markets"
                />
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
          <Results
            report={run?.report}
            filterLocale={filterLocale}
            filterRatio={filterRatio}
            selected={selected}
            onSelect={setSelected}
          />
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
