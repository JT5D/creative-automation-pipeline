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
  products: ProductRecord[];
  warnings: string[];
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
