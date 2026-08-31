import { FireflyHeroGenerator } from "./firefly.js";
import { GeminiHeroGenerator } from "./gemini.js";
import { PlaceholderHeroGenerator } from "./placeholder.js";
import type { HeroGenerator } from "./types.js";

export type ProviderStatus = {
  provider: string;
  model: string;
  /** Provider and model together, for anywhere the model is not already shown. */
  label: string;
  /**
   * The provider alone.
   *
   * The console shows this in the status pill, because the model picker sits
   * directly beside it saying the same model id. Two controls, 570px of header,
   * one fact.
   */
  name: string;
  configured: boolean;
  /**
   * What happens to the provider that is NOT running, in one sentence.
   *
   * Adobe Firefly is the right production choice here and the adapter is
   * written, but Firefly Services needs an enterprise entitlement this project
   * does not have, so it has never been executed. The console says that in a
   * line rather than offering a Firefly button that would do nothing -- a
   * control that silently fails is worse than an absent one, because someone
   * will press it in a demo. Absent when Firefly IS the selected provider.
   */
  handoff?: string;
};

const FIREFLY_HANDOFF =
  "Adobe Firefly Image Model 5 is the production target: the adapter is written " +
  "(src/providers/firefly.ts) and has never been executed, because Firefly " +
  "Services needs an enterprise entitlement.";

const CHOOSE =
  "Set IMAGE_PROVIDER=gemini or IMAGE_PROVIDER=firefly - both are configured and " +
  "guessing which one should spend money is not a decision this code should make.";

/**
 * Picks the generator, explicitly.
 *
 * Selection is explicit. Letting Firefly win because two environment variables
 * happened to be present. That is the wrong default for an adapter this repo
 * has never executed against a live endpoint: the run that matters would have
 * silently changed provider. So selection is stated, not inferred:
 * `IMAGE_PROVIDER` decides, and the only inference left is the unambiguous
 * case where exactly one real provider is configured.
 *
 * There is no runtime fallback. If the selected provider cannot be built the
 * run fails, because quietly producing something from a different source is
 * the failure mode this whole codebase is written against.
 */
export function selectGenerator(
  env: NodeJS.ProcessEnv = process.env,
  /** Per-run model override. Passed explicitly so concurrent runs cannot race. */
  model?: string,
): HeroGenerator {
  const { FIREFLY_SERVICES_CLIENT_ID, FIREFLY_SERVICES_CLIENT_SECRET, GEMINI_API_KEY } = env;
  const firefly = Boolean(FIREFLY_SERVICES_CLIENT_ID && FIREFLY_SERVICES_CLIENT_SECRET);
  const gemini = Boolean(GEMINI_API_KEY);
  const chosen = env.IMAGE_PROVIDER?.trim().toLowerCase();

  if (chosen === "firefly") {
    if (!firefly) {
      throw new Error(
        "IMAGE_PROVIDER=firefly but FIREFLY_SERVICES_CLIENT_ID / _SECRET are not set.",
      );
    }
    return new FireflyHeroGenerator(
      FIREFLY_SERVICES_CLIENT_ID as string,
      FIREFLY_SERVICES_CLIENT_SECRET as string,
    );
  }

  if (chosen === "gemini") {
    if (!gemini) throw new Error("IMAGE_PROVIDER=gemini but GEMINI_API_KEY is not set.");
    return new GeminiHeroGenerator(GEMINI_API_KEY as string, model || env.GEMINI_IMAGE_MODEL);
  }

  if (chosen) throw new Error(`Unknown IMAGE_PROVIDER "${chosen}". Use gemini or firefly.`);

  if (firefly && gemini) throw new Error(CHOOSE);
  if (firefly) {
    return new FireflyHeroGenerator(
      FIREFLY_SERVICES_CLIENT_ID as string,
      FIREFLY_SERVICES_CLIENT_SECRET as string,
    );
  }
  if (gemini)
    return new GeminiHeroGenerator(GEMINI_API_KEY as string, model || env.GEMINI_IMAGE_MODEL);

  // No credentials at all: render offline rather than fail, so the repo runs on
  // a fresh clone. The result is labelled a placeholder everywhere it appears,
  // is never counted as a generation, and cannot satisfy `final` mode.
  return new PlaceholderHeroGenerator();
}

/** Non-throwing view of provider state, safe to send to the browser. */
export function providerStatus(env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  try {
    const g = selectGenerator(env);
    return {
      provider: g.provider,
      model: g.model,
      name:
        g.provider === "adobe-firefly"
          ? "Adobe Firefly"
          : g.provider === "google-gemini"
            ? "Google Gemini"
            : "Offline preview",
      label:
        g.provider === "adobe-firefly"
          ? `Adobe Firefly - ${g.model}`
          : g.provider === "google-gemini"
            ? `Google Gemini - ${g.model}`
            : "Offline preview - no model will be called",
      configured: g.provider !== "offline-placeholder",
      handoff: g.provider === "adobe-firefly" ? undefined : FIREFLY_HANDOFF,
    };
  } catch (error) {
    return {
      provider: "none",
      model: "-",
      name: "Generation unavailable",
      label: error instanceof Error ? error.message : "Generation unavailable",
      configured: false,
      handoff: FIREFLY_HANDOFF,
    };
  }
}

export * from "./types.js";
