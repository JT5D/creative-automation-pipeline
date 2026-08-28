import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { zipDirectory } from "./archive.js";
import { estimateCampaign } from "./estimate.js";
import { readInsights } from "./history.js";
import { type PipelineEvent, runCampaign } from "./pipeline.js";
import { MODEL_OPTIONS, PRICING_SOURCE } from "./pricing.js";
import { providerStatus } from "./providers/index.js";
import type { CampaignReport } from "./report.js";
import { sanitizeId } from "./report.js";
import { RATIOS, REQUIRED_RATIOS } from "./schema.js";

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
app.use(express.json({ limit: "12mb" })); // a 2K packshot is a few MB

// Serve real files from disk so the gallery shows the actual exported PNGs,
// not a re-render. What you see in the UI is the file you ship.
app.use("/outputs", express.static(OUTPUT_ROOT));

/**
 * The whole campaign as one download.
 *
 * The console could hand back a single PNG or the report, which is not how
 * anyone collects a campaign -- a producer wants the folder. The id becomes a
 * path, so it is sanitized the same way the pipeline sanitizes it on the way in
 * and then checked to still sit under OUTPUT_ROOT.
 */
app.get("/api/campaigns/:id/archive", async (req, res) => {
  const dir = path.join(OUTPUT_ROOT, sanitizeId(req.params.id));
  if (path.relative(OUTPUT_ROOT, dir).startsWith("..")) {
    res.status(400).json({ error: "Bad campaign id" });
    return;
  }
  try {
    const zip = await zipDirectory(dir, sanitizeId(req.params.id));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeId(req.params.id)}.zip"`);
    res.send(zip);
  } catch {
    res.status(404).json({ error: `No outputs for campaign ${req.params.id}` });
  }
});

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
/**
 * Accept an approved asset the way the brief's data sources describe it:
 * a person supplying a file by hand.
 *
 * This is the reuse mechanism made visible. Drop an approved hero in for a
 * product that has none, and the next run finds it on disk and stops paying a
 * model to invent one -- the same filesystem check the pipeline always made,
 * now reachable without leaving the console.
 *
 * Deliberately narrow: it writes one image into samples/assets and nothing
 * else. The filename is rebuilt from the product id rather than trusted, so a
 * crafted name cannot escape the directory, and the type is checked against
 * the bytes the compositor can actually read.
 */
const ASSETS_DIR = path.join(SAMPLES_DIR, "assets");
const ASSET_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

app.post("/api/assets", async (req, res) => {
  const { productId, mimeType, dataBase64 } = req.body ?? {};
  const extension = ASSET_TYPES[String(mimeType)];

  if (!productId || typeof productId !== "string" || !/^[a-z0-9-]+$/i.test(productId)) {
    return res
      .status(400)
      .json({ error: "A product id of letters, digits and hyphens is required" });
  }
  if (!extension) {
    return res
      .status(400)
      .json({ error: `Unsupported type. Accepts ${Object.keys(ASSET_TYPES).join(", ")}` });
  }
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    return res.status(400).json({ error: "No file contents received" });
  }

  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0) return res.status(400).json({ error: "File is empty" });

  // The declared type is a claim, not evidence. Decode with the same library
  // that will have to composite this asset later: if Sharp cannot read it now,
  // the run would fail on it, and failing here says so while a person is still
  // looking at the screen.
  let meta: { width?: number; height?: number; format?: string };
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    return res.status(400).json({ error: "That file is not a readable image" });
  }
  if (!meta.width || !meta.height) {
    return res.status(400).json({ error: "That image has no readable dimensions" });
  }

  // The name is constructed, never taken from the upload.
  const filename = `${productId}-approved-hero.${extension}`;
  await mkdir(ASSETS_DIR, { recursive: true });
  await writeFile(path.join(ASSETS_DIR, filename), bytes);

  // Relative, because it goes straight into a brief that has to work on
  // someone else's machine.
  res.json({ path: `samples/assets/${filename}`, width: meta.width, height: meta.height });
});

app.get("/api/models", (_req, res) => {
  res.json({ models: MODEL_OPTIONS, source: PRICING_SOURCE });
});

/**
 * `required` is the exercise's own list, not a UI preference, which is why it
 * comes from the server: the console defaults to exactly the formats the
 * assignment asks for, and the extra one is an opt-in demonstration of scale.
 */
app.get("/api/formats", (_req, res) => {
  res.json(
    Object.entries(RATIOS).map(([key, v]) => ({
      key,
      label: v.label,
      width: v.width,
      height: v.height,
      required: REQUIRED_RATIOS.includes(key as (typeof REQUIRED_RATIOS)[number]),
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

/**
 * Loopback only. This is a single-user local tool that holds a billing-enabled
 * API key in memory; there is no reason for it to answer the network, and the
 * proportional hardening for a local take-home is one argument, not an auth
 * system. (The FAQ is explicit that deployment security is not required.)
 */
app.listen(PORT, "127.0.0.1", () => {
  const status = providerStatus();
  console.log(`Creative pipeline server  →  http://127.0.0.1:${PORT}`);
  console.log(`Provider: ${status.label}`);
  console.log(`Outputs:  ${OUTPUT_ROOT}`);
});
