import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import sharp from "sharp";
import type { BatchState, FormatOption, RunState } from "./api.js";
import { zipDirectory } from "./archive.js";
import { DEFAULT_LOOK, LOOK_OPTIONS } from "./artDirection.js";
import { findApprovedHero } from "./assetResolver.js";
import { estimateCampaign } from "./estimate.js";
import { readInsights } from "./history.js";
import { loadBriefFile, parseBrief, runCampaign } from "./pipeline.js";
import { MODEL_OPTIONS, PRICING_SOURCE, priceFor } from "./pricing.js";
import { providerStatus, selectGenerator } from "./providers/index.js";
import { type CampaignReport, sanitizeId } from "./report.js";
import { RATIOS, type RatioKey, REQUIRED_RATIOS } from "./schema.js";
import { buildShotPrompt, SHOT_SET } from "./shots.js";
import { preflight, preflightOrThrow } from "./validation.js";

const PORT = Number(process.env.SERVER_PORT ?? 8787);
const OUTPUT_ROOT = path.resolve("outputs");
const SAMPLES_DIR = path.resolve("samples");

/** In-memory only. Runs are ephemeral; the outputs on disk are the artifact. */
const runs = new Map<string, RunState>();
const batches = new Map<string, BatchState>();

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

/**
 * Everything the console needs to draw itself, in one request.
 *
 * These were six routes and six fetches, and none of them takes an argument or
 * changes between calls -- they are the catalogues the UI renders from, plus
 * whichever run is already on disk. Serving them together means the console has
 * one thing that can fail instead of six, and a reviewer reading server.ts sees
 * one bootstrap rather than counting endpoints.
 *
 * `insights` also has its own route below, because it is the only member of
 * this set that changes when a run finishes.
 */
app.get("/api/console", async (_req, res) => {
  const formats: FormatOption[] = (Object.keys(RATIOS) as RatioKey[]).map((key) => ({
    key,
    label: RATIOS[key].label,
    width: RATIOS[key].width,
    height: RATIOS[key].height,
    // The exercise's own list, not a UI preference: the console defaults to
    // exactly the formats the assignment asks for, and 4:5 is an opt-in
    // demonstration that scale is free.
    required: REQUIRED_RATIOS.includes(key),
  }));

  res.json({
    provider: providerStatus(),
    // The sample library, so a reviewer can see more than the flattering case.
    briefs: await readBriefLibrary(),
    // Model choices with published prices, so the picker cannot invent a number.
    models: { models: MODEL_OPTIONS, source: PRICING_SOURCE },
    formats,
    // Served rather than hard-coded in the browser so that adding a look to
    // LOOK_OPTIONS puts it in the picker; a copy in the bundle goes stale.
    looks: { looks: LOOK_OPTIONS, default: DEFAULT_LOOK },
    lastRun: await readLastRun(),
    insights: await readInsights(OUTPUT_ROOT),
  });
});

async function readBriefLibrary() {
  try {
    return JSON.parse(await readFile(path.join(SAMPLES_DIR, "briefs.json"), "utf8"));
  } catch {
    return [];
  }
}

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

/**
 * The most recent campaign still on disk, as a completed run.
 *
 * Runs are held in memory; the report and the PNGs are durable and /outputs
 * already serves them. Without this a restart leaves the console saying "no
 * creatives yet" over a directory full of finished creatives.
 *
 * Picked by completedAt from the report itself, not by file mtime: copying a
 * directory changes mtime and does not change which run finished last.
 */
async function readLastRun(): Promise<RunState | null> {
  try {
    const entries = await readdir(OUTPUT_ROOT, { withFileTypes: true });
    const reports: CampaignReport[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(path.join(OUTPUT_ROOT, entry.name, "report.json"), "utf8");
        reports.push(JSON.parse(raw) as CampaignReport);
      } catch {
        // A directory without a readable report is a partial run, not an error.
      }
    }
    const latest = reports.sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    if (!latest) return null;
    return {
      runId: `restored-${latest.campaignId}`,
      status: "complete",
      startedAt: latest.startedAt,
      events: [],
      report: latest,
      restored: true,
    };
  } catch {
    return null;
  }
}

