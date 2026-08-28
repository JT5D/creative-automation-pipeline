# Bundled typefaces

## Rubik — Regular (400) and Bold (700)

`Rubik-Regular.ttf`, `Rubik-Bold.ttf`

> Copyright 2015 The Rubik Project Authors (https://github.com/googlefonts/rubik)
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.
> This license is available with a FAQ at: https://scripts.sil.org/OFL

Both lines above are quoted verbatim from the fonts' own `name` table (IDs 0 and
13), not from a third-party listing. The OFL permits bundling and redistribution
inside a larger work, including commercially, provided the fonts are not sold on
their own and the notice travels with them — which is what this file is for.

**Why bundled at all.** The brand file names typefaces by PATH, never by family
name, and the chain contains only these two files. An earlier chain started with
`/System/Library/Fonts/Supplemental/Arial Bold.ttf` and fell through to a Linux
path before reaching a bundled font — so the same brief rendered in Arial Bold on
the author's Mac and in DejaVu Book in CI. Three faces, two weights, one brief.
The docstring promising machine-independent rendering was false while that chain
existed. Bundled-only is what makes it true.

**Why these, and a caveat about trusting metadata.** The source files were named
`Rubik-Bold-static.ttf` and `Rubik-Regular-static.ttf`, and BOTH declared
`typographic subfamily: Light` in their name table — the filenames and the name
table disagreed. Neither was trusted. `OS/2.usWeightClass` reports 700 and 400
respectively, and measured ink coverage of the same word at the same size is
0.1134 vs 0.0686, so the weights are genuinely distinct and correctly assigned.

**Glyph coverage** was verified against every headline this repo ships, not
assumed: all three markets (en-US, de-DE with umlauts, es-MX with accents and
inverted punctuation) are fully covered. A test asserts it, because a missing
glyph renders as a `.notdef` box without raising.
