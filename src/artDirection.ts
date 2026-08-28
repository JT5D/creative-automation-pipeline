import type { CampaignBrief } from "./schema.js";

/**
 * The art direction, as named slots rather than one paragraph.
 *
 * The prompt used to be a flat 400-word string with three escape hatches bolted
 * on at three different grains: `styleBar` replaced the whole quality standard,
 * `artDirection` replaced the set and nothing else, and `generationPrompt`
 * replaced everything. None of them was the grain an art director works at, and
 * the middle one caused a real defect - the fragrance brief asked for "a single
 * low raking light and soft falloff into black" and the pipeline silently
 * prepended "soft natural window daylight, warm, with open bounce fill". Two
 * contradictory lighting instructions in one prompt, and the model split the
 * difference. That is what "generic" looks like from the inside.
 *
 * So the prompt is slots with defaults, and a brief may replace any of them by
 * name. Two slots are deliberately NOT overridable, and they are exactly the two
 * that have caused shipped defects:
 *
 *   composition  derived from the crop arithmetic, not from taste. Every format
 *                is a centre crop of one square hero; 9:16 keeps 9/16 of the
 *                width, so the product has to sit inside a centred 56% box.
 *                Override it and the product gets sliced in half.
 *   typography   the absolute no-lettering rule. Override it and a blank jar
 *                comes back printed with invented claims on a regulated
 *                cosmetic. This one already happened.
 */
export type Slot = "standard" | "optics" | "light" | "set" | "grade" | "materials" | "integrity";

export const SLOTS: Slot[] = [
  "standard",
  "optics",
  "light",
  "set",
  "grade",
  "materials",
  "integrity",
];

export type SlotValues = Partial<Record<Slot, string>>;

/**
 * A named look: one word in the brief that sets several slots at once.
 *
 * This is the layer that hides the complexity. A campaign that states nothing
 * gets `daylight`, which is the house style every sample was shot in before
 * looks existed. A campaign with an opinion says one word. A campaign with a
 * specific opinion overrides a slot on top.
 *
 * The three here are not invented: they are the three the sample library
 * already needed. Skincare and coffee wanted warm directional daylight;
 * fragrance wanted a dark plinth and falloff to black and had no way to ask for
 * it; the Nordic brief wanted flat cool light on pale wood and was overriding
 * the set to approximate it.
 */
export type LookName = "daylight" | "nocturne" | "nordic";

const CINEMATIC_BAR =
  "Award-winning cinematic advertising photography, editorial quality, shot for " +
  "a global luxury brand campaign. Rich, filmic colour grade with deep tonal " +
  "range. Beautiful shallow depth of field. Dramatic natural light with real " +
  "atmosphere and mood. Hyper-detailed, photorealistic, sharp on the subject. " +
  "Not a flat studio packshot, not a stock catalogue render.";

/**
 * Optics, shared by every look.
 *
 * The product stays critically sharp and the set falls away. An earlier version
 * stacked focus across the WHOLE frame at f/9, which is catalogue lighting:
 * technically clean, flat, and the reason the output read as stock. Depth is
 * what separates an advertisement from a packshot.
 */
const OPTICS =
  "Shot on a 100mm macro lens at f/4, focus stacked across the product itself " +
  "so its label and edges are critically sharp, while the background falls into " +
  "a soft, creamy out-of-focus wash with gentle bokeh. Tripod, no motion blur. " +
  "Shallow, deliberate depth of field.";

/** Material truth, where AI product photography usually fails. */
const MATERIALS =
  "Materials must read as real: frosted glass transmits light correctly with a " +
  "crisp polished rim, and the cap is smooth lacquered metal or resin with a " +
  "clean specular roll-off and a precise machined edge.";

/**
 * The decisive constraint, and load-bearing: asked for an open jar the model
 * renders the cream, and at 2K it comes out curdled.
 */
const INTEGRITY =
  "The container is CLOSED with its cap fully seated, and is opaque: the " +
  "contents are NOT visible. Do not render cream, lotion, product texture or " +
  "any substance inside or on the vessel.";

export const LOOKS: Record<LookName, SlotValues> = {
  daylight: {
    standard: CINEMATIC_BAR,
    optics: OPTICS,
    light:
      "Lit by soft natural window daylight raking in from the upper left, warm " +
      "and directional, with open bounce fill from the right and a narrow rim " +
      "of light separating the product's edge from the background. A faint " +
      "atmospheric haze catches the light. Highlights roll off gently and are " +
      "never blown; shadows are deep but open, with real tonal separation " +
      "between the product and the set. The lighting is felt, not seen: no " +
      "softbox, reflector, light stand, modifier or any studio equipment " +
      "appears in frame.",
    set:
      "on a honed travertine ledge against a seamless plaster wall, with soft " +
      "foliage shadow falling across the background",
    grade:
      "Restrained tonal colour grade, sympathetic to the brand palette without " +
      "tinting the product itself.",
    materials: MATERIALS,
    integrity: INTEGRITY,
  },

  nocturne: {
    standard: CINEMATIC_BAR,
    optics: OPTICS,
    // The whole point of the look: one hard low source and permission for the
    // frame to go black. Saying "shadows are deep but open" here, as the
    // daylight look does, is what was fighting the fragrance brief.
    light:
      "Lit by a single low raking light from one side, hard and directional, " +
      "with no fill on the opposite side so the shadow falls away into near " +
      "black. A narrow specular edge separates the product from the darkness " +
      "behind it. Most of the frame is unlit and is meant to be. The lighting " +
      "is felt, not seen: no softbox, reflector, light stand, modifier or any " +
      "studio equipment appears in frame.",
    set: "on a dark polished stone plinth against a deep shadowed wall",
    grade:
      "Low-key grade with crushed shadows and a narrow highlight range, warm " +
      "only where the light actually falls.",
    materials: MATERIALS,
    integrity: INTEGRITY,
  },

  nordic: {
    standard: CINEMATIC_BAR,
    optics: OPTICS,
    light:
      "Lit by flat, cool north-facing daylight with no direct sun, even across " +
      "the whole frame and almost shadowless, the way an overcast morning lights " +
      "a room. Very low contrast. The lighting is felt, not seen: no softbox, " +
      "reflector, light stand, modifier or any studio equipment appears in frame.",
    set: "on a pale ash wood counter beside a linen cloth, with a soft haze in the air",
    grade: "Cool, desaturated grade with pale neutrals and no warm cast.",
    materials: MATERIALS,
    integrity: INTEGRITY,
  },
};

