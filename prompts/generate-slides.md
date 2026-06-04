---
description: Generate a stunning magazine-quality slide deck as a self-contained HTML page
---
Generate a slide deck for: $@

This prompt produces a reviewed visual artifact, not source-code implementation. Write the HTML
under the project Plan Mode plan directory so Plannotator Auto can track and review it.

Use the `plannotator-visual-explainer` visual explainer path, then follow the slide-deck references
from the underlying visual-explainer skill. Read the slide template, slide patterns, shared CSS
patterns, Mermaid/libraries references, and Plannotator theme guidance before generating.

**Slide output is always opt-in.** Only generate slides when this command is invoked or the user
explicitly asks for a slide deck.

**Aesthetic:** Pick a distinctive direction from the slide presets or riff on the existing aesthetic
directions adapted for slides. Vary from previous decks. Commit to one direction and carry it
through every slide.

**Narrative structure:** Slides have a temporal dimension — compose a story arc, not a list of
sections. Start with impact (title), build context (overview), deep dive (content, diagrams, data),
resolve (summary/next steps). Plan the slide sequence and assign a composition (centered,
left-heavy, split, full-bleed) to each slide before writing HTML.

**Visual richness:** Proactively reach for visuals. If `surf` CLI is available (`which surf`),
generate images for title slide backgrounds and full-bleed slides via `surf gemini --generate-image`.
Add SVG decorative accents, inline sparklines, mini-charts, and small Mermaid diagrams where they
make the story more compelling. Visual-first, text-second.

**Compositional variety:** Consecutive slides must vary their spatial approach. Alternate between
centered, left-heavy, right-heavy, split, edge-aligned, and full-bleed. Three centered slides in a
row means push one off-axis.

Write to `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html` with a descriptive filename, then call
`plannotator_auto_submit_review({ path })`. Do not open the browser directly.
