import type { PipelineEvent } from "./pipeline.js";
import type { CampaignReport } from "./report.js";
import type { RatioKey } from "./schema.js";

/**
 * The wire contract between the local server and the console.
 *
 * These are the only shapes that exist because of HTTP rather than because of
 * the pipeline. Everything else the console renders is a pipeline type it
 * imports directly, so the browser and the server cannot disagree about what a
 * report or a validation check contains.
 *
 * Both ends import this file. They used to declare these three independently,
 * which is how src/app/types.ts ended up with a CampaignReport missing two
 * fields the server had been sending for weeks.
 */

/** GET/POST /api/runs and /api/runs/:runId. In memory; the files are durable. */
export type RunState = {
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  events: PipelineEvent[];
  report?: CampaignReport;
  error?: string;
};

/** GET /api/briefs - the sample library, from samples/briefs.json. */
export type BriefSummary = {
  file: string;
  label: string;
  /** What a reviewer learns from running this one. */
  teaches: string;
  /** What it should produce, asserted by a test against the real run. */
  expect: string;
};

/** GET /api/formats. */
export type FormatOption = {
  key: RatioKey;
  label: string;
  width: number;
  height: number;
  /** One of the three the exercise names. Selected by default. */
  required: boolean;
};
