import type { CanonicalHeroAsset } from "../schema.js";

export type HeroRequest = {
  productId: string;
  productName: string;
  campaignMessage: string;
  region: string;
  audience: string;
  brandName: string;
  /** Fully-built art-direction prompt. Deterministic, never LLM-authored. */
  prompt: string;
  /** Approved packshot used as an identity anchor when one exists. */
  referenceAssetPath?: string;
};

export type GeneratedHero = {
  bytes: Buffer;
  mimeType: string;
  provider: string;
  operation: NonNullable<CanonicalHeroAsset["generation"]>["operation"];
  model?: string;
  requestId?: string;
  durationMs: number;
};

/**
 * The only thing the pipeline knows about image generation.
 *
 * Swapping Gemini for Adobe Firefly Services, or for a customer's own
 * fine-tuned model, is a change to exactly one file. Nothing downstream of
 * the canonical hero moves.
 */
export interface HeroGenerator {
  readonly provider: string;
  readonly model: string;
  generateHero(input: HeroRequest): Promise<GeneratedHero>;
}

export class GenerationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationUnavailableError";
  }
}

/**
 * A provider call that failed, carrying enough information to decide whether
 * trying again could possibly help.
 *
 * Rate limits and server faults are worth retrying; a bad request or a rejected
 * key is not, and retrying it just spends time and quota to fail identically.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = status === undefined ? false : status === 429 || status >= 500;
  }
}
