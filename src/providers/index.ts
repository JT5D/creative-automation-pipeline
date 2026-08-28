import { FireflyHeroGenerator } from "./firefly.js";
import { GeminiHeroGenerator } from "./gemini.js";
import { PlaceholderHeroGenerator } from "./placeholder.js";
import { type HeroGenerator } from "./types.js";

export type ProviderStatus = {
  provider: string;
  model: string;
  label: string;
  configured: boolean;
};

/**
 * Picks the generator from whatever credentials are actually present.
 *
 * Firefly wins when configured because this is an Adobe-native pipeline;
 * Gemini is the path that any evaluator can run with a free self-serve key.
 * There is no silent fallback -- whichever one runs is named in the UI, in
 * report.json, and in every provenance record.
 */
export function selectGenerator(
  env: NodeJS.ProcessEnv = process.env,
  /** Per-run model override. Passed explicitly so concurrent runs cannot race. */
  model?: string,
): HeroGenerator {
  const { FIREFLY_SERVICES_CLIENT_ID, FIREFLY_SERVICES_CLIENT_SECRET, GEMINI_API_KEY } = env;

  if (FIREFLY_SERVICES_CLIENT_ID && FIREFLY_SERVICES_CLIENT_SECRET) {
    return new FireflyHeroGenerator(
      FIREFLY_SERVICES_CLIENT_ID,
      FIREFLY_SERVICES_CLIENT_SECRET,
    );
  }

  if (GEMINI_API_KEY) {
    return new GeminiHeroGenerator(GEMINI_API_KEY, model || env.GEMINI_IMAGE_MODEL);
  }

  // No credentials: render offline rather than fail. The repo stays runnable
  // on a fresh clone, and the placeholder is labelled as such everywhere it
  // appears -- it is never counted as a generation.
  return new PlaceholderHeroGenerator();
}

/** Non-throwing view of provider state, safe to send to the browser. */
export function providerStatus(env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  try {
    const g = selectGenerator(env);
    return {
      provider: g.provider,
      model: g.model,
      label:
        g.provider === "adobe-firefly"
          ? `Adobe Firefly — ${g.model}`
          : g.provider === "google-gemini"
            ? `Google Gemini — ${g.model}`
            : "Offline placeholder — no model will be called",
      configured: g.provider !== "offline-placeholder",
    };
  } catch (error) {
    return {
      provider: "none",
      model: "—",
      label: error instanceof Error ? error.message : "Generation unavailable",
      configured: false,
    };
  }
}

export * from "./types.js";
