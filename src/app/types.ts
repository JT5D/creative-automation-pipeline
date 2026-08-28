export type ValidationCheck = {
  id: string;
  status: "pass" | "warning" | "fail";
  message: string;
};
export type ValidationResult = { status: "pass" | "warning" | "fail"; checks: ValidationCheck[] };

export type Creative = {
  ratio: "1x1" | "4x5" | "9x16" | "16x9";
  locale: string;
  width: number;
  height: number;
  outputPath: string;
  bytes: number;
  validation: ValidationResult;
  durationMs: number;
};

export type Hero = {
  productId: string;
  source: "reused" | "generated" | "generated_cached" | "placeholder";
  localPath: string;
  width: number;
  height: number;
  sourceAssetPath?: string;
  generation?: {
    provider: string;
    operation: string;
    model?: string;
    prompt: string;
    durationMs: number;
    requestId?: string;
  };
};

export type ProductRecord = {
  productId: string;
  productName: string;
  hero: Hero;
  creatives: Creative[];
};

export type CampaignReport = {
  campaignId: string;
  campaignName: string;
  region: string;
  audience: string;
  message: string;
  markets: { locale: string; message: string }[];
  mode: "dev" | "final";
  provider: { provider: string; model: string };
  durationMs: number;
  preflight: ValidationResult;
  metrics: {
    productsProcessed: number;
    productsFailed: number;
    marketsProcessed: number;
    approvedAssetsReused: number;
    heroesGenerated: number;
    heroesFromCache: number;
    heroesPlaceholder: number;
    variantsCreated: number;
    validationPassed: number;
    validationWarnings: number;
    validationFailed: number;
    generationRequests: number;
  };
  /** The three the assessment FAQ names, computed in src/report.ts. */
  successMetrics: {
    timeSaved?: { minutes: number; baselineMinutesPerCreative: number; basis: string };
    campaignsGenerated: { campaigns: number; creatives: number; markets: number };
    efficiency: {
      creativesPerGenerationCall: number | null;
      costPerCreativeUsd: number | null;
      reuseRate: number;
      secondsPerCreative: number;
    };
  };
  assignmentProof: {
    passed: boolean;
    checks: { id: string; passed: boolean; message: string }[];
  };
  products: ProductRecord[];
  failures: { productId: string; productName: string; stage: string; message: string }[];
  warnings: string[];
  estimatedCostUsd?: {
    generations: number;
    unitPriceUsd: number;
    totalUsd: number;
    source: string;
  };
  estimatedTimeSaved?: { baselineMinutesPerCreative: number; savedMinutes: number; basis: string };
};

export type PipelineEvent = {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
};

export type RunState = {
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  events: PipelineEvent[];
  report?: CampaignReport;
  error?: string;
};

export type ProviderStatus = {
  provider: string;
  model: string;
  label: string;
  configured: boolean;
};

export type BriefSummary = {
  file: string;
  label: string;
  teaches: string;
  expect: string;
};

export type ModelOption = { id: string; label: string; usdPer2K: number; note: string };

export type FormatOption = {
  key: "1x1" | "4x5" | "9x16" | "16x9";
  label: string;
  width: number;
  height: number;
  /** One of the three the exercise names. Selected by default. */
  required: boolean;
};

export type PlannedProduct = {
  productId: string;
  productName: string;
  action: "reuse" | "generate";
  sourceAssetPath?: string;
  usingReference: boolean;
};

export type CampaignEstimate = {
  campaignId: string;
  campaignName: string;
  preflight: ValidationResult;
  blocked: boolean;
  model: string;
  ratios: string[];
  locales: string[];
  products: PlannedProduct[];
  variants: number;
  generations: number;
  estimatedCostUsd?: {
    generations: number;
    unitPriceUsd: number;
    totalUsd: number;
    source: string;
  };
  estimatedTimeSaved?: { baselineMinutesPerCreative: number; savedMinutes: number; basis: string };
};

export type Insights = {
  runs: number;
  campaigns: number;
  creatives: number;
  generationRequests: number;
  reuseRate: number;
  totalCostUsd: number;
  costPerCreativeUsd: number;
  totalSavedMinutes: number;
  avgDurationMs: number;
  history: {
    at: string;
    campaignName: string;
    mode: string;
    model: string;
    variants: number;
    reused: number;
    generationRequests: number;
    costUsd: number;
    durationMs: number;
  }[];
};
