import { ProviderError } from "./providers/types.js";

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Retries a provider call, but only when trying again could plausibly work.
 *
 * A rate limit or a server fault is transient; a malformed request or a
 * rejected key is not, and retrying those spends quota to fail identically.
 * Backoff is exponential so a provider under load is not hammered.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: Error = new Error("no attempt was made");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const retryable = lastError instanceof ProviderError && lastError.retryable;
      if (!retryable || attempt === attempts) throw lastError;

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, delayMs, lastError);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
