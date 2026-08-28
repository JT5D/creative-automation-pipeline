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
   * Output size to ask the provider for.
   *
   * 2K is what ships, and it is not optional for the deliverable: every format
   * is a centre crop of one square hero, and 9:16 needs 1080x1920 out of it, so
   * a 1K hero would be upscaled about 1.9x and go soft. 1K exists for PREVIEW,
   * where the question is "is this the right look" rather than "is the label
   * crisp" - and 1K unlocks the cheap models, which is where the saving is.
   */
  imageSize?: "1K" | "2K";
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

/**
 * Runs a provider request under a deadline and turns whatever comes back into a
 * ProviderError, so the pipeline never has to know that `fetch` signals a
 * timeout by throwing a DOMException called TimeoutError.
 *
 * A timeout carries no status, which `withRetry` reads as not retryable. That
 * is the right default here: a request that hung may already have been accepted
 * and billed upstream, and the failure mode is "no answer", not "refused".
 */
export async function fetchWithDeadline(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError(
        `${provider} did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
          "The request may still have been accepted and billed, so it is not retried automatically.",
      );
    }
    throw new ProviderError(
      `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
