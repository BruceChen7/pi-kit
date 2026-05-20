---
description: Generate a beautiful standalone HTML diagram and deliver it with Plannotator annotation UI
skills: [plannotator-visual-explainer, visual-explainer]
---
Generate an HTML diagram for: $@

This prompt produces a reviewed visual artifact, not source-code implementation. Write the HTML
under the project Plan Mode plan directory so Plannotator Auto can track and review it.

Use the `plannotator-visual-explainer` visual explainer path. Read the relevant skill references,
component patterns, and Plannotator theme guidance before generating. Pick a distinctive aesthetic
that fits the content — vary fonts, palette, and layout style from previous diagrams.

If `surf` CLI is available (`which surf`), consider generating an AI illustration via
`surf gemini --generate-image` when an image would genuinely enhance the page — a hero banner,
conceptual illustration, or educational diagram that Mermaid cannot express. Match the image style
to the page's palette. Embed as base64 data URI. Skip images when the topic is purely structural or
data-driven.

Write to `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html` with a descriptive filename, then call
`plannotator_auto_submit_review({ path })`. Do not open the browser directly.
