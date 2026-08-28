import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GenerationUnavailableError,
  type GeneratedHero,
  type HeroGenerator,
  type HeroRequest,
} from "./types.js";

/**
 * Google Gemini image generation via the Interactions API.
 *
 * Contract verified against ai.google.dev on 2026-08-28 — see docs/API_NOTES.md.
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   auth: x-goog-api-key header
 *   response_format is TOP-LEVEL, not nested inside generationConfig.
 */
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
/**
 * Frontier tier by default.
 *
 * The pipeline makes exactly ONE generation call per missing hero, so the
 * premium model costs $0.134 against $0.101 for the flash tier -- about three
 * cents per campaign -- and that single image is the one thing a reviewer
 * actually looks at. Spending at the point of visible quality and saving on
 * the deterministic transforms is the whole cost strategy.
 *
 * Override with GEMINI_IMAGE_MODEL to trade quality for cost at scale.
 */
const DEFAULT_MODEL = "gemini-3-pro-image";

/**
 * Verified per-image output pricing, ai.google.dev/gemini-api/docs/pricing,
 * checked 2026-08-28. Used only for a clearly-labelled cost estimate in
 * report.json -- never presented as a billed amount.
 */
export const USD_PER_IMAGE_2K: Record<string, number> = {
  "gemini-3-pro-image": 0.134,
  "gemini-3.1-flash-image": 0.101,
  "gemini-3.1-flash-lite-image": 0.0336,
  "gemini-2.5-flash-image": 0.039,
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export class GeminiHeroGenerator implements HeroGenerator {
  readonly provider = "google-gemini";
  readonly model: string;

  constructor(private readonly apiKey: string, model = process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL) {
    if (!apiKey) throw new GenerationUnavailableError("GEMINI_API_KEY is not set");
    this.model = model;
  }

  async generateHero(input: HeroRequest): Promise<GeneratedHero> {
    const startedAt = Date.now();

    // An approved packshot, when we have one, is sent as an identity anchor so
    // the model composites the real product into a new scene instead of
    // inventing its own version of the packaging.
    const parts: unknown[] = [{ type: "text", text: input.prompt }];
    let operation: GeneratedHero["operation"] = "text-to-image";

    if (input.referenceAssetPath) {
      const bytes = await readFile(input.referenceAssetPath);
      const ext = path.extname(input.referenceAssetPath).toLowerCase();
      parts.push({
        type: "image",
        mime_type: MIME_BY_EXT[ext] ?? "image/png",
        data: bytes.toString("base64"),
      });
      operation = "image-reference";
    }

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: parts,
        // One canonical square hero with deliberate negative space. The three
        // channel ratios are cut from this locally -- we never pay for three.
        // The API accepts only image/jpeg here -- image/png is rejected with
        // HTTP 400 (verified against the live endpoint 2026-08-28). Outputs
        // are re-encoded to PNG by the compositor, so this is a transport
        // detail, not a quality one.
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "1:1",
          image_size: "2K",
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Gemini generation failed (HTTP ${res.status}): ${body.slice(0, 400)}`,
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    const image = findFirstImage(json);
    if (!image) {
      throw new Error(
        `Gemini returned no image data. Response keys: ${Object.keys(json).join(", ")}`,
      );
    }

    return {
      bytes: Buffer.from(image.data, "base64"),
      mimeType: image.mimeType,
      provider: this.provider,
      operation,
      model: this.model,
      requestId: typeof json.id === "string" ? json.id : undefined,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The Interactions API surfaces the image either at `output_image` or nested in
 * `steps[].content[]`, and Google is actively migrating this shape. Rather than
 * betting on one path, walk the response for the first node that carries base64
 * image bytes. Cheap, and immune to the response shape moving under us.
 */
function findFirstImage(node: unknown): { data: string; mimeType: string } | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstImage(item);
      if (found) return found;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  // Interactions shape: { type: "image", mime_type, data }
  const mime = obj.mime_type ?? obj.mimeType;
  if (typeof obj.data === "string" && obj.data.length > 128) {
    return {
      data: obj.data,
      mimeType: typeof mime === "string" ? mime : "image/png",
    };
  }

  // Legacy generateContent shape: { inlineData: { mimeType, data } }
  if (obj.inlineData && typeof obj.inlineData === "object") {
    const inline = obj.inlineData as Record<string, unknown>;
    if (typeof inline.data === "string") {
      return {
        data: inline.data,
        mimeType: typeof inline.mimeType === "string" ? inline.mimeType : "image/png",
      };
    }
  }

  for (const value of Object.values(obj)) {
    const found = findFirstImage(value);
    if (found) return found;
  }
  return null;
}
