# API contract notes

Verified 2026-08-28. This file exists so the integration is written against the
current contract rather than a stale tutorial, and so anyone reading the code
can see exactly which claims were checked and which were not.

---

## Google Gemini — image generation (the provider this repo runs on)

**Endpoint**

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```

**Request** — `response_format` is a **top-level** field. It is *not* nested
inside `generationConfig`, which is where the older `generateContent` API put
image options. Copying that older shape silently produces a text response.

```json
{
  "model": "gemini-3.1-flash-image",
  "input": [
    { "type": "text", "text": "<prompt>" },
    { "type": "image", "mime_type": "image/png", "data": "<base64>" }
  ],
  "response_format": {
    "type": "image",
    "mime_type": "image/jpeg",
    "aspect_ratio": "1:1",
    "image_size": "2K"
  }
}
```

**`mime_type` accepts only `image/jpeg`.** Sending `image/png` is rejected:

```
HTTP 400 — "The value 'image/png' is not supported for
'response_format.mime_type'. Supported values: 'image/jpeg'."
```

Found by running the live endpoint, not from the docs — the guide does not
state this restriction. Final creatives are re-encoded to PNG by the
compositor, so it affects transport only.

Supported `aspect_ratio`: `1:1 3:2 2:3 3:4 4:3 4:5 5:4 9:16 16:9 21:9`
Supported `image_size`: `512px 1K 2K 4K` (the `-lite` model is 1K only).

Current image model ids: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`,
`gemini-3-pro-image`, `gemini-2.5-flash-image` (legacy).

**Documented discrepancy.** The image-generation guide shows the Interactions
endpoint at `/v1beta/interactions`, including in a verbatim curl example. The
migrate-to-interactions guide refers to `/v1beta2/interactions`. Two sources
against one, and the executable example is the stronger evidence, so the code
uses `/v1beta`. `npm run doctor` verifies the key and the model id against the
live `/v1beta/models` listing before a demo, so this fails loudly and early
rather than mid-run.

**Response.** The image arrives either at `output_image.data` or nested under
`steps[].content[]`. Because Google is actively migrating this shape,
`findFirstImage()` in `src/providers/gemini.ts` walks the response for the
first node carrying base64 image bytes instead of betting on one path. It also
understands the legacy `inlineData` shape, so a fall back to `generateContent`
would not require a parser change.

`generateContent` remains fully supported for image generation and is the
documented legacy path.

---

## Adobe Firefly Services — written, not executed

`src/providers/firefly.ts` is implemented against Adobe's published contract.
**It has not been run against a live endpoint.** Firefly Services requires an
enterprise entitlement on Adobe Developer Console, and the assessment FAQ
states that no keys are provided ("You may use any third-party tool and
available API keys. No specific keys are provided.").

It ships anyway because it makes the provider seam concrete rather than
theoretical: set the two Firefly variables and `selectGenerator()` picks it,
with no change to the resolver, composer, validator, or report.

Contract used:

| Concern | Value |
|---|---|
| IMS token | `POST https://ims-na1.adobelogin.com/ims/token/v3` |
| Grant | `client_credentials` |
| Scopes | `openid, AdobeID, session, additional_info, read_organizations, firefly_api, ff_apis` |
| Generation | `POST https://firefly-api.adobe.io/v4/images/generate-async` |
| Headers | `Authorization: Bearer <token>`, `x-api-key: <client id>` |
| Pattern | submit → poll real job status → download presigned result → persist locally |

**Image Model 5 is a breaking change** from Image3/Image4: it takes an explicit
`size` object, and the older `aspectRatio` and `modelVersion` fields are gone.
Several tutorial pages still show the old payload shape.

Where the live contract turns out to differ from this, the live contract wins
and this file is the thing to correct.

---

## Deliberately not integrated

Adobe already sells these, and rebuilding them inside a take-home would be the
wrong instinct:

| Capability | Adobe product that owns it |
|---|---|
| Generative expand / reframe | Firefly Expand, Generative Fill |
| Product-in-scene compositing | Generate Object Composite, Precise / Adaptive Composite |
| Layered template production | Photoshop API **v2** (v1 reached EOL 2026-07-31) |
| Repeatable creative workflows | Firefly Graph, Firefly Creative Production |
| Governed multi-model access | Firefly Creative Production for Enterprise |
| Batch execution at scale | Creative Production Workflow API |

Firefly's UI exposes partner models (Gemini/Nano Banana, GPT Image, FLUX,
Ideogram, Runway, Veo, Kling). Availability in that UI does **not** imply the
standalone Firefly REST endpoint accepts arbitrary partner-model ids — these
are different surfaces, and this repo does not assume otherwise.
