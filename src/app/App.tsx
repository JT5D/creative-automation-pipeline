import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BriefPanel } from "./components/BriefPanel.js";
import { Insights } from "./components/Insights.js";
import { Results } from "./components/Results.js";
import { Timeline } from "./components/Timeline.js";
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

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshInsights = useCallback(() => {
    fetch("/api/insights").then((r) => r.json()).then(setInsights).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/briefs").then((r) => r.json()).then(setLibrary).catch(() => {});
    fetch("/api/provider").then((r) => r.json()).then(setProvider).catch(() => {});
    fetch("/api/formats")
      .then((r) => r.json())
      .then((f: FormatOption[]) => {
        setFormats(f);
        setSelectedFormats(f.map((x) => x.key));
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
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refreshInsights]);

  /** Locales come from the brief text, so the toggles track what you typed. */
  const locales = useMemo(() => {
    const found = [...brief.matchAll(/^\s*-?\s*locale:\s*["']?([\w-]+)/gm)].map((m) => m[1]);
    return [...new Set(found)];
  }, [brief]);

  useEffect(() => { setSelectedLocales(locales); }, [locales]);

  const loadBrief = useCallback((file: string) => {
    setActive(file);
    setRun(null);
    setEstimate(null);
    setError(null);
    fetch(`/api/briefs/${file}`).then((r) => r.text()).then(setBrief).catch(() => {});
  }, []);

  useEffect(() => { loadBrief("campaign.yaml"); }, [loadBrief]);

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
    } finally {
      setBusy(false);
    }
  }, [body]);

  const onRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setEstimate(null);

    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to start run");
      setBusy(false);
      return;
    }
    const { runId } = await res.json();

    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const r = await fetch(`/api/runs/${runId}`);
      if (!r.ok) return;
      const state: RunState = await r.json();
      setRun(state);
      if (state.status !== "running") {
        if (timer.current) clearInterval(timer.current);
        setBusy(false);
        refreshInsights();
      }
    }, POLL_MS);
  }, [body, refreshInsights]);

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
                    {m.label} — ${m.usdPer2K.toFixed(3)}/image
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
        </div>
      </header>

      <Insights data={insights} />

      <main className="columns">
        <BriefPanel
          library={library}
          active={active}
          onSelect={loadBrief}
          brief={brief}
          onBriefChange={setBrief}
          formats={formats}
          selectedFormats={selectedFormats}
          onToggleFormat={(k) => toggle(selectedFormats, setSelectedFormats, k)}
          locales={locales}
          selectedLocales={selectedLocales}
          onToggleLocale={(l) => toggle(selectedLocales, setSelectedLocales, l)}
          estimate={estimate}
          onEstimate={onEstimate}
          onRun={onRun}
          busy={busy}
          running={run?.status === "running"}
        />

        <section className="panel">
          <h2>2 · Pipeline</h2>
          <p className="hint">Live events emitted by the running pipeline.</p>
          <Timeline events={run?.events ?? []} status={run?.status} />
          {(error || run?.error) && <p className="error">{error ?? run?.error}</p>}
        </section>

        <section className="panel wide">
          <h2>3 · Creative results</h2>
          <p className="hint">Actual exported files, served from disk.</p>
          <Results report={run?.report} />
        </section>
      </main>
    </div>
  );
}
