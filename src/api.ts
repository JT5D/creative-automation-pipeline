import type { PipelineEvent } from "./pipeline.js";
import type { CampaignReport } from "./report.js";
import type { RatioKey } from "./schema.js";

/**
 * The wire contract between the local server and the console.
 *
 * The only shapes that exist because of HTTP rather than because of the
 * pipeline. Everything else the console renders is a pipeline type it imports
 * directly, and both ends import this file, so a hand-written copy cannot drift
 * on one side only.
 */

/** GET/POST /api/runs and /api/runs/:runId. In memory; the files are durable. */
export type RunState = {
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  events: PipelineEvent[];
  report?: CampaignReport;
  error?: string;
  /**
   * True when this run was read back off disk rather than produced by this
   * server process.
   *
   * Runs live in memory; the files on disk outlive it. Flagged rather than
   * presented as fresh, because a banner reading "production complete" about
   * yesterday's run, with no way to tell, is a status that cannot report the
   * truth.
   */
  restored?: boolean;
};

/**
 * One campaign inside a batch.
 *
 * A brief that is REFUSED is a normal outcome here, not a failure of the batch:
 * the library ships two that exist to be refused. The row says which happened
 * and why, and the batch keeps going.
 */
export type BatchCampaign = {
  file: string;
  label: string;
  status: "queued" | "running" | "complete" | "refused";
  report?: CampaignReport;
  error?: string;
};

/**
 * POST /api/batches, GET /api/batches/:id.
 *
 * The client in this exercise launches hundreds of localized campaigns a month,
 * and a console that runs one campaign does not show that shape. This is the
 * same runCampaign() in a loop - scale here is a loop, not an architecture -
 * and it runs them SEQUENTIALLY on purpose: every campaign in a batch can spend
 * money, and firing them concurrently would multiply the rate-limit exposure
 * and make the spend impossible to watch as it happens.
 */
export type BatchState = {
  batchId: string;
  status: "running" | "complete";
  startedAt: string;
  campaigns: BatchCampaign[];
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
/**
 * GET /api/looks. One art-direction look the console may run with.
 *
 * Structurally identical to what LOOK_OPTIONS holds, declared here because this
 * is the file both ends import: the browser must not reach into artDirection.ts
 * to learn the shape of an HTTP response.
 */
export type LookOption = {
  id: string;
  label: string;
  description: string;
};

export type FormatOption = {
  key: RatioKey;
  label: string;
  width: number;
  height: number;
  /** One of the three the exercise names. Selected by default. */
  required: boolean;
};