/**
 * The two LOCKED slots. Neither is reachable from a brief, and both are locked
 * because overriding them has already produced a shipped defect.
 */

/**
 * Derived from the crop arithmetic in composeVariant, not from taste.
 *
 * Every format is a centre crop of one square hero. The narrowest is 9:16,
 * which keeps 9/16 = 56% of the width, so the product has to sit inside a
 * centred square of 56% - and nothing is gained by making it smaller. An
 * earlier version said "SMALL and distant" and "only the central third",
 * aiming at 33% when the safe area is 56%, and every hero came back looking
 * photographed from across the room. A brief that could override this would
 * slice its own product in half on the story format.
 */
export const COMPOSITION =
  "The product sits in the LOWER HALF of the frame, horizontally centred, and " +
  "is large, close and unmistakably the subject -- it fills most of the central " +
  "50% of the width, with its base and lid entirely in frame. The UPPER HALF is " +
  "quiet, empty background: no product, no props, nothing but surface and " +
  "light, because the campaign headline is composited there. Do not crop the " +
  "product and do not place it off to one side.";

/**
 * Last clause of every prompt that can reach a paid generation.
 *
 * A model handed a blank product will letter it whatever else the prompt says.
 * Asked to preserve a completely blank jar it returned one printed "Lumen
 * Botanicals / Overnight Recovery Cream" - accurate by luck - and an earlier
 * run of the same instruction produced "Skin plattored a. Overnigtrent cream"
 * on a regulated cosmetic. Nothing downstream reads pixels, so neither the
 * prohibited-claim scan nor any other check would ever have seen it.
 */
export const TYPOGRAPHY_RULE =
  "TYPOGRAPHY RULE, absolute: do NOT write, draw, print, emboss or add any " +
  "text, lettering, numerals, wordmark or logo anywhere in this image. If the " +
  "reference product already carries printed text, reproduce exactly that and " +
  "nothing more. If it carries none, the product must stay completely " +
  "unlabelled and blank. Inventing packaging copy is the single worst failure " +
  "this image can have.";

/** What a campaign gets when it says nothing at all. */
export const DEFAULT_LOOK: LookName = "daylight";

/**
 * The looks, as something a person can choose rather than a type they have to
 * know about.
 *
 * The cascade shipped reachable only from a YAML field and from `--prompts`,
 * which meant the one control an art director actually wants was invisible in
 * the console - the surface the work gets demonstrated on. A capability nobody
 * can find is not a capability. The descriptions are one line each on purpose:
 * the whole point of a named look is that choosing it does not require reading
 * seven slots.
 */
export const LOOK_OPTIONS: { id: LookName; label: string; description: string }[] = [
  {
    id: "daylight",
    label: "Daylight",
    description: "Warm directional window light on travertine. The house style.",
  },
  {
    id: "nocturne",
    label: "Nocturne",
    description: "One hard low source, dark plinth, falloff into black.",
  },
  {
    id: "nordic",
    label: "Nordic",
    description: "Flat cool overcast light on pale ash, almost shadowless.",
  },
];

/**
 * The slot values this brief actually runs with, and where each came from.
 *
 * Returned together so the console and `--prompts` can show which slots a brief
 * changed rather than making someone diff two paragraphs by eye. Control you
 * cannot see is not control.
 */
export function resolveArtDirection(brief: CampaignBrief): {
  look: LookName;
  slots: Required<SlotValues>;
  overridden: Slot[];
} {
  const look = (brief.look ?? DEFAULT_LOOK) as LookName;
  const base = LOOKS[look] ?? LOOKS[DEFAULT_LOOK];

  // A bare string is the set, which is what `artDirection` has always meant.
  // Keeping that shape means every brief written before looks existed still
  // says exactly what it said.
  const overrides: SlotValues =
    typeof brief.artDirection === "string"
      ? { set: brief.artDirection.trim() }
      : (brief.artDirection ?? {});

  const slots = {} as Required<SlotValues>;
  const overridden: Slot[] = [];
  for (const slot of SLOTS) {
    const override = overrides[slot]?.trim();
    if (override) overridden.push(slot);
    slots[slot] = override || (base[slot] as string);
  }
  return { look, slots, overridden };
}
