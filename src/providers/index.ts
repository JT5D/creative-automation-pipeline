import { FireflyHeroGenerator } from "./firefly.js";
import { GeminiHeroGenerator } from "./gemini.js";
import { GenerationUnavailableError, type HeroGenerator } from "./types.js";

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
export function selectGenerator(env: NodeJS.ProcessEnv = process.env): HeroGenerator {
  const { FIREFLY_SERVICES_CLIENT_ID, FIREFLY_SERVICES_CLIENT_SECRET, GEMINI_API_KEY } = env;

  if (FIREFLY_SERVICES_CLIENT_ID && FIREFLY_SERVICES_CLIENT_SECRET) {
    return new FireflyHeroGenerator(
      FIREFLY_SERVICES_CLIENT_ID,
      FIREFLY_SERVICES_CLIENT_SECRET,
    );
  }

  if (GEMINI_API_KEY) {
    return new GeminiHeroGenerator(GEMINI_API_KEY);
  }

  throw new GenerationUnavailableError(
    "No image provider configured. Set GEMINI_API_KEY (free: https://aistudio.google.com/apikey) " +
      "or FIREFLY_SERVICES_CLIENT_ID + FIREFLY_SERVICES_CLIENT_SECRET in .env",
  );
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
          : `Google Gemini — ${g.model}`,
      configured: true,
    };
  } catch {
    return {
      provider: "none",
      model: "—",
      label: "Generation unavailable — no API key configured",
      configured: false,
    };
  }
}

export * from "./types.js";
