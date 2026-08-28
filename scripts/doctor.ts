import "dotenv/config";
import { providerStatus } from "../src/providers/index.js";

/**
 * Verifies the provider is reachable and that the configured model actually
 * exists — before the demo, not during it.
 *
 * What it CANNOT tell you: whether the account can actually pay for an image.
 * Google lists no free tier for any image model, and quota only reveals itself
 * on a real generation, so a green doctor plus a 429 at run time is a genuine
 * possibility. The paid smoke run is the only proof, and this says so rather
 * than implying otherwise.
 *
 *   npm run doctor
 */
async function main() {
  const status = providerStatus();
  console.log(`\nProvider: ${status.label}`);

  if (!status.configured) {
    console.log(
      "\n  Set GEMINI_API_KEY in .env — a Google AI Studio key WITH BILLING ENABLED" +
        "\n  is required for image generation: https://aistudio.google.com/apikey\n",
    );
    process.exit(1);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("\n  GEMINI_API_KEY is not set.\n");
    process.exit(1);
  }

  if (status.provider !== "google-gemini") {
    console.log("  (live model check implemented for Gemini only)\n");
    return;
  }

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) {
    console.error(`\n✗ Gemini rejected the key (HTTP ${res.status})\n`);
    process.exit(1);
  }

  const json = (await res.json()) as { models?: { name: string }[] };
  const names = (json.models ?? []).map((m) => m.name.replace("models/", ""));
  const imageModels = names.filter((n) => n.includes("image"));

  console.log(`  key accepted · ${names.length} models visible`);
  console.log(`  image models: ${imageModels.join(", ") || "none found"}`);

  const configured = status.model;
  const ok = names.includes(configured);
  console.log(`\n  configured model "${configured}" → ${ok ? "AVAILABLE" : "NOT LISTED"}`);
  if (!ok) {
    console.log("  Override with GEMINI_IMAGE_MODEL=<id> in .env if needed.\n");
    process.exit(1);
  }
  console.log(
    "\n  This proves the key and the model id. It does NOT prove image-generation" +
      "\n  quota — no Gemini image model has a free tier, and billing only shows up" +
      "\n  when a generation is attempted. One real run is the proof.\n",
  );
}

main().catch((e: unknown) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
