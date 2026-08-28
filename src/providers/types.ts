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
  /**
   * Reproduce a previous generation. Honoured by providers that support seeds;
   * ignored, never faked, by those that do not.
   */
  seed?: number;
};

export type GeneratedHero = {
  bytes: Buffer;
  mimeType: string;
  provider: string;
  operation: NonNullable<CanonicalHeroAsset["generation"]>["operation"];
  model?: string;
  requestId?: string;
  /** Present only when the provider actually returned one. */
  seed?: number;
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
