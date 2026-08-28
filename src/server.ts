import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { estimateCampaign } from "./estimate.js";
import { readInsights } from "./history.js";
import { type PipelineEvent, runCampaign } from "./pipeline.js";
import { MODEL_OPTIONS, PRICING_SOURCE } from "./pricing.js";
import { providerStatus } from "./providers/index.js";
import type { CampaignReport } from "./report.js";
import { RATIOS } from "./schema.js";

const PORT = Number(process.env.SERVER_PORT ?? 8787);
const OUTPUT_ROOT = path.resolve("outputs");
const SAMPLES_DIR = path.resolve("samples");

type RunState = {
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  events: PipelineEvent[];
  report?: CampaignReport;
  error?: string;
};

/** In-memory only. Runs are ephemeral; the outputs on disk are the artifact. */
const runs = new Map<string, RunState>();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve real files from disk so the gallery shows the actual exported PNGs,
// not a re-render. What you see in the UI is the file you ship.
app.use("/outputs", express.static(OUTPUT_ROOT));

app.get("/api/provider", (_req, res) => {
  res.json(providerStatus());
});

/** The sample library, so a reviewer can see more than the flattering case. */
app.get("/api/briefs", async (_req, res) => {
  try {
    const manifest = JSON.parse(await readFile(path.join(SAMPLES_DIR, "briefs.json"), "utf8"));
    res.json(manifest);
  } catch {
    res.json([]);
  }
});

app.get("/api/briefs/:file", async (req, res) => {
  // The filename is user input and becomes a path, so keep it inside samples/.
  const name = path.basename(req.params.file);
  const target = path.join(SAMPLES_DIR, name);
  if (!target.startsWith(SAMPLES_DIR + path.sep)) {
    res.status(400).json({ error: "Invalid brief name" });
    return;
  }
  try {
    res.type("text/plain").send(await readFile(target, "utf8"));
  } catch {
    res.status(404).json({ error: `samples/${name} not found` });
  }
});

/** Model choices with published prices, so the picker cannot invent a number. */
app.get("/api/models", (_req, res) => {
  res.json({ models: MODEL_OPTIONS, source: PRICING_SOURCE });
});

app.get("/api/formats", (_req, res) => {
  res.json(
    Object.entries(RATIOS).map(([key, v]) => ({
      key,
      label: v.label,
      width: v.width,
      height: v.height,
    })),
  );
});

/** Cross-run learning: reuse rate, spend and time saved over every run so far. */
app.get("/api/insights", async (_req, res) => {
  res.json(await readInsights(OUTPUT_ROOT));
});

/** What a run would produce and cost. Spends nothing and calls no provider. */
app.post("/api/estimate", async (req, res) => {
  const raw = typeof req.body?.brief === "string" ? req.body.brief : null;
  if (!raw) {
    res.status(400).json({ error: "Body must be { brief: string }" });
    return;
  }
  try {
    res.json(
      await estimateCampaign(raw, {
        model: req.body?.model,
        ratios: req.body?.ratios,
        locales: req.body?.locales,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/runs", async (req, res) => {
  const raw = typeof req.body?.brief === "string" ? req.body.brief : null;
  if (!raw) {
    res.status(400).json({ error: "Body must be { brief: string } (JSON or YAML)" });
    return;
  }

  const runId = randomUUID();
  const state: RunState = {
    runId,
    status: "running",
    startedAt: new Date().toISOString(),
    events: [],
  };
  runs.set(runId, state);

  // Respond immediately; the UI polls for real events as they are emitted.
  res.status(202).json({ runId });

  runCampaign(raw, {
    outputRoot: OUTPUT_ROOT,
    ratios: req.body?.ratios,
    locales: req.body?.locales,
    model: typeof req.body?.model === "string" ? req.body.model : undefined,
    onEvent: (event) => state.events.push(event),
  })
    .then((report) => {
      state.report = report;
      state.status = "complete";
    })
    .catch((error: unknown) => {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.events.push({
        at: new Date().toISOString(),
        event: "failed",
        detail: { message: state.error },
      });
    });
});

app.get("/api/runs/:runId", (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).json({ error: "Unknown run" });
    return;
  }
  res.json(state);
});

app.get("/api/runs/:runId/report", (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state?.report) {
    res.status(404).json({ error: "Report not ready" });
    return;
  }
  res.json(state.report);
});

app.listen(PORT, () => {
  const status = providerStatus();
  console.log(`Creative pipeline server  →  http://localhost:${PORT}`);
  console.log(`Provider: ${status.label}`);
  console.log(`Outputs:  ${OUTPUT_ROOT}`);
});
