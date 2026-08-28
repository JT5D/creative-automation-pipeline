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

/**
 * Turns a provider's raw HTTP failure into something safe to show a browser.
 *
 * Provider bodies are attacker-adjacent and frequently echo the request back,
 * so forwarding one verbatim risks putting a credential on screen and in the
 * run log. This keeps what a human needs to act -- who refused, the status, a
 * short reason -- and drops the rest.
 */
export function safeProviderMessage(
  provider: string,
  status: number,
  body: string,
  requestId?: string,
): string {
  const reason = body
    // Anything shaped like a credential goes first, before truncation.
    .replace(/AIza[\w-]{10,}|AQ\.[\w-]{10,}|sk-[\w-]{10,}|Bearer\s+[\w.-]{10,}/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const id = requestId ? ` [request ${requestId}]` : "";
  return `${provider} refused the request (HTTP ${status})${id}: ${reason || "no detail returned"}`;
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
