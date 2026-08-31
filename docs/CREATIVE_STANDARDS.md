# Creative production standards this pipeline enforces

Every rule below came from a primary source, was checked on the date shown, and
is enforced somewhere in the code rather than left as advice. Where a source
contradicted an assumption I had already built, the source won and the code
changed - the two cases where that happened are marked **corrected**.

---

## 1. Brief structure

A creative brief has a settled shape, and the fields below are that shape.
The public [AMA creative brief template](https://www.ama.org/toolkits/creative-brief-template/)
specifies audience definition, campaign objectives, tone and messaging
guidance, creative direction, mandatory elements, and distribution including
asset formats. Every one of those has a field here.

**Corrected 2026-08-29.** This section previously attributed the structure to
"the 4A's brief standard, published since the 1980s, every revision reducing to
who / what / why / where / success". Two searches found no public 4A's briefing
standard - their briefing material is member-only - so that attribution could
not be substantiated and has been removed. The five-question grouping below is
this document's own framing, which is useful for reading the schema and is not
a citation.

Mapped onto `CampaignBriefSchema`:

| Question | Field | Required |
|---|---|---|
| WHO | `audience` | yes |
| WHAT | `message` - the single-minded proposition | yes |
| WHY | `objective` | optional |
| WHERE | `region`, plus the four channel formats | yes |
| SUCCESS | `manualMinutesPerCreative` → time-saved figure in `report.json` | optional |

**Corrected.** The first version of the schema had who / what / where only. Why
and success were missing, and so was `callToAction` - which every real social
ad carries and which is now rendered into every creative and validated by
`creative.callToAction`.

The optional fields stay optional so a minimal brief remains minimal, but the
sample brief in `samples/campaign.yaml` is annotated with that mapping so
the structure is legible to a marketer, not just an engineer.

---

## 2. The 9:16 safe zone - **14% top / 35% bottom / 6% sides**

Meta reserves those bands of a 9:16 placement for its own chrome: the profile
icon, username and *Sponsored* label at the top; the like/comment/share/save
stack, caption, audio label and call-to-action at the bottom. Since Meta
unified Facebook and Instagram Stories and Reels onto one 9:16 safe zone, the
same box applies to all four placements.

**On sourcing, precisely.** An earlier version of this document said the primary
source was login-gated and refused to quote it. That was wrong. Meta publishes
the figures on its open Ads Guide page for the Instagram Reels image placement
(`facebook.com/business/ads-guide/update/image/instagram-reels`), verified
2026-08-30, and the wording is:

> "Consider leaving roughly 14% of the top, 35% of the bottom, and 6% on each
> side of your asset free from text, logos, or other key creative elements to
> avoid cropping key elements or covering them with the profile icon or
> call-to-action."

Two things follow from the exact wording, and both matter to this pipeline.
The rule governs **text, logos and other key creative elements**, not the
photograph, which is why the hero is full-bleed and only the copy is
constrained. And it says **roughly**, so these are the platform's own stated
margins used as a conservative box, not a threshold anyone should treat as
exact.

For 1080 × 1920 that is:

| Edge | Reserved | Usable band |
|---|---|---|
| Top | 269 px | y ≥ 269 |
| Bottom | 672 px | y ≤ 1248 |
| Sides | 65 px | 65 ≤ x ≤ 1015 |

**Corrected - this was a real defect.** My original 9:16 template put the hero
on top and a brand copy panel underneath, with the headline at y ≈ 1330-1622,
the CTA at 1700 and the disclaimer at 1874. All of it sat inside the bottom 35%
that Meta reserves for its own profile icon and CTA overlay. In a live feed the
entire message would have been covered.

The rebuilt template:

- The hero is **full-bleed**. The restriction is on text and logos, not on the
  photograph, so cropping the image to dodge the safe zone would have been the
  wrong fix.
- All copy, the lockup and the CTA sit inside the safe band, over a scrim
  weighted to the top of the frame where that copy lives.
- `safeBoundsFor()` in `src/composer.ts` derives the bounds from the published
  percentages rather than hardcoded pixels, so the same function is correct for
  any 9:16 canvas size.
- `channel.safeZone` in `src/validation.ts` measures where the text actually
  landed and **fails** the creative if it strays outside.
- A test pins the derived bounds to `{ top: 269, bottom: 1248, left: 65,
  right: 1015 }` and proves the worst-case headline - maximum lines at maximum
  font size - still fits.

1:1 and 16:9 feed placements have no equivalent overlay reservation, so
`enforceSafeZone` is false for those templates.

---

## 3. Contrast - WCAG 2.2 AA

AA requires **4.5:1** for normal text but only **3:1** for large text
(≥ 18.66 px bold, or ≥ 24 px regular).

**Corrected.** The validator originally held every string to 4.5:1. Campaign
headlines render between 36 px and 88 px - far into the large-text band - so
that threshold would have reported failures the standard does not require.
`brand.contrast` now selects the threshold from the rendered font size and
names which one it applied in the check message.

---

## 4. Model selection - quality where it is visible

Per-image output pricing, ai.google.dev/gemini-api/docs/pricing, verified
2026-08-28:

| Model | 2K image | Role |
|---|---|---|
| `gemini-3-pro-image` | **$0.134** | frontier - the default here |
| `gemini-3.1-flash-image` | $0.101 | workhorse |
| `gemini-3.1-flash-lite-image` | $0.0336 (1K only) | cheapest |
| `gemini-2.5-flash-image` | $0.039 | legacy |

Because the pipeline makes exactly **one** generation call per missing hero,
the frontier model costs about three cents more per campaign than the flash
tier - and that single image is the one thing a reviewer actually looks at.

That is the whole cost strategy: spend at the point of visible quality, and
save everywhere the work is deterministic.

| Approach | Calls per 2-product campaign | Cost |
|---|---|---|
| Generate per product per ratio | 6 | $0.80 |
| Generate one hero per product | 2 | $0.27 |
| **This pipeline** (one product already approved) | **1** | **$0.134** |

The saving compounds with reuse: the more of a catalogue a brand has already
approved, the fewer calls a campaign needs. Generating per ratio would also
have produced three visibly different products in one campaign - a brand
consistency failure, not just a budget one.

---

## 5. Cache integrity - a bug this project shipped and then fixed

The generation cache was keyed on `(productId, prompt, referenceAsset)` and
written to a single project-level `.cache/`. Two consequences, both caught by
looking at an output rather than a report:

1. The **test suite wrote into the same cache**. Its stand-in renders landed in
   the project cache, where a later real run picked one up and served it.
2. The key **did not include the provider or model**, so an entry produced by
   one generator could be returned for another.

The result was a creative rendered from an offline placeholder while
`report.json` named `gemini-3-pro-image` as the provider. The per-hero
provenance record was still truthful - it said `test-api` - but the headline
provider field was not, and the image was fake. That is precisely the failure
mode the no-theatre rule exists to prevent, and it survived 41 passing tests.

Three fixes, each with a regression test:

- the cache key now includes provider and model;
- the cache lives under the run's output root, so a test run and a real run can
  never share one;
- a cached placeholder stays `source: "placeholder"` and is never promoted to
  `generated_cached`.

The lesson worth carrying: **a passing test suite is not evidence that the
output is real.** The bug was only visible by opening the PNG.

## 6. Aspect ratios

1:1 (1080²), 9:16 (1080 × 1920) and 16:9 (1920 × 1080), as the assessment FAQ
specifies: "Standard social media formats (e.g., Instagram 1:1, Stories 9:16,
Facebook 16:9) are recommended."

