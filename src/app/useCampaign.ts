import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchState, RunState } from "../api.js";
import type { CampaignEstimate } from "../estimate.js";
import { withApprovedHero } from "./brief.js";

/** How often a running campaign is polled. */
const POLL_MS = 700;

type Input = {
  brief: string;
  setBrief: (update: (previous: string) => string) => void;
  selectedBriefs: string[];
  model: string;
  look: string;
  preview: boolean;
  ratios: string[];
  locales: string[];
  /** Clears whatever the component is displaying about the previous run. */
  onReset: () => void;
  /** A run finished, so cross-run insights are stale. */
  onRunFinished: () => void;
};

/**
 * Everything about asking the server to do something, and watching it.
 *
 * Pulled out of App because App had grown to hold both the campaign lifecycle
 * and everything the screen displays, and the linter said so: cognitive
 * complexity 38 against a ceiling of 30 that this repo set for itself. The
 * ceiling was right. A component that owns polling, retries, spend guards and
 * layout at once is a component nobody can explain in one pass.
 *
 * The split is by kind, not by size. This file owns the things that talk to the
 * server and the state that only exists because they do - the run, the batch,
 * the estimate, busy, error, and the poll timer. App owns what is on screen.
 * Nothing here renders and nothing here reads the DOM, so the whole lifecycle
 * can be read top to bottom without a single piece of layout in the way.
 */
export function useCampaign({
  brief,
  setBrief,
  selectedBriefs,
  model,
  look,
  preview,
  ratios,
  locales,
  onReset,
  onRunFinished,
}: Input) {
  const [run, setRun] = useState<RunState | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [estimate, setEstimate] = useState<CampaignEstimate | null>(null);
  const [batchEstimate, setBatchEstimate] = useState<{
    campaigns: number;
    refused: number;
    variants: number;
    generations: number;
    costUsd: number;
  } | null>(null);
  /**
   * The newest finished campaign on disk, held apart from a live run so that
   * selecting another brief drops it instead of leaving one campaign's results
   * under another campaign's estimate.
   */
  const [restored, setRestored] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const post = useCallback(async <T>(path: string, payload: unknown): Promise<T | null> => {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? "The server refused that request");
        return null;
      }
      return json as T;
    } catch {
      setError("Could not reach the local server. Is `npm run dev` still running?");
      return null;
    }
  }, []);

  /**
   * Everything downstream of "a new run is starting".
   *
   * Three call sites cleared the same four pieces of state and one of them had
   * already drifted. The guards above mean a miss is no longer a rendering bug,
   * but there is still no reason to write the list three times.
   */
  const clearRun = useCallback(() => {
    setRun(null);
    setBatch(null);
    setEstimate(null);
    // The component's own view of the previous run: the open inspector and the
    // market and format filters.
    onReset();
  }, [onReset]);

  const body = useCallback(
    () => ({
      brief,
      model,
      // Omitted rather than sent empty, so the server can tell "the operator
      // chose nothing" from "the operator chose daylight".
      ...(look ? { look } : {}),
      preview,
      ratios,
      locales,
    }),
    [brief, look, model, preview, ratios, locales],
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
    const result = await post<CampaignEstimate>("/api/estimate", body());
    if (result) setEstimate(result);
    setBusy(false);
  }, [body, post]);

  /**
   * Keep the dry run current without anyone asking for it.
   *
   * The estimate is the only place the console names the products, says which
   * reuses an approved asset, which is about to cost money, and where to hand
   * it one instead. Behind a button, all of that is invisible on load.
   *
   * Safe to run unasked because a dry run constructs no provider and spends
   * nothing. Debounced, since the brief is a live textarea. The Estimate button
   * stays for re-checking on demand.
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
    clearRun();

    const stop = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setBusy(false);
    };

    const started = await post<{ batchId: string }>("/api/batches", { files: selectedBriefs });
    if (!started) return stop();
    const batchId = started.batchId;

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
          onRunFinished();
        }
      } catch {
        if (++misses >= 5) {
          setError("Lost contact with the batch. Check the terminal running `npm run dev`.");
          stop();
        }
      }
    }, POLL_MS);
  }, [selectedBriefs, onRunFinished, clearRun, post]);

  const onRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    clearRun();
    // Filters belong to the run that is being replaced. Carrying them over let
    // a second run land filtered to a market it no longer contains, and since
    // the filter row only appears for multi-market runs there was then no
    // control on screen to clear it: the banner reported six creatives above a
    // completely empty stage, recoverable only by reloading the page.

    // Every exit from here has to clear `busy`, including the ones that throw.
    // A dropped connection must not leave the button spinning with no way back
    // except a reload.
    const stop = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setBusy(false);
    };

    const started = await post<{ runId: string }>("/api/runs", body());
    if (!started) return stop();
    const runId = started.runId;

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
          onRunFinished();
        }
      } catch {
        if (++misses >= 5) {
          setError("Lost contact with the run. Check the terminal running `npm run dev`.");
          stop();
        }
      }
    }, POLL_MS);
  }, [body, onRunFinished, post, clearRun]);

  /**
   * Supplying an approved asset is the one write this console makes, and it
   * exists because it is the cheapest thing a person can do to a run: the file
   * lands on disk, the brief points at it, and the next run reuses it instead
   * of paying to generate one.
   */
  const onApproveAsset = useCallback(
    async (productId: string, file: File) => {
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
      onReset();
    },
    [onReset, setBrief],
  );

  /**
   * What the results half of the screen shows.
   *
   * A live run always wins. A run read back off disk is shown only while the
   * console is pointed at that same campaign, matched on the id the estimate
   * resolved from the brief on screen.
   */
  const activeRun =
    run ??
    (restored && estimate && restored.report?.campaignId === estimate.campaignId ? restored : null);

  return {
    run,
    batch,
    estimate,
    batchEstimate,
    activeRun,
    busy,
    error,
    setError,
    setEstimate,
    setRun,
    setRestored,
    clearRun,
    onEstimate,
    onEstimateBatch,
    onRun,
    onRunBatch,
    onApproveAsset,
  };
}
