# non-2pick-versus

Every versus screen that is **not** 2Pick — all four modes that produce one,
across both capture scales.

| file | source |
| --- | --- |
| `01-ranked-fullscreen.png` | 1920x1080 fullscreen ranked, witch vs nightmare, first |
| `02-ranked-windowed.png` | 1280x720 windowed ranked, witch vs nightmare, second |
| `03-cpu.png` | 1920x1080 CPU practice, witch vs bishop, second |
| `04-custom.png` | 1282x752 custom room, witch vs elf, second |

These exist for one probe. `TWO_PICK_VERSUS_OWN` reads a slot the game fills
with the mode's own name: 「2Pick階級」 in a 2Pick match, 「階級 分組 BP」 in a
ranked one. That makes it a strong signal and also means a false positive there
would be expensive — it would file a ranked match as 2Pick.

Until these were added the probe had never been tested against a non-2Pick
versus screen at all: every other fixture in the set is a home screen, a
battlefield, or a result screen, none of which has a versus row for the window
to land on. "Zero false positives across 37 fixtures" was true and did not cover
the case that mattered.

Measured here: own 0.165–0.316, enemy −0.054–0.388, against a 0.7 threshold.
