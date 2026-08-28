# Which image model, and why

Primary sources, checked 2026-08-28.

## The short answer

**Gemini 3 Pro Image is what runs here. Adobe Firefly Image Model 5 is the
right production choice and the adapter is written, but there is no entitlement
to execute it, so it is never selected implicitly.**

`selectGenerator()` requires the choice to be stated: one configured provider is
used, two configured providers is an error asking for `IMAGE_PROVIDER`. An
adapter nobody has run must not be able to win by accident.

## Why not simply pick the top of the leaderboard

As of August 2026 **GPT Image 2 leads the blind-vote text-to-image
leaderboards**, by roughly 97 Elo over second place — the widest margin on the
board ([arena.ai](https://arena.ai/leaderboard/text-to-image),
[llm-stats](https://llm-stats.com/leaderboards/best-ai-for-image-generation),
11,271 blind human votes).

Elo is the wrong axis for this decision. A Fortune 100 consumer-goods brand
running a regulated skincare campaign in the EU is not optimising for aesthetic
preference votes. The constraints that actually decide are:

| Constraint | Why it outranks Elo |
|---|---|
| **Commercial safety** | Training data provenance is a legal question, not a quality one |
| **IP indemnification** | Someone has to carry the risk if an output infringes |
| **Content provenance** | C2PA Content Credentials are becoming a disclosure requirement |
| **Product identity** | A campaign must show *the* product, not a plausible one |
| **Governance** | Who may use which model, in which market, under whose contract |

On those axes Adobe wins, and it is not close:

- Adobe trains Firefly **only on content it has permission or rights to use**,
  which is what makes the outputs commercially safe to ship.
- Enterprise customers can obtain **contractual IP indemnification** for
  Firefly outputs through a Firefly/Express site licence or certain Creative
  Cloud for enterprise plans.
- Adobe AI in Creative Cloud for enterprise is **not trained on customer
  content** — which matters when the input is an unreleased packshot.

## The finding that shapes the architecture

Adobe indemnifies its own Firefly outputs, and **separately** covers certain
copyright claims on outputs from *generally available* Google and OpenAI media
models surfaced through **Firefly Creative Production for Enterprise** — not
trademark, publicity or privacy claims, and not beta or preview models
([product description](https://helpx.adobe.com/legal/product-descriptions/partner-model.html),
verified 2026-08-28).

That single fact resolves the "should we integrate every frontier vendor"
question. A customer does not need six direct vendor contracts to use six
frontier models — they need **one governed Adobe surface** that already carries
model access, entitlement, regional availability and legal cover.

So the right way to offer model choice to an enterprise is Firefly Creative
Production's governed model selection, not a pile of direct API keys. Collecting
vendor keys demonstrates procurement, not judgment.

This is why the repo asks for **one** credential and ships **one** non-Adobe
adapter, rather than six.

## Why Gemini 3 Pro Image is the one that runs

| Model | 2K image | Note |
|---|---|---|
| `gemini-3-pro-image` | **$0.134** | the default here |
| `gemini-3.1-flash-image` | $0.101 | workhorse tier |
| `gemini-3.1-flash-lite-image` | $0.0336 | **1K only** — cannot serve this pipeline's 2K hero, so the console does not offer it |
| `gemini-2.5-flash-image` | $0.039 | legacy, capped at 1024×1024 — same exclusion |

Source: ai.google.dev/gemini-api/docs/pricing, verified 2026-08-28.

- It is **self-serve**. An evaluator can provision a key in minutes, which
  matters more than a couple of Elo points when the deliverable has to run on
  someone else's machine. Billing must be enabled — no Gemini image model has a
  free tier (verified 2026-08-28).
- It accepts a **reference image**, which is the capability this pipeline
  actually depends on — see below.
- The pipeline makes exactly **one** call per missing hero, so the frontier
  tier costs about three cents more per campaign than the flash tier. That is
  the correct place to spend.

## Product identity is the real technical requirement

For a CPG campaign, the hard part is not making a beautiful image. It is making
a beautiful image **of the actual product**, with the actual packaging.

Pure text-to-image cannot do this — it invents a plausible jar. So when a
product has an approved packshot, the pipeline sends it to the model as an
identity anchor and the operation is recorded as `image-reference` rather than
`text-to-image`. The real product is composited into a new campaign scene.

Adobe's native equivalents are the composite APIs, and they are the right call
on an entitled account:

| Adobe API | Use |
|---|---|
| **Generate Object Composite** | Generate a scene around a supplied product |
| **Precise Composite** | Preserve the subject exactly, place into a background |
| **Adaptive Composite** | Harmonise an object into an existing background |

`src/providers/firefly.ts` implements text-to-image against
`/v4/images/generate-async` with `referenceBlobs: []`. Populating that array is
Adobe's edit/reference mode, and Generate Object Composite is the first thing I
would wire on an entitled account — it is exactly the "product exists,
background does not" operation this pipeline needs.

## Reproducibility

Everything downstream of the hero is deterministic: the same hero and brief
produce byte-identical creatives, and a test asserts it. The generation itself
is the one non-repeatable step.

Adobe documents **seed-based reproducibility on the v3 generation API** —
`"seeds": [n]` in, `result.outputs[].seed` back, with the same seed, prompt and
presets reproducing the image. Image 5 uses a breaking **v4** schema, and seed
support there was **not verified in this proof-of-concept**, so this
implementation does not claim it and does not send the field.

Gemini's image API documents no seed, temperature or determinism control at
all, so that gap cannot be closed on the provider this repo actually runs.

Recording it honestly: reproducible generation is a real enterprise
requirement, Adobe has documented a mechanism for it, and verifying that
mechanism on Image 5 needs an entitled account this project does not have.

## Models deliberately not integrated

FLUX, Ideogram, Midjourney, Runway, Kling, Veo, Seedance — all credible, none
integrated. Adding direct adapters would mean more keys for an evaluator, more
surface to defend, and no new capability the assignment asks for. The
`HeroGenerator` interface is thirty lines; any of them is a one-file addition
when a customer's governance actually calls for it.