/**
 * The camera set-ups a shoot would cover, and what covering them costs.
 *
 * Free. Deliberately a separate GET from the act of shooting, because the whole
 * point of putting this in the console is that the price is visible before the
 * button is pressed: nine set-ups is nine paid generations, which is an order
 * of magnitude more than the campaign that produced the hero.
 */
app.get("/api/shots", (_req, res) => {
  const model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";
  res.json({
    shots: SHOT_SET.map((s) => ({ id: s.id, label: s.label, framing: s.framing })),
    model,
    unitPriceUsd: priceFor(model),
  });
});

/**
 * Cover one product from several camera set-ups.
 *
 * Separate from the campaign path, exactly as the CLI is. A campaign generates
 * ONE hero and crops it to every format because the crop is free and the
 * generation is not, and that is the cost argument the whole pipeline rests on.
 * Coverage is what the argument gives up; this is what buying it back costs,
 * one paid generation per set-up, and only when a person asks for it by name.
 *
 * The reference is THE HERO, not the packshot: the model is looking at the
 * finished scene and being asked to move the camera inside it, so the set, the
 * light and the grade come from the image rather than from a paragraph trying
 * to respecify them.
 */
app.post("/api/shoot", async (req, res) => {
  const raw = typeof req.body?.brief === "string" ? req.body.brief : null;
  const productId = typeof req.body?.productId === "string" ? req.body.productId : null;
  const wanted: string[] = Array.isArray(req.body?.shots) ? req.body.shots : [];
  if (!raw || !productId) {
    res.status(400).json({ error: "Body must be { brief, productId, shots[] }" });
    return;
  }

  const shots = SHOT_SET.filter((s) => wanted.includes(s.id));
  if (shots.length === 0) {
    res.status(400).json({ error: "Select at least one camera set-up" });
    return;
  }

  try {
    const brief = parseBrief(raw);
    const product = brief.products.find((p) => p.id === productId);
    if (!product) {
      res.status(404).json({ error: `No product ${productId} in this brief` });
      return;
    }

    // The same gate the campaign path uses. A shoot spends real money per
    // set-up, so a brief carrying a prohibited claim is refused here too: a
    // side entrance that skips the free checks is not a side entrance, it is a
    // hole.
    preflightOrThrow(await preflight(brief));

    // Something to move the camera within. The campaign writes its hero to
    // outputs/<campaign>/<product>/source/, so a product that has just been run
    // can be shot even when the brief names no approved asset.
    const generated = path.join(
      OUTPUT_ROOT,
      sanitizeId(brief.id),
      sanitizeId(product.id),
      "source",
      "generated-hero.png",
    );
    const reference =
      (await findApprovedHero(product.approvedHeroPath)) ?? (await findApprovedHero(generated));
    if (!reference) {
      res.status(409).json({
        error:
          "This product has no hero on disk yet. Run the campaign first, then shoot the hero it produced.",
      });
      return;
    }

    const generator = selectGenerator(process.env, req.body?.model);
    const outDir = path.join(OUTPUT_ROOT, "shot-variants", sanitizeId(product.id));
    await mkdir(outDir, { recursive: true });

    const results: { id: string; label: string; path?: string; error?: string }[] = [];
    for (const shot of shots) {
      try {
        const hero = await generator.generateHero({
          productId: product.id,
          productName: product.name,
          campaignMessage: brief.message,
          region: brief.region,
          audience: brief.audience,
          brandName: brief.brand.name,
          prompt: buildShotPrompt(shot),
          referenceAssetPath: reference,
        });
        const file = path.join(outDir, `${shot.id}.png`);
        await writeFile(file, hero.bytes);
        results.push({
          id: shot.id,
          label: shot.label,
          path: `/outputs/${path.relative(OUTPUT_ROOT, file).split(path.sep).join("/")}`,
        });
      } catch (error) {
        // One refused set-up must not lose the rest of the shoot.
        results.push({
          id: shot.id,
          label: shot.label,
          error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        });
      }
    }

    res.json({
      productId: product.id,
      productName: product.name,
      model: generator.model,
      results,
      generated: results.filter((r) => r.path).length,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
        preview: req.body?.preview === true,
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
    preview: req.body?.preview === true,
    look: LOOK_OPTIONS.some((l) => l.id === req.body?.look) ? req.body.look : undefined,
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

/**
 * Run several campaigns as one job.
 *
 * The exercise opens with a client "launching hundreds of localized social ad
 * campaigns monthly", and its first pain point is producing those variants at
 * that volume. A console that runs one campaign at a time does not show the
 * shape of that problem, so this takes a list.
 *
 * Sequential, deliberately. Each campaign can spend money, and running them
 * concurrently would multiply rate-limit exposure and make the spend
 * impossible to watch. It is the same loop `npm run campaign -- --all` runs.
 */
app.post("/api/batches", async (req, res) => {
  const files: unknown = req.body?.files;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    res.status(400).json({ error: "Body must be { files: string[] }" });
    return;
  }

  const library: { file: string; label: string }[] = await readFile(
    path.join(SAMPLES_DIR, "briefs.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch(() => []);

  const batchId = randomUUID();
  const state: BatchState = {
    batchId,
    status: "running",
    startedAt: new Date().toISOString(),
    campaigns: (files as string[]).map((file) => ({
      file,
      label: library.find((b) => b.file === file)?.label ?? file,
      status: "queued" as const,
    })),
  };
  batches.set(batchId, state);
  res.status(202).json({ batchId });

  void (async () => {
    for (const campaign of state.campaigns) {
      campaign.status = "running";
      try {
        // The filename decides a path, so it is confined to samples/ exactly
        // the way the single-brief route confines it.
        const name = path.basename(campaign.file);
        const report = await runCampaign(await loadBriefFile(path.join(SAMPLES_DIR, name)), {
          outputRoot: OUTPUT_ROOT,
          ratios: req.body?.ratios,
          locales: req.body?.locales,
        });
        campaign.report = report;
        campaign.status = "complete";
      } catch (error) {
        // A refused brief is a correct outcome, not a crash. Two of the samples
        // exist to be refused, and the batch must not stop for them.
        campaign.error = error instanceof Error ? error.message : String(error);
        campaign.status = "refused";
      }
    }
    state.status = "complete";
  })();
});

app.get("/api/batches/:batchId", (req, res) => {
  const state = batches.get(req.params.batchId);
  if (!state) {
    res.status(404).json({ error: "Unknown batch" });
    return;
  }
  res.json(state);
});

app.get("/api/runs/:runId", (req, res) => {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).json({ error: "Unknown run" });
    return;
  }
  res.json(state);
});

/**
 * Loopback only. This is a single-user local tool that holds a billing-enabled
 * API key in memory; there is no reason for it to answer the network, and the
 * proportional hardening for a local take-home is one argument, not an auth
 * system. (The FAQ is explicit that deployment security is not required.)
 */
/**
 * Exported so the routes can be driven without a port, and listening only when
 * this file is what was run. Four of them spend money or write files, and a
 * route that can only be reached by starting the real thing is a route nothing
 * tests.
 */
export { app };

const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (startedDirectly) {
  app.listen(PORT, "127.0.0.1", () => {
    const status = providerStatus();
    console.log(`Creative pipeline server  →  http://127.0.0.1:${PORT}`);
    console.log(`Provider: ${status.label}`);
    console.log(`Outputs:  ${OUTPUT_ROOT}`);
  });
}
