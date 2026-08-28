# Creative production standards this pipeline enforces

Every rule below came from a primary source, was checked on the date shown, and
is enforced somewhere in the code rather than left as advice. Where a source
contradicted an assumption I had already built, the source won and the code
changed — the two cases where that happened are marked **corrected**.

---

## 1. Brief structure — the 4A's core

The American Association of Advertising Agencies has published briefing
standards since the 1980s, and every revision reduces to the same five
questions: **who · what · why · where · success**.

Mapped onto `CampaignBriefSchema`:

| 4A's | Field | Required |
|---|---|---|
| WHO | `audience` | yes |
| WHAT | `message` — the single-minded proposition | yes |
| WHY | `objective` | optional |
| WHERE | `region`, plus the three channel formats | yes |
| SUCCESS | `manualMinutesPerCreative` → time-saved figure in `report.json` | optional |

**Corrected.** The first version of the schema had who / what / where only. Why
and success were missing, and so was `callToAction` — which every real social
ad carries and which is now rendered into every creative and validated by
`creative.callToAction`.

The optional fields stay optional so a minimal brief remains minimal, but the
sample brief in `samples/campaign.yaml` is annotated with the 4A's mapping so
the structure is legible to a marketer, not just an engineer.

---

## 2. The 9:16 safe zone — Meta, verified 2026-08-28

> "Leave roughly **14% of the top, 35% of the bottom, and 6% on each side** of
> your asset free from text, logos, or other key creative elements to avoid
> cropping key elements or covering them with the profile icon or
> call-to-action."
>
> — Meta Ads Guide, Instagram Stories & Reels image ad specs. Stories and Reels
> share these values.

For 1080 × 1920 that is:

| Edge | Reserved | Usable band |
|---|---|---|
| Top | 269 px | y ≥ 269 |
| Bottom | 672 px | y ≤ 1248 |
| Sides | 65 px | 65 ≤ x ≤ 1015 |

**Corrected — this was a real defect.** My original 9:16 template put the hero
on top and a brand copy panel underneath, with the headline at y ≈ 1330–1622,
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
  right: 1015 }` and proves the worst-case headline — maximum lines at maximum
  font size — still fits.

1:1 and 16:9 feed placements have no equivalent overlay reservation, so
`enforceSafeZone` is false for those templates.

---

## 3. Contrast — WCAG 2.2 AA

AA requires **4.5:1** for normal text but only **3:1** for large text
(≥ 18.66 px bold, or ≥ 24 px regular).

**Corrected.** The validator originally held every string to 4.5:1. Campaign
headlines render between 36 px and 88 px — far into the large-text band — so
that threshold would have reported failures the standard does not require.
`brand.contrast` now selects the threshold from the rendered font size and
names which one it applied in the check message.

---

## 4. Model selection — quality where it is visible

Per-image output pricing, ai.google.dev/gemini-api/docs/pricing, verified
2026-08-28:

| Model | 2K image | Role |
|---|---|---|
| `gemini-3-pro-image` | **$0.134** | frontier — the default here |
| `gemini-3.1-flash-image` | $0.101 | workhorse |
| `gemini-3.1-flash-lite-image` | $0.0336 (1K only) | cheapest |
| `gemini-2.5-flash-image` | $0.039 | legacy |

Because the pipeline makes exactly **one** generation call per missing hero,
the frontier model costs about three cents more per campaign than the flash
tier — and that single image is the one thing a reviewer actually looks at.

That is the whole cost strategy: spend at the point of visible quality, and
save everywhere the work is deterministic.

| Approach | Calls per 2-product campaign | Cost |
|---|---|---|
| Generate per product per ratio | 6 | $0.80 |
| Generate one hero per product | 2 | $0.27 |
| **This pipeline** (one product already approved) | **1** | **$0.134** |

The saving compounds with reuse: the more of a catalogue a brand has already
approved, the fewer calls a campaign needs. Generating per ratio would also
have produced three visibly different products in one campaign — a brand
consistency failure, not just a budget one.

---

## 5. Aspect ratios

1:1 (1080²), 9:16 (1080 × 1920) and 16:9 (1920 × 1080), as the assessment FAQ
specifies: "Standard social media formats (e.g., Instagram 1:1, Stories 9:16,
Facebook 16:9) are recommended."

Meta's Stories page lists 1440 × 2560 as its recommended 9:16 resolution. The
pipeline exports 1080 × 1920 because that is what the assignment names; the
templates derive every position from the canvas size, so raising the export
resolution is a change to the `RATIOS` constant alone.
