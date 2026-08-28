# Creative Automation Pipeline

[![CI](https://github.com/JT5D/creative-automation-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/JT5D/creative-automation-pipeline/actions/workflows/ci.yml)

Turns one campaign brief into ready-to-ship social creatives across every
channel format and market - reusing brand-approved assets wherever they exist,
and calling a GenAI image model only for what is genuinely missing.

**The exercise asks for 2 products across at least 1:1, 9:16 and 16:9. That is
what the console runs by default: 6 finished creatives, one hero reused, one
generated, one live generation.** Select every format and market and that same
single generation produces **24 creatives in 39.3s for $0.134** - because a
model is called once per missing hero, not once per output.

Every number on this page comes from the run committed in
[`docs/sample-output/report.json`](docs/sample-output/report.json).

![Pipeline console](docs/images/ui-run.png)

```
Campaign brief (YAML/JSON)
   └─ validate + preflight ...................... free, before any spend
       └─ per product: resolve the hero
           ├─ approved asset on disk? .......... REUSE it, spend nothing
           └─ missing? ......................... GENERATE it with GenAI
               └─ CanonicalHeroAsset ........... origin no longer matters
                   └─ formats × markets ........ deterministic composition
                       └─ brand + legal checks
                           └─ PNG files + report.json
```

A working proof-of-concept: it runs locally, calls a real image model, writes
real files. It is not a deployed system - storage is local, there is no queue,
and [Production extension](#production-extension) names what a customer's stack
would replace.

---

## How to run it

Requires Node.js 20+.

```bash
npm install
cp .env.example .env      # add one API key, see below
npm run dev               # → http://localhost:5173
```

A Google AI Studio key **with billing enabled**: <https://aistudio.google.com/apikey>

```env
GEMINI_API_KEY=your-key-here
```

Every Gemini image model lists its free tier as "Not available"
([pricing](https://ai.google.dev/gemini-api/docs/pricing), verified
2026-08-28), so a free-tier key returns `HTTP 429 … limit: 0`. Verify before
demoing - this checks the key *and* that the model id exists, against the live
model list:

```bash
npm run doctor
```

**With no key at all it still runs**, rendering a labelled offline preview.
That preview deliberately cannot satisfy the "generate missing assets with a
GenAI image model" requirement, and `report.json` reports
`assignmentProof.passed = false` because of it.

<details>
<summary>Adobe Firefly Services instead (optional)</summary>

```env
FIREFLY_SERVICES_CLIENT_ID=...
FIREFLY_SERVICES_CLIENT_SECRET=...
IMAGE_PROVIDER=firefly
```

Nothing is auto-selected when both providers are configured - see
[Provider strategy](#provider-strategy-and-an-honest-limitation).
</details>

```bash
npm run dev                                            # console + API
npm run campaign -- samples/campaign.yaml              # same pipeline, CLI
npm run campaign -- samples/campaign.yaml --dry-run    # what it costs, spending nothing
npm run portfolio                                      # every brief in samples/, one command
npm run check                                          # the release gate
```

---

## Example input and output

The brief is the single input. JSON and YAML normalize to the same validated
object.

```yaml
id: lumen-autumn-glow-de
region: Germany (DACH)                    # WHERE
audience: Urban professionals 28-45       # WHO
message: Wake up to visibly brighter skin # WHAT
callToAction: Jetzt entdecken

markets:                                  # optional; localized copy is data,
  - locale: en-GB                         # never a runtime model call
    message: Wake up to visibly brighter skin
    callToAction: Discover now
    disclaimer: Individual results may vary. Dermatologist tested.

brand:
  name: Lumen Botanicals
  logoPath: samples/assets/lumen-logo.png
  primaryColor: "#14322B"
  secondaryColor: "#C9A227"
  prohibitedWords: [cure, miracle, clinically proven]

products:
  - id: radiance-serum                    # approved hero exists → REUSE
    name: Radiance Vitamin C Serum
    approvedHeroPath: samples/assets/radiance-serum-hero.png

  - id: overnight-recovery-cream          # no approved hero → GENERATE,
    name: Overnight Recovery Cream        # anchored on the real packshot
    referenceAssetPath: samples/assets/overnight-cream-packshot.png
```

Outputs are organized by product and aspect ratio, exactly as the brief asks:

```
outputs/lumen-autumn-glow-de/
├── radiance-serum/
│   ├── source/approved-hero.png        ← the asset that was reused
│   ├── 1x1/en-gb.png  de-de.png  fr-fr.png
│   ├── 4x5/…   9x16/…   16x9/…
├── overnight-recovery-cream/
│   ├── source/generated-hero.png       ← the asset the model produced
│   └── …
└── report.json
```

Four sample briefs ship with the repo and the console loads any of them in a
click: the canonical run, the same brief in JSON, a cold start for a different
brand with no approved assets at all, and one carrying a prohibited claim that
is stopped at preflight before a credit is spent.

Committed evidence without running anything:
[`docs/sample-output/`](docs/sample-output/) - the report, the file tree, and
four representative creatives.

---

## Key design decisions

### 1. Asset origin is a boundary concern

A reused approved asset and a freshly generated one normalize into one type:

```ts
type CanonicalHeroAsset = {
  productId: string;
  source: "reused" | "generated" | "generated_cached" | "placeholder";
  localPath: string; width: number; height: number;
  generation?: { provider; operation; model; prompt; durationMs; requestId };
};
```

Past that line nothing knows or cares where the image came from. Composition,
validation, export and reporting are deterministic and source-agnostic - which
is what makes the provider swappable and the pipeline testable without a
network.

### 2. Reuse beats regenerate

Regenerating an asset a brand has already approved is worse on every axis: it
costs money, takes seconds instead of milliseconds, is non-deterministic, and
discards a human approval that carries legal weight. The branch is a real
`fs.access()` - delete `samples/assets/radiance-serum-hero.png` and the same
brief takes the generation path on the next run.

`findApprovedHero()` is deliberately tiny. It is the seam a customer's DAM, AEM
or S3 bucket replaces, and its entire contract is "a local path, or nothing."

### 3. One canonical hero, then transform

Generating per aspect ratio would multiply cost and - far worse - produce four
*different* products in one campaign: different bottle, different lighting,
different scene. That is a brand failure, not a budget one.

So a model is called **once per missing hero** at 2K square, and every channel
format is cut from that one asset locally with Sharp. Adding a format or a
market costs **zero additional GenAI generation**, and a test asserts it: the
variant count derives from the `RATIOS` constant while `liveHeroGenerations`
stays at 1.

### 4. Each ratio is a template, not a resize

| Format | Placement | Art direction |
|---|---|---|
| **1:1** 1080×1080 | Feed | Full-bleed hero, scrim and copy in the top band, lockup top-left |
| **4:5** 1080×1350 | Portrait feed | Same treatment, taller canvas |
| **9:16** 1080×1920 | Story / Reel | Same again, copy inside Meta's published safe zone |
| **16:9** 1920×1080 | Landscape | Hero right, brand copy panel left |

Copy sits in the **top band on every full-bleed format**, forced by geometry
rather than chosen. One hero serves all of them, so either the copy zone agrees
across formats or the product shrinks until it misses the copy everywhere - and
it used to shrink. Meta reserves the bottom 35% of a 9:16 placement, leaving the
top as the only band all three can share. The hero prompt reserves that upper
half as quiet background, and sizes the product from the crop that actually
binds: 9:16 keeps 9/16 = 56% of the width. Full derivation in
[`docs/CREATIVE_STANDARDS.md`](docs/CREATIVE_STANDARDS.md) §7.

### 5. Typography is bundled, and measured

Rubik and Cormorant Garamond ship in `assets/fonts/` under the SIL Open Font
License. The creatives therefore render identically on any machine instead of
whatever an evaluator's fontconfig falls back to - and because the files are
present, line breaking reads **real glyph advance widths** rather than
estimating them. That replaced a width table tuned by eye, which was wrong often
enough that a CTA pill clipped its own label.

The console is set in Rubik and the advertisement's headline in Cormorant: the
tool and the ad are different products and should not share a voice.

### 6. Translation is data, not a runtime model call

No text LLM runs at any point. Localized copy is supplied per market in the
brief, because a localized claim on a regulated cosmetic carries legal weight
and needs human sign-off. Markets multiply output at zero additional generation.

### 7. Checks that can actually fail

A validation rule earns its place only if it can go red on real input. Four
checks in this repo could not, and each was fixed only after the defect was
demonstrated:

| Was | Became |
|---|---|
| `ctaRendered = Boolean(callToAction)` | opaque-pixel count of the CTA layer |
| `disclaimerRendered = Boolean(disclaimer)` | opaque-pixel count of its own layer |
| `logoRendered = Boolean(logoBuffer)` | ink measured - a transparent PNG loaded fine and reported "composited" |
| truncated headline = *warning* | **fail** - a cut-off campaign message is not the campaign message |

All four were the same shape: a label broader than its measurement. Each fix
ships with a test verified to fail against the old code.

---

## Brand and legal checks

**Preflight**, before any spend: ≥2 products · required campaign fields ·
prohibited-claim scan across all copy and all markets · logo file resolves ·
declared asset paths resolve · brand colours are valid hex · a named headline
typeface is actually bundled.

**Per rendered creative**: exact output dimensions · the full campaign message
fits and is rasterized · text/background contrast vs WCAG 2.2 AA where a named
background exists · Meta 9:16 safe zone · no prohibited term in the copy that
reached the pixels.

Four elements are measured, not assumed: the headline, CTA, disclaimer and logo
are each rasterized **alone** and their opaque pixels counted. A combined layer
cannot make that distinction - a creative drawing only its CTA would satisfy a
check whose name asserts the message is present.

Prohibited terms match on word boundaries, so `cure` does not trip on `secure`.

**What this is not.** These are the useful subset of brand rules for automated
production, not brand governance. Production brand validation is Adobe Brand
Intelligence; this repo does not claim to replace it.

---

## Success metrics

The FAQ names three. All three are counted off the run in
`report.json → successMetrics`:

- **Time saved** - derived from the `manualMinutesPerCreative` baseline the
  brief supplies, and labelled an illustrative estimate everywhere it appears.
  It is not a measurement.
- **Campaigns generated** - creatives, products and markets actually produced.
- **Overall efficiency** - creatives per live generation, cost per creative,
  and reuse rate.

Cost is estimated from published list price for the model used, not a billed
amount. `liveHeroGenerations` counts heroes successfully generated, not
underlying HTTP attempts.

---

## Cost, before and after you spend it

`--dry-run` resolves exactly the way a real run does - the same
`findApprovedHero` against the same filesystem - then stops. Nothing is
generated and no provider is constructed, so the reuse/generate split it reports
is the split that will happen. The console has the same thing behind
**Estimate**.

- One generation per **missing** hero - never per ratio, never per format.
- Preflight completes before any generation, so a bad brief fails free.
- `numVariations: 1`; no aesthetic candidate fan-out.
- `MVP_MODE=dev` (default) caches a successful hero, so iterating on layout
  costs nothing. Cached heroes are labelled **Generated earlier · review**
  everywhere, and a cache hit is never counted as a live generation.
- `MVP_MODE=final` bypasses the cache for a clean evidence run.

---

## Provider strategy, and an honest limitation

**Gemini 3 Pro Image runs here. Adobe Firefly Image Model 5 is the right
production choice, the adapter is written, and it has never been executed** - Firefly Services needs an enterprise entitlement and the FAQ states no keys are
provided. It is never selected implicitly: with both configured,
`IMAGE_PROVIDER` is required, because an adapter nobody has run must not win by
accident.

Why this model rather than whichever tops the leaderboard, what Adobe does and
does not indemnify, and the models deliberately left out:
[`docs/MODEL_STRATEGY.md`](docs/MODEL_STRATEGY.md). Wire contracts, including
the one field in the Firefly request that cannot be cited from an Adobe example:
[`docs/API_NOTES.md`](docs/API_NOTES.md).

---

## What this solves, and what it honestly does not

A global consumer-goods team launches hundreds of localized campaigns a month.
Ideation is cheap. The expense sits in producing the same message across every
product and format, repeatedly, on brand, without breaking each market's legal
rules. Most of that work is mechanical. This automates the mechanical part
and spends model budget only where a human genuinely needs something new.

Generated work is never presented as approved. Every product a model touched is
badged **Review generated hero**, and sign-off is a person's job - this is
designed for creative operations with explicit human review, not to replace the
director.

| Business goal | Where it is answered | Honest status |
|---|---|---|
| 1 · Campaign velocity | One brief → 24 validated creatives in 39.3s | **Delivered** |
| 2 · Brand consistency | Deterministic templates, approved-asset reuse, logo/colour/typography/safe-zone/disclaimer checks applied identically every run | **POC evidence.** Enterprise brand governance is Adobe Brand Intelligence |
| 3 · Relevance & personalization | Per-market message, CTA and disclaimer rasterized into each export at zero extra generation | **Partial.** Copy is localized; offers, art direction and cultural imagery are not adapted |
| 4 · Marketing ROI | Runtime, estimated generation cost, reuse rate, creatives per generation | **Cost side only.** CTR, CPA and conversion are post-publication; this never publishes, so none is invented |
| 5 · Actionable insights | `report.json` provenance and per-check results; `runs.jsonl` reuse and spend across runs | **Production telemetry.** Campaign-performance insight belongs after activation - GenStudio for Performance Marketing |

| Pain point | What this does about it |
|---|---|
| 1 · Manual production overload | One brief → 24 finished creatives, 1.41s each |
| 2 · Inconsistent quality | Brand rules are code, not a style guide someone remembers |
| 3 · Approval bottlenecks | Prohibited claims stop the run before production; a human only reviews what a model touched |
| 4 · Analysis at scale | Every run writes provenance and per-check results as data |
| 5 · Resource drain | Approved assets reuse automatically; the model is called only for the gap |

**The three data sources the brief names**

| Data source | Here |
|---|---|
| User inputs - briefs and assets uploaded manually | Briefs are `samples/*.yaml` / `*.json`, editable in the console behind **Edit source**. Assets live in `samples/assets/` - dropped in by hand, or supplied through the inspector on any product a model generated, which writes the file and adds `approvedHeroPath` to the brief. Either route is the same mechanism, and it is the one the pipeline turns on |
| Storage - *"can be Azure, AWS or Dropbox"* | Local filesystem behind `findApprovedHero()`. That one function is the seam; Firefly's own v4 API accepts output storage on exactly those domains, so the production swap is a storage target, not a redesign |
| GenAI - best-fit APIs for hero images and variations | `HeroGenerator` → Gemini 3 Pro Image (runs) or Firefly Image Model 5 (written, not entitled). Resized and localized variations are produced **deterministically**, not by a model |

---

## Assumptions

- Input assets are local files; the resolver exists so a DAM/AEM/S3 adapter can
  replace it.
- One campaign message per brief, with optional pre-translated copy supplied by
  the marketer.
- Brand identity is colour + logo + typeface + disclaimer + prohibited terms - the useful subset for automated production.
- `Lumen Botanicals` is a fictional brand invented for this exercise, as the FAQ
  permits. `samples/assets/` holds its **input** assets, committed so no
  evaluator needs a key to see the reuse path work. The two product images came
  from `npm run make:samples` calling `gemini-3-pro-image`; the logo is drawn in
  code. They are inputs, **not pipeline outputs**, and nothing presents them as
  results.

## Limitations

- **The hero crop is centred**, which is right because the art direction demands
  a centred product with negative space - but that is a convention the prompt
  enforces, not product detection. An off-centre approved asset would still crop
  badly. Firefly Expand or a product-aware crop is the production answer. This
  previously used Sharp's `attention` saliency heuristic, which sliced the
  product out of the 9:16 frame.
- **Text is laid out by hand** - wrapping, auto-fit and glyph metrics in
  `textLayout.ts` and `fonts.ts`. The current best-practice stack is
  [Satori](https://github.com/vercel/satori) feeding Sharp, which is what
  Vercel's OG image generation uses. Not adopted here because auto-fit to a
  legibility floor still has to be written either way, and I wanted line
  breaking to read real advance widths so the failure mode is a flagged creative
  rather than a clipped one. It is the first thing I would change with more time.
- **Contrast is reported only on the brand-panel format**, where the background
  is a colour the brief names. On full-bleed the copy sits on a photograph, so
  legibility is handled earlier - the scrim is sized from the measured luminance
  of the band the copy will occupy - and not re-expressed as a WCAG ratio after.
- **The prohibited-word scan is literal.** It catches the claims a legal team
  enumerates; it is not semantic claim detection.
- **Run state is in memory**, so restarting the server forgets past runs. The
  outputs and `report.json` on disk are the durable artifact.
- **Single machine, no queue.** `npm run portfolio` runs every brief in the
  manifest back to back, which is the honest shape of batch here: a loop over
  the same `runCampaign()`, not a scheduler. Hundreds of campaigns concurrently,
  with retries and prioritization, is the extension path - see
  [Production extension](#production-extension).
- **Gemini image generation has no free tier.** Billing must be linked. `npm run
  doctor` verifies key and model, but cannot detect quota until a generation is
  attempted.

---

## Production extension

```
Customer DAM / AEM / S3
      │   replaces findApprovedHero() - the only filesystem assumption
      ▼
AssetResolver → HeroGenerator          ← replaced by Firefly Services / Composite APIs
      │
      ▼
Firefly Creative Production            ← governed multi-model workflows
Published Workflow API                 ← batch execution at real scale
Photoshop API v2                       ← layered/templated production
      │
      ▼
GenStudio                              ← approval, activation, performance
```

The two seams that matter are already isolated. Everything between the canonical
hero and the exported file stays exactly as it is.

Deliberately out of scope: ingest and format conversion, prompt/copy assistance,
video, scheduled publishing, approval routing and a staging dashboard. The
assignment asks for a creative automation pipeline, not a publishing platform;
building those would have added surface without demonstrating anything it asks
for.

---

## Requirements traceability

| Assignment requirement | Implementation | Evidence |
|---|---|---|
| Campaign brief (JSON/YAML) | `src/schema.ts` - one Zod schema, both formats | test: *accepts YAML and JSON identically* |
| ≥ 2 products | `.min(2)` on the products array | test: *rejects a brief with fewer than two products* |
| Target region / market | `region` (required) | `Germany (DACH)` in report.json |
| Target audience | `audience` (required) | recorded in report.json |
| Campaign message | `message` + per-market copy | rasterized into every output, verified by ink and fit |
| Accept input assets, reuse when available | `findApprovedHero()` | Product A → **Reused**; test asserts `liveHeroGenerations === 1` |
| Generate when missing, with a **real** model | `HeroGenerator` → `src/providers/gemini.ts` | Product B → **Generated**, provenance in report.json |
| Real model, not a stand-in | `MVP_MODE=final` refuses the offline renderer | test: *refuses to fabricate a missing hero in final mode* |
| ≥ 3 aspect ratios | `RATIOS` + `templateFor()` | **4 delivered**, asserted per run by `assignmentProof` |
| Campaign message on final posts | `buildTextLayer()` → Sharp raster | ink **and** fit checked per creative |
| Localization (bonus) | `markets[]` | en-GB · de-DE · fr-FR at zero extra generation |
| Runs locally | Vite console + Express, or CLI | `npm run dev` · `npm run campaign` |
| Outputs organized by product + ratio | `outputs/<campaign>/<product>/<ratio>/<locale>.png` | tree above |
| Brand compliance checks (bonus) | `src/validation.ts` | logo ink, brand colour, contrast, disclaimer, safe zone |
| Legal content checks (bonus) | word-boundary prohibited scan | `samples/campaign-legal-fail.yaml` fails preflight |
| Logging / reporting (bonus) | `src/report.ts` | `report.json`, live event stream, `runs.jsonl` |

`report.json → assignmentProof` answers the exercise's minimum from the run's
own records - nine facts counted off the files on disk, every coverage figure
measured against the products the *brief* asked for rather than the ones that
finished. An offline preview produces real, correctly-sized, validated files
and still reports `false`, because it has not demonstrated the one thing the
exercise needs a model for.

---

## Walkthrough (~2:30)

The assignment asks for a short video that helps a reviewer *set up and run the
app locally*. This is that path, and every timing was measured.

**0:00-0:30 · Setup.** Clone, `npm install`, `cp .env.example .env`, paste one
Google AI Studio key with billing enabled. `npm run doctor` verifies the key and
the model id against the live model list before anything is spent.

**0:30-0:50 · The brief.** `npm run dev`. The console opens on
`samples/campaign.yaml`: two products, region, audience, message, brand rules.
Product A has an approved hero on disk; product B does not. The default
selection is the exercise's minimum - 1:1, 9:16, 16:9 in one market.

**0:50-1:30 · The run.** Press **Run campaign**. Product A resolves to
*Reused* and spends nothing. Product B has no approved hero, so its packshot
goes to the model as an identity anchor and returns *Generated*. One live
generation, driven by a real filesystem check - delete the approved file and the
same brief takes the generate path.

**1:30-2:00 · The output.** Six creatives, each an intentional template rather
than a resize, served straight off disk. Click any one for its provenance and
production checks. Files land in
`outputs/<campaign>/<product>/<ratio>/<locale>.png`.

**2:00-2:30 · Scale, and the guardrail.** Add 4:5 and two more markets: 24
creatives, still one generation, still $0.134. Then pick the *Rejected copy*
brief, which carries a prohibited claim and is stopped at preflight before a
credit is spent.

Running with **no key at all** also works: a labelled offline preview that
reports `assignmentProof.passed = false`, because a preview has not demonstrated
the one thing this exercise needs a model for.

---

## Project layout

```
src/
├── pipeline.ts        parse → preflight → resolve → compose → validate → report
├── schema.ts          the brief contract (Zod), both formats
├── assetResolver.ts   reuse-or-generate, and the deterministic art direction
├── composer.ts        per-format templates, text layout, ink measurement
├── validation.ts      preflight + per-creative checks
├── report.ts          run record, success metrics, assignmentProof
├── providers/         HeroGenerator: gemini · firefly · offline placeholder
├── server.ts          local API the console calls
└── app/               React console
docs/                  standards, model strategy, API contracts, sample output
tests/                 functional + visual regression
```

If you only read one file, read `src/pipeline.ts` - the whole product is legible
in one screen.
