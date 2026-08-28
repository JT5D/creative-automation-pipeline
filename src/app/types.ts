/**
 * What the console renders, imported from the modules that produce it.
 *
 * This file used to redeclare the report, the creative, the hero, the estimate
 * and the insights by hand -- about 170 lines of structural copies of types
 * that already existed three directories up. They had already drifted: the
 * browser's CampaignReport was missing startedAt and completedAt, and its
 * estimatedTimeSaved had three of the six fields the server sends. A copy of a
 * type is a type that will be wrong later, and nothing would have failed when
 * it was.
 *
 * Re-exporting is safe in the bundle because every line here is `export type`,
 * which is erased before the browser sees it -- no server module is pulled in.
 * The three shapes that exist only because of HTTP live in src/api.ts, which
 * both ends import.
 */
export type {
  BatchCampaign,
  BatchState,
  BriefSummary,
  FormatOption,
  LookOption,
  RunState,
} from "../api.js";
export type { CampaignEstimate, PlannedProduct } from "../estimate.js";
export type { Insights } from "../history.js";
export type { PipelineEvent } from "../pipeline.js";
export type { ModelOption } from "../pricing.js";
export type { ProviderStatus } from "../providers/index.js";
export type {
  AssignmentCheck,
  CampaignReport,
  CreativeRecord as Creative,
  ProductFailure,
  ProductRecord,
} from "../report.js";
export type {
  CanonicalHeroAsset as Hero,
  ValidationCheck,
  ValidationResult,
} from "../schema.js";
