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
leaderboards**, by roughly 97 Elo over second place - the widest margin on the
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
  content** - which matters when the input is an unreleased packshot.

## The finding that shapes the architecture

Adobe indemnifies its own Firefly outputs, and **separately** covers certain
copyright claims on outputs from *generally available* Google and OpenAI media
models surfaced through **Firefly Creative Production for Enterprise** - not
trademark, publicity or privacy claims, and not beta or preview models
([product description](https://helpx.adobe.com/legal/product-descriptions/partner-model.html),
verified 2026-08-28).

That single fact resolves the "should we integrate every frontier vendor"
question. A customer does not need six direct vendor contracts to use six
frontier models - they need **one governed Adobe surface** that already carries
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
| `gemini-3.1-flash-lite-image` | $0.0336 | **1K only** - cannot serve this pipeline's 2K hero, so the console does not offer it |
| `gemini-2.5-flash-image` | $0.039 | legacy, capped at 1024×1024 - same exclusion |

Source: ai.google.dev/gemini-api/docs/pricing, verified 2026-08-28.

- It is **self-serve**. An evaluator can provision a key in minutes, which
  matters more than a couple of Elo points when the deliverable has to run on
  someone else's machine. Billing must be enabled - no Gemini image model has a
  free tier (verified 2026-08-28).
- It accepts a **reference image**, which is the capability this pipeline
  actually depends on - see below.
- The pipeline makes exactly **one** call per missing hero, so the frontier
  tier costs about three cents more per campaign than the flash tier. That is
  the correct place to spend.

## Product identity is the real technical requirement

For a CPG campaign, the hard part is not making a beautiful image. It is making
a beautiful image **of the actual product**, with the actual packaging.

Pure text-to-image cannot do this - it invents a plausible jar. So when a
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
would wire on an entitled account - it is exactly the "product exists,
background does not" operation this pipeline needs.

## Reproducibility

Everything downstream of the hero is deterministic: the same hero and brief
produce byte-identical creatives, and a test asserts it. The generation itself
is the one non-repeatable step.

Adobe documents **seed-based reproducibility on the v3 generation API** - `"seeds": [n]` in, `result.outputs[].seed` back, with the same seed, prompt and
presets reproducing the image. Image 5 uses a breaking **v4** schema, and seed
support there was **not verified in this proof-of-concept**, so this
implementation does not claim it and does not send the field.

Gemini's image API documents no seed, temperature or determinism control at
all, so that gap cannot be closed on the provider this repo actually runs.

Recording it honestly: reproducible generation is a real enterprise
requirement, Adobe has documented a mechanism for it, and verifying that
mechanism on Image 5 needs an entitled account this project does not have.

## Models deliberately not integrated

FLUX, Ideogram, Midjourney, Runway, Kling, Veo, Seedance - all credible, none
integrated. Adding direct adapters would mean more keys for an evaluator, more
surface to defend, and no new capability the assignment asks for. The
`HeroGenerator` interface is thirty lines; any of them is a one-file addition
when a customer's governance actually calls for it.

---

## The model we run is the model that was recommended

An advisor reviewing this project said the output "doesn't feel like the latest
nano banana hotness". Worth checking rather than assuming, because it turns out
to be the same model:

> "Nano Banana Pro, or Gemini 3 Pro Image, is our most advanced image generation
> and editing model."
>
> [Google, Nano Banana Pro announcement](https://blog.google/technology/ai/nano-banana-pro/)

`gemini-3-pro-image` **is** Nano Banana Pro. The pipeline was already running
the recommendation. The output was generic for a different reason, and it was
ours: the camera instruction sat eighth in a four-hundred-word brief that also
dictated optics, light, set, materials and composition, so it competed with a
dozen constraints and lost. Restructuring the prompt fixed it; changing the
model would not have.

That is the general lesson and it is worth saying out loud in a model-strategy
document: **before switching models, check whether the prompt is the variable.**
Most of the quality complaints this project has had were prompt-shaped.

---

## The cost ladder

Iterating on art direction is the expensive habit, not shipping. So the price of
looking is separated from the price of delivering.

| What you want to know | How | Cost |
|---|---|---|
| Layout, copy fit, safe zone, every validation check | offline renderer, no key needed | **$0** |
| What my brief changed vs what it inherited | `--dry-run --prompts` slot diff | **$0** |
| The same thing again | preview and dev cache the hero | **$0** |
| Is this the right art direction | `--preview`, or the console's Preview tier - 1K on the cheapest model | **$0.0336 per hero** |
| The whole campaign, roughly | `--preview` - 24 creatives, cost is per generation | **$0.067** |
| The deliverable | `gemini-3-pro-image` at 2K | **$0.134** |

2K is not optional for what ships. Every format is a centre crop of one square
hero and 9:16 needs 1080x1920 out of it, so a 1K source is upscaled about 1.9x
and goes soft. Preview mode does not pretend otherwise: the report says
`preview` and `assignmentProof` fails on it, exactly as it does for the offline
renderer.

### Cheaper tiers that exist, and why they are not the default

Verified 2026-08-29, from each vendor's own page:

| Option | Price | Licence of the weights | Verified at |
|---|---|---|---|
| FLUX.1-schnell, self-hosted | **$0** after download | Apache-2.0, commercial use permitted | [model card](https://huggingface.co/black-forest-labs/FLUX.1-schnell) |
| FLUX.1-schnell via fal.ai | **$0.003 / megapixel** | same | [fal.ai model page](https://fal.ai/models/fal-ai/flux-1/schnell) |
| `gemini-3.1-flash-lite-image` | $0.0336 | hosted API | ai.google.dev pricing |
| `gemini-3-pro-image` | $0.134 | hosted API | ai.google.dev pricing |

FLUX.1-schnell is 12B parameters and reaches a usable image in 1 to 4 steps,
which is what makes it cheap to host and fast to run locally on Apple Silicon.

**It is the right tool for previews and the wrong tool for what ships**, and the
reason is legal rather than technical.

### Why no fourth adapter was built

The preview tier has one hard requirement that price alone does not settle: it
has to show the *whole shot*, product included, or it is not previewing the
thing that ships. Products with an approved packshot hand that file to the model
as an identity anchor, so the preview model must accept an image reference.

FLUX.1-schnell is text-to-image. It cannot take the packshot, so its preview
would show a plausible jar rather than *this* jar, which is the one question a
preview exists to answer. `gemini-3.1-flash-lite-image` runs the same
Interactions API with the same `input` parts array as production, so the
reference path is the code that already ships.

Verified 2026-08-29 by generating one hero from `samples/campaign.yaml` against
`overnight-recovery-cream`, which has a packshot. The 1K preview came back with
the same frosted glass jar and the same green lacquered lid, closed and
unlabelled, composited into the `daylight` set. One generation, $0.0336.

So fal.ai and self-hosted FLUX stay in the table above as a **production
extension with verified prices**, not as a shipped adapter. Adding one would
double the repo's headline weakness, which is code paths that have never
executed.

---

## The prompt is the lever, not the model

Measured 2026-08-29, two findings that cost 13 cents to establish.

**The workhorse tier is indistinguishable at 2K.** `gemini-3.1-flash-image`
generated the same hero from the same packshot and the same prompt in **18.5s
for $0.101**, against 24.5s and $0.134 on the frontier tier: 25% cheaper and
25% faster, at 2048x2048, with product identity, the closed unlabelled
container and the locked composition all intact. One sample is not a quality
programme, so it is not the default, but it is a lever that is ready and the
evidence is in `docs/images/hero-pro-2k.png` and `hero-flash-2k.png`.

**The bigger lever was the prompt.** Google's own prompting guide lists the
essential elements of an image prompt as subject, composition, **action**,
location and style
([Google Cloud, ultimate prompting guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana),
verified 2026-08-29). This prompt had every one of them except action, and it
showed: every hero was a correctly lit object sitting still. Adding a `moment`
slot, on the CHEAPEST 1K model, produced a hard diagonal light shaft with dust
in the beam and, for the first time, **autumn foliage on a campaign called
Autumn Glow**. The objective had been in the prompt all along; nothing was
looking for a moment to put it in.

That is the ordering worth remembering: the model was never the constraint.

## Why the cheap model cannot be the shipping model

The client in this exercise is a global consumer goods company. What a brand's
legal team asks about generated imagery is not "how good is it" but "what
happens if someone claims it infringes".

- Adobe states Firefly's models are **trained on licensed content such as Adobe
  Stock, plus openly licensed and public domain content**, and that enterprise
  customers may purchase an entitlement carrying **contractual IP
  indemnification** for Firefly outputs.
  ([Adobe Firefly FAQ](https://helpx.adobe.com/firefly/web/get-started/learn-the-basics/adobe-firefly-faq.html),
  [Firefly Legal FAQs for Enterprise Customers](https://www.adobe.com/content/dam/dx/us/en/products/sensei/sensei-genai/firefly-enterprise/Firefly_Legal_FAQs_Enterprise_Customers.pdf))
- FLUX.1-schnell's **Apache-2.0 licence covers the weights**. It is not a
  statement about training data provenance and it is not an indemnity.

Those are different things, and conflating them is how a brand ends up exposed.
So the tiering is by **exposure**, not only by price:

- **Preview** is internal, never published, and discarded. An unindemnified
  model is fine here, and this is where the 4x to 40x saving lives.
- **Shipped brand assets** should come from a model whose provider will stand
  behind the output. That is the Firefly argument in one sentence, and it is why
  Firefly is the production target in this repo even though it has never run.

This also answers the "why not just use the cheapest thing" question honestly:
for previews we should, and the ladder above now does.

---

## Tiering is the architecture, not an optimisation

A broader platform sketch for this workflow lists **"Tiered Models / via
OpenRouter - Low Level: Qwen / Basic Convo, Mid Level: Kimi 2.5 or higher"**,
with **Firefly API as the default** for both images and video and Nano Banana,
GPT and Ideogram as alternates.

That is the same shape as the ladder above, arrived at independently: route by
what the job actually needs. The `HeroGenerator` interface is what makes it a
one-file change here - a preview provider is another adapter, not a redesign.
