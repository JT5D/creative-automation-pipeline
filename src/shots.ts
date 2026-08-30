import { TYPOGRAPHY_RULE } from "./artDirection.js";

/**
 * One camera set-up, described as a framing rather than an angle.
 *
 * The campaign path generates ONE hero and crops it, so every format is the
 * same photograph. Coverage is what that gives up, and this is what buying it
 * back costs: one paid generation per set-up, only when a person asks.
 *
 * The prompt is short, leads with "keep everything, change only the camera",
 * and is anchored on THE HERO rather than the packshot, so set, light and grade
 * are inherited from the image instead of re-described. One degree of freedom.
 *
 * Boundary worth knowing before promising it to a client: this model
 * RECOMPOSES. It can crop, close in, pull back, tilt, occlude and change what
 * the frame is about. It cannot orbit to reveal geometry the reference never
 * showed - "from behind" and "focus pulled" both returned the reference frame
 * (drift 0.14 and 0.15, against 1.6 to 5.0 for the nine that work) and were
 * deleted. Orbiting needs several reference images, which this model accepts,
 * so it is a brief-and-assets change rather than a different architecture.
 */
export type Shot = { id: string; label: string; framing: string };

export const SHOT_SET: Shot[] = [
  {
    id: "crop",
    label: "Cropped",
    framing:
      "a tight crop that deliberately cuts the product at the frame edge, so " +
      "only part of it is in shot and the composition is built on what is left out",
  },
  {
    id: "macro",
    label: "Macro detail",
    framing:
      "an extreme close-up on surface detail alone - the shoulder, the rim, the " +
      "texture of the material - with the form of the product no longer readable",
  },
  {
    id: "wide",
    label: "Wide establishing",
    framing:
      "a wide establishing shot with the product small in the frame and the set " +
      "and its light doing the work, the environment as the subject",
  },
  {
    id: "overhead",
    label: "Overhead",
    framing:
      "an extreme bird's-eye perspective looking straight down from directly " +
      "above, the product flat in a wide field of surface",
  },
  {
    id: "worm",
    label: "Low angle",
    framing:
      "a low worm's-eye view from below the surface line, looking up at the " +
      "product so it towers against the background",
  },
  {
    id: "dutch",
    label: "Canted",
    framing:
      "a canted dutch angle with the horizon tilted well off level, the frame " +
      "deliberately unsettled",
  },
  {
    id: "through",
    label: "Through foreground",
    framing:
      "a shot taken through an out-of-focus foreground element that partly " +
      "occludes the product, the lens looking past it",
  },
  // The three below move the FOCUS and the SUBJECT OF ATTENTION rather than the
  // camera position. A real shoot covers the light and the surface as well as
  // the product, and this is also the axis the model is reliably good at: it
  // cannot orbit to reveal an unseen side, but it can rack focus and re-weight
  // what the frame is about.
  {
    id: "light",
    label: "Light study",
    framing:
      "a frame about the light rather than the product: the shadow pattern and " +
      "the falloff across the wall are the subject, the product incidental at " +
      "the edge of it",
  },
  {
    id: "surface",
    label: "Surface detail",
    framing:
      "a frame about the set itself - the grain and pitting of the stone, the " +
      "texture of the wall - with the product present only as a soft shape " +
      "beyond the plane of focus",
  },
];

/**
 * The fixed opening every shot prompt begins with, verbatim.
 *
 * "Keep the style and subject details similar and modify the camera" is doing
 * all the work: it tells the model that everything it can see is correct and
 * one thing is not. Rewrite it into our own voice and the sentence starts
 * describing the scene again, at which point the model starts redesigning it.
 */
const SHOT_PREFIX =
  "Using the provided image, keep the style and subject details similar and " +
  "modify the camera to match this:";

/**
 * A camera variant of a hero that already exists.
 *
 * Deliberately NOT built from buildHeroPrompt. That function describes a scene
 * from nothing; this one changes a single property of a scene the model is
 * already looking at, and a prompt that does both makes the model redesign the
 * scene. The only clause carried over is the typography rule, because a model
 * handed a blank product will letter it whatever else the prompt says.
 */
export function buildShotPrompt(shot: Shot): string {
  return [
    `${SHOT_PREFIX} ${shot.framing}.`,
    "Keep the product itself, its packaging, its colour and the set exactly as",
    "they appear in the provided image. Change only the camera and what it is",
    "focused on. Change the composition significantly while holding the style,",
    "the light and the grade identical to the reference.",
    TYPOGRAPHY_RULE,
  ].join(" ");
}
