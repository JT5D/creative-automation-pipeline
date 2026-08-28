/**
 * What the console renders, imported from the modules that produce it.
 *
 * Re-exported, never redeclared. A hand-written copy of a server type is a
 * type that will be wrong later, and nothing fails when it is.
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