Meta's Stories page lists 1440 × 2560 as its recommended 9:16 resolution. The
pipeline exports 1080 × 1920 because that is what the assignment names; the
templates derive every position from the canvas size, so raising the export
resolution is a change to the `RATIOS` constant alone.

## 7. One hero, four formats - the constraint that decides composition

Every format is a centre crop of a single square hero. That is what makes the
economics work - one generation, not one per output - and it is also the
tightest constraint in the system, because the product cannot move between
formats.

**How much of the hero survives.** 9:16 is the narrowest crop: it keeps
9/16 = **56%** of the width. 16:9 keeps the same fraction of the height. So the
product has to sit inside a centred square of 56%, and nothing is gained by
making it any smaller than that. The prompt targets the central 50%, which
leaves a margin without wasting the frame.

This is worth stating because getting it wrong is not obvious in either
direction. An early version let the product fill the square, and the 9:16 crop
sliced it in half. The correction said "SMALL and distant", "only the central
third", and "most of this picture is background" - three phrases pushing the
same way, aiming at 33% when the safe area was 56%. Nothing was sliced any
more, and every hero looked photographed from across the room.

**Where the copy goes, and why it is not a style choice.** Because one hero
serves every format, either the copy zone agrees across formats or the product
shrinks until it misses the copy everywhere. Meta reserves the bottom 35% of a
9:16 placement, so the bottom band is unavailable there. The top is the only
band all three full-bleed formats can share:

