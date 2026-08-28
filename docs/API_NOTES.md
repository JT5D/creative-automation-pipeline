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
theoretical: set the two Firefly variables plus `IMAGE_PROVIDER=firefly` and it
runs, with no change to the resolver, composer, validator, or report. It is
never selected implicitly — an adapter nobody has executed must not be able to
win by accident.

Contract used:

| Concern | Value |
|---|---|
| IMS token | `POST https://ims-na1.adobelogin.com/ims/token/v3` |
| Grant | `client_credentials` |
| Scopes | `openid, AdobeID, session, additional_info, read_organizations, firefly_api, ff_apis` |
| Generation | `POST https://firefly-api.adobe.io/v4/images/generate-async` |
| Headers | `Authorization: Bearer <token>`, `x-api-key: <client id>` |
| Pattern | submit → poll real job status → download presigned result → persist locally |

**v3 and v4 take different bodies, and mixing them is the trap.** v3
(`/v3/images/generate-async`) takes `size: { width, height }`. Image Model 5
(`/v4/images/generate-async`) takes `modelId: "firefly_image"` plus
`aspectRatio`, `numVariations`, `referenceBlobs` and an optional
`modelSpecificPayload`. Adobe states the mode is decided by that array: *"the
mode is determined by content in the `referenceBlobs` field"* — empty is
generation, populated is edit/reference. An earlier version of this adapter sent
a v3-shaped body to the v4 endpoint, which would have failed on the first real
call.

Body sent here, field by field:

| Field | Value | Provenance |
|---|---|---|
| `prompt` | deterministic art direction | published Image5 example |
| `modelId` | `"firefly_image"` | published Image5 example |
| `numVariations` | `1` | published Image5 example |
| `referenceBlobs` | `[]` | published Image5 example — empty selects generation |
| `modelSpecificPayload.prompt_reasoner` | `"quality"` | published Image5 example |
| `aspectRatio` | `"1:1"` | **UNVERIFIED VALUE.** The field is documented; Adobe's examples show only `"16:9"` and `"4:3"` and do not enumerate the allowed set |

That last row is the one thing in this integration I cannot cite, and it is
listed rather than buried. Where the live contract differs, the live contract
wins and this file is what gets corrected.

**Why raw `fetch` and not the official SDK.** `Firefly-Services/firefly-services-sdk-js`
exists, but it was last published before Image Model 5 and adds a dependency to
a path this repo cannot execute. 190 lines of `fetch` keep the wire contract
visible, which is the part worth reviewing.

---

## Deliberately not integrated

Adobe already sells these, and rebuilding them here would be the wrong
instinct:

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
