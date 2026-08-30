import type { CampaignBrief } from "./schema.js";

/**
 * The art direction, as named slots rather than one paragraph.
 *
 * A brief replaces any slot by name, which is the grain an art director works
 * at. A single flat prompt with a partial override is not: asking for "a low
 * raking light and falloff into black" while the pipeline prepends "warm window
 * daylight with bounce fill" puts two lighting instructions in one prompt and
 * the model splits the difference. That is what generic looks like from inside.
 *
 * Two slots are NOT overridable, and they are the two whose override causes
 * a shipped defect:
 *
 *   composition  derived from the crop arithmetic, not taste. Every format is a
 *                centre crop of one square hero and 9:16 keeps 9/16 of the
 *                width, so the product must sit inside a centred 56% box.
 *                Override it and the product is sliced in half.
 *   typography   the absolute no-lettering rule. Override it and a blank jar
 *                returns printed with invented claims on a regulated cosmetic.
 */
export type Slot =
  | "standard"
  | "optics"
  | "light"
  | "set"
  | "moment"
  | "grade"
  | "materials"
  | "integrity";

export const SLOTS: Slot[] = [
  "standard",
  "optics",
  "light",
  "set",
  "moment",
  "grade",
  "materials",
  "integrity",
];

export type SlotValues = Partial<Record<Slot, string>>;

/**
 * A named look: one word in the brief that sets several slots at once.
 *
 * This is the layer that hides the complexity. A campaign that states nothing
 * gets `daylight`, the house style. A campaign with an opinion says one word. A
 * campaign with a specific opinion overrides a slot on top of that.
 *
 * Three, because three cover the lighting decisions a still-life brief actually
 * makes: warm and directional, dark with falloff to black, flat and overcast.
 * A fourth would be a fourth set of slots to maintain and nothing new to say.
 */
export type LookName = "daylight" | "nocturne" | "nordic";

/**
 * The style bar, shared by every look.
 *
 * Depth of field is stated once, in OPTICS, where it is a lens decision rather
 * than an adjective. It was said here as well and again at the end of OPTICS,
 * and a prompt that says the same thing three times is telling the model that
 * one of the three matters.
 *
 * The closing sentence stays NEGATIVE against Google's general advice, and that
 * is a measured exception rather than an oversight. Rewritten positively as
 * "the frame reads as a photograph made on location for a campaign", the same
 * brief on the same model at the same size came back flatter: softer shadow,
 * a more uniform background, less separation. Naming the two failure modes is
 * what holds the style, so the negation earns its place here and nowhere else.
 */
const CINEMATIC_BAR =
  "Award-winning cinematic advertising photography, editorial quality, shot for " +
  "a global luxury brand campaign. Rich, filmic colour grade with deep tonal " +
  "range. Dramatic natural light with real atmosphere and mood. Hyper-detailed " +
  "and photorealistic, with the subject critically sharp. Not a flat studio " +
  "packshot, not a stock catalogue render.";

/**
 * Optics, shared by every look.
 *
 * The product stays critically sharp and the set falls away. Stacking focus
 * across the whole frame at f/9 is catalogue lighting: technically clean, flat,
 * and the reason such output reads as stock. Depth is what separates an
 * advertisement from a packshot.
 *
 * It asks for the product's FORM to be sharp, not its label. Asking for a
 * critically sharp label while the last clause of the same prompt forbids all
 * lettering is one instruction contradicting another, and a model resolves that
 * by picking one.
 */
const OPTICS =
  "Shot on a 100mm macro lens at f/4, locked off on a tripod, with focus " +
  "stacked across the product itself so its form, edges and surface texture are " +
  "critically sharp while the background falls into a soft, creamy out-of-focus " +
  "wash with gentle bokeh.";

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
  "The container is sealed and opaque, its cap fully seated, so only the " +
  "outside of the packaging is visible and nothing of the contents shows.";