| Format | Copy band | Scrim |
|---|---|---|
| 1:1 | top | top |
| 4:5 | top | top |
| 9:16 | top, inside the safe zone | top |
| 16:9 | beside the photograph, on the brand panel | none |

The hero prompt therefore reserves the upper half as quiet background - no
product, no props, only surface and light - because that is where the headline
is composited. The art direction and the layout have to know about each other;
when they did not, a correctly-sized product and the headline occupied the
same pixels.

16:9 is exempt because it is a panel layout: the copy sits beside the
photograph rather than over it, so the hero is free to fill its own region.

---

## 8. Reference fidelity - what "preserve the product" does and does not mean

When a product has no approved hero but does have a packshot, the packshot goes
to the model as an identity anchor. The prompt used to demand the product be
preserved "EXACTLY as it appears in the reference: its geometry, proportions,
cap, closure, surface finish, colours". Two of those words were wrong.

**Colour.** The campaign is lit with a hard, directional key and graded into
shadow; the packshot is lit flat on a white sweep. The same lid cannot read the
same way under both, and the art direction is what makes it not. Measured on
the run committed in [`docs/sample-output/`](sample-output/), comparing the mean
CIELAB of the deep-green lid pixels in the packshot against the same pixels in
the generated hero:

| | dE76 |
|---|---|
| Total | **11.6** |
| Lightness (L\*) alone | 8.1 |
| Hue and chroma (a\*b\*) | 8.4 |

Method: sample both images at 512px, take pixels where the green channel
dominates by more than 12 levels and lightness is under 120, mean them, convert
to CIELAB, take the Euclidean distance. It is a lid-region estimate, not a
spectrophotometer reading, and it is stated that way.

That is a visible difference. It is also an inevitable one, and demanding
"exact colour" from a prompt while the same prompt demands dramatic relighting
is an instruction that argues with itself. The prompt now asks for the
product's **hue and colour family** to be preserved and says plainly that
lightness will move. Nothing in the pipeline measures colour fidelity per run,
so nothing in the pipeline claims it.

The production answer is not a better prompt. It is compositing the approved
packshot into a generated scene rather than asking a model to redraw it -
Photoshop API or Firefly Composite - which preserves the asset by construction.

**Typography.** The reference branch also carried "add no new packaging text"
as a sub-clause, and the model ignored it: handed a completely blank jar, it
returned one printed `Lumen Botanicals / Overnight Recovery Cream`. That text
was accurate by luck. An earlier generation of the same instruction produced
`Skin plattored a. Overnigtrent cream` on a regulated cosmetic.

Nothing downstream can read pixels, so neither the prohibited-claim scan nor any
other check would ever have seen it. The rule is now the **last clause in the
prompt, absolute, and identical in both branches**: reproduce the text the
reference carries and originate none; if it carries none, the product stays
unlabelled. That held on the committed run - the jar in every creative is blank.

It is a mitigation, not a guarantee. A model can still draw a letter, and this
pipeline cannot read it back. That is the specific reason every product a model
touched is badged **Review generated hero** and is never presented as approved.
