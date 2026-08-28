# Which image model, and why

Primary sources, checked 2026-08-28.

## The short answer

**Adobe Firefly is the default provider. Gemini 3 Pro Image is the fallback
that actually runs here, because no Firefly entitlement was available.**

`selectGenerator()` encodes exactly that order: Firefly if credentials exist,
Gemini otherwise, and the choice is named in the UI, in `report.json` and in
every provenance record.

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

Adobe's enterprise indemnification extends to outputs from **Firefly, Google
and OpenAI models** accessed through Adobe's surface.

That single fact resolves the "should we integrate every frontier vendor"
question. A customer does not need six direct vendor contracts to use six
frontier models — they need **one governed Adobe surface** that already carries
model access, entitlement, regional availability and legal cover.

So the right way to offer model choice to an enterprise is Firefly Creative
Production's governed model selection, not a pile of direct API keys. Collecting
vendor keys demonstrates procurement, not judgment.

This is why the repo asks for **one** credential and ships **one** non-Adobe
adapter, rather than six.

## Why Gemini 3 Pro Image as the fallback

| Model | 2K image | Note |
|---|---|---|
| `gemini-3-pro-image` | **$0.134** | the default here |
| `gemini-3.1-flash-image` | $0.101 | workhorse tier |
| `gemini-3.1-flash-lite-image` | $0.0336 | 1K only |
| `gemini-2.5-flash-image` | $0.039 | legacy |

Source: ai.google.dev/gemini-api/docs/pricing, verified 2026-08-28.

- It is **self-serve**. Any evaluator can get a free key in two minutes, which
  matters more than a couple of Elo points when the deliverable has to run on
  someone else's machine.
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
`/v4/images/generate-async`. Object Composite is the first thing I would wire
next on an entitled account, and it is noted as such in the code.

## Reproducibility — where Adobe is genuinely ahead

A generated hero is not a one-off. A brand may need the same image again a year
later: a legal re-review, an audit, a re-render at a new size, a market that
adopts the campaign late. That requires the generation to be repeatable.

**Adobe Firefly supports seeds.** The request takes `"seeds": [1842533538]`, and
the response returns the seed it used at `result.outputs[].seed`. Adobe's
documentation states that "using the same seed, prompt, and other presets,
would generate the same image every time."

**Gemini's image API does not expose a seed.** There is no seed, temperature or
determinism control documented for image generation — only `thinking_level`.
Re-running the same prompt gives a different picture.

Both checked 2026-08-28. Adobe documents seeds on the v3 endpoint; I have not
found a v4 statement either way, so the adapter sends `seeds` only when a seed
is asked for, and a version that ignores it simply degrades to ordinary
generation.

This is a concrete production capability, not a benchmark score, and it is the
kind of thing that decides an enterprise choice:

| | Firefly | Gemini image |
|---|---|---|
| Reproduce an exact prior generation | **yes, via seed** | no |
| Seed recorded in provenance | **yes** | n/a |
| Regenerate for audit or re-render | **yes** | re-prompt and accept a new image |

`CanonicalHeroAsset.generation.seed` carries it when the provider returns one,
and is **absent** when it does not — absent being the honest answer rather than
a fabricated number. Everything downstream of the hero is already deterministic
in this pipeline: the same hero and brief always produce byte-identical
creatives, which a test asserts. Seeds close the one remaining gap, and only
Adobe can close it today.

## Models deliberately not integrated

FLUX, Ideogram, Midjourney, Runway, Kling, Veo, Seedance — all credible, none
integrated. Adding direct adapters would mean more keys for an evaluator, more
surface to defend, and no new capability the assignment asks for. The
`HeroGenerator` interface is thirty lines; any of them is a one-file addition
when a customer's governance actually calls for it.