/**
 * The moment. Google's prompting guide names the essential elements of an image
 * prompt as subject, composition, ACTION, location and style
 * (cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana,
 * verified 2026-08-29), and without this the prompt has every one except action.
 *
 * It shows: a correctly lit object sitting still is packshot photography, not
 * campaign photography. The subject is a sealed cosmetic that must stay sealed
 * and unlabelled, so the action is the air and the light doing something around
 * it - which is what a still-life photographer waits for.
 */
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
      "between the product and the set. The lighting is felt, not seen: only the " +
      "light and the surfaces it falls on appear in the frame.",
    set:
      "on a honed travertine ledge against a seamless plaster wall, with soft " +
      "foliage shadow falling across the background",
    moment:
      "Caught at a moment rather than posed: the foliage shadow is mid-drift " +
      "across the wall, fine dust hangs in the light beam, and the air is " +
      "faintly moving. Something is happening in the frame.",
    grade:
      "Restrained tonal colour grade, sympathetic to the brand palette without " +
      "tinting the product itself.",
    materials: MATERIALS,
    integrity: INTEGRITY,
  },

  nocturne: {
    standard: CINEMATIC_BAR,
    optics: OPTICS,
    // The whole point of the look: one hard low source, and permission for the
    // frame to go black. "Shadows are deep but open", which the daylight look
    // says, would contradict it.
    light:
      "Lit by a single low raking light from one side, hard and directional, " +
      "with no fill on the opposite side so the shadow falls away into near " +
      "black. A narrow specular edge separates the product from the darkness " +
      "behind it. Most of the frame is unlit and is meant to be. The lighting " +
      "is felt, not seen: only the light and the surfaces it falls on appear " +
      "in the frame.",
    set: "on a dark polished stone plinth against a deep shadowed wall",
    moment:
      "Caught at a moment rather than posed: a thin haze drifts through the " +
      "single beam, catching it, and the edge of the light is just breaking " +
      "across the product as though it were moving.",
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
      "a room. Very low contrast. The lighting is felt, not seen: only the light " +
      "and the surfaces it falls on appear in the frame.",
    set: "on a pale ash wood counter beside a linen cloth, with a soft haze in the air",
    moment:
      "Caught at a moment rather than posed: the linen has just been set down " +
      "and is still settling into its folds, and cool morning air moves the " +
      "haze across the counter.",
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
 * centred square of 56%, and nothing is gained by making it smaller. Aiming
 * lower photographs the product from across the room; a brief allowed to
 * override this would slice its own product in half on the story format.
 */
export const COMPOSITION =
  "The product sits in the LOWER HALF of the frame, horizontally centred, and " +
  "is large, close and unmistakably the subject -- it fills most of the central " +
  "50% of the width, with its base and lid entirely in frame. The UPPER HALF is " +
  "quiet background: surface, light and shadow alone, because the campaign " +
  "headline is composited there. The product is shown whole and centred.";

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

/**
 * Where a second, third or fourth product in the same campaign is placed.
 *
 * `artDirection` is brief-level, so without this every product resolves to the
 * identical set and a campaign reads as one picture taken twice. A real shoot
 * moves the camera to another corner of the same location.
 *
 * Not new schema: a per-product field would be a fourth escape hatch on a
 * system with three, for a problem a brief never has to think about. Rotating
 * within the look keeps light, grade and materials identical - which is what
 * holds a campaign together - and moves only the placement.
 *
 * Index-keyed rather than random, so the same brief produces the same prompt
 * and the cache key holds.
 */
const SET_VARIATIONS: Record<LookName, string[]> = {
  daylight: [
    "on a honed travertine ledge against a seamless plaster wall, with soft foliage shadow falling across the background",
    "on a wide plaster sill in the same room, further from the window, with the foliage shadow thrown longer and lower across the wall behind",
    "on a raw travertine block set on the floor against the same plaster wall, the light arriving from higher up",
  ],
  nocturne: [
    "on a dark polished stone plinth against a deep shadowed wall",
    "on the same dark stone, closer to the light source, so the plinth edge catches a hard specular line and the wall falls further away",
    "on a low dark stone step against the same shadowed wall, the light raking from further behind",
  ],
  nordic: [
    "on a pale ash wood counter beside a linen cloth, with a soft haze in the air",
    "on the same pale ash counter further along, beside a shallow ceramic dish, the linen out of frame",
    "on a pale ash shelf against the wall, the counter and its linen visible softly behind",
  ],
};

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
export function resolveArtDirection(
  brief: CampaignBrief,
  /**
   * Which product in the campaign this is. Rotates the SET only, so a campaign
   * reads as several photographs of one world rather than one photograph taken
   * twice. Omitted, or when the brief names its own set, nothing rotates.
   */
  productIndex = 0,
): {
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

  // Only when the brief did not state a set of its own. A brief that named one
  // means it, for every product.
  if (!overrides.set) {
    const variants = SET_VARIATIONS[look] ?? SET_VARIATIONS[DEFAULT_LOOK];
    slots.set = variants[productIndex % variants.length];
  }
  return { look, slots, overridden };
}
