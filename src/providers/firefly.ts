import {
  type GeneratedHero,
  GenerationUnavailableError,
  type HeroGenerator,
  type HeroRequest,
} from "./types.js";

/**
 * Adobe Firefly Services adapter (Image Model 5).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HONESTY NOTE: this adapter is written against Adobe's published contract
 * but has NOT been executed against a live endpoint -- Firefly Services needs
 * an enterprise entitlement I do not hold. It ships because it demonstrates
 * that the provider seam is real: swapping Gemini for Firefly is this one
 * file plus two environment variables, and nothing downstream of the
 * canonical hero changes. It is selected automatically when Firefly
 * credentials are present. See docs/API_NOTES.md.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Contract sources (verified 2026-08-28):
 *   IMS token   POST https://ims-na1.adobelogin.com/ims/token/v3
 *   scopes      openid, AdobeID, session, additional_info,
 *               read_organizations, firefly_api, ff_apis
 *   generation  POST https://firefly-api.adobe.io/v4/images/generate-async
 *
 * Image Model 5 is a breaking change from Image3/Image4: it takes an explicit
 * `size`, and the old `aspectRatio` / `modelVersion` fields are gone.
 */
const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
const GENERATE_URL = "https://firefly-api.adobe.io/v4/images/generate-async";
const SCOPES = "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

type CachedToken = { token: string; expiresAt: number };

export class FireflyHeroGenerator implements HeroGenerator {
  readonly provider = "adobe-firefly";
  readonly model = "image5";

  /** Held in server memory only. Never logged, never sent to the browser. */
  private cachedToken: CachedToken | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {
    if (!clientId || !clientSecret) {
      throw new GenerationUnavailableError("Firefly client id/secret not set");
    }
  }

  private async accessToken(): Promise<string> {
    // Re-use until 60s before expiry rather than authenticating per request.
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.token;
    }

    const res = await fetch(IMS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPES,
      }),
    });

    if (!res.ok) {
      throw new Error(`Adobe IMS auth failed (HTTP ${res.status})`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  }

  async generateHero(input: HeroRequest): Promise<GeneratedHero> {
    const startedAt = Date.now();
    const token = await this.accessToken();

    const headers = {
      Authorization: `Bearer ${token}`,
      "x-api-key": this.clientId,
      "Content-Type": "application/json",
    };

    const submit = await fetch(GENERATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: input.prompt,
        numVariations: 1, // Cost control: never fan out candidates.
        size: { width: 2048, height: 2048 }, // Image5 takes explicit size.
      }),
    });

    if (!submit.ok) {
      const body = await submit.text();
      throw new Error(`Firefly submit failed (HTTP ${submit.status}): ${body.slice(0, 400)}`);
    }

    const job = (await submit.json()) as Record<string, unknown>;
    const links = job.links as { self?: string } | undefined;
    const statusUrl =
      (job.statusUrl as string | undefined) ?? links?.self ?? (job.self as string | undefined);
    if (!statusUrl) {
      throw new Error(`Firefly returned no status URL. Keys: ${Object.keys(job).join(", ")}`);
    }

    const result = await this.pollUntilDone(statusUrl, headers);

    // Firefly hands back a presigned URL; fetch the bytes and persist locally
    // immediately, because those URLs are short-lived.
    const imageUrl = findFirstUrl(result);
    if (!imageUrl) throw new Error("Firefly job completed without an image URL");

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error(`Firefly image download failed (HTTP ${imageRes.status})`);
    }
    const bytes = Buffer.from(await imageRes.arrayBuffer());

    return {
      bytes,
      mimeType: "image/png",
      provider: this.provider,
      operation: "text-to-image",
      model: this.model,
      requestId: typeof job.jobId === "string" ? job.jobId : undefined,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Polls the real job status. No progress timers, no simulated advancement. */
  private async pollUntilDone(
    statusUrl: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const res = await fetch(statusUrl, { headers });
      if (!res.ok) throw new Error(`Firefly status poll failed (HTTP ${res.status})`);

      const body = (await res.json()) as Record<string, unknown>;
      const status = String(body.status ?? "").toLowerCase();

      if (status === "succeeded" || status === "done" || body.outputs) return body;
      if (status === "failed" || status === "error") {
        throw new Error(`Firefly job failed: ${JSON.stringify(body).slice(0, 300)}`);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`Firefly job timed out after ${POLL_TIMEOUT_MS}ms`);
  }
}

/** Walks a job result for the first http(s) URL that looks like an image. */
function findFirstUrl(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string" && value.startsWith("http") && /url|href|presigned/i.test(key)) {
      return value;
    }
    const found = findFirstUrl(value);
    if (found) return found;
  }
  return null;
}
