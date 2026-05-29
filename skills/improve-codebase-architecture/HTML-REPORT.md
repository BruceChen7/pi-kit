# HTML Report Format

Use this when an architecture review has enough candidates or structure that a visual artifact
will make the trade-offs clearer than a plain list. Keep the upstream idea — visual before/after
candidate cards — but deliver it through Pi's reviewable artifact flow.

## Output location

Write the report to a Pi-reviewed artifact, not an OS temp file:

```text
.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-architecture-review.html
```

Submit the artifact through `plannotator_auto_submit_review` when the workflow requires review.
Do not open a browser automatically unless the user asks.

## Scaffold

Use one self-contained HTML file. Prefer inline CSS and inline SVG. Mermaid is allowed when the
relationship is graph-shaped and the runtime can render it reliably.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #fafaf9;
        --card: #ffffff;
        --ink: #0f172a;
        --muted: #64748b;
        --line: #e2e8f0;
        --accent: #059669;
        --warn: #d97706;
        --leak: #dc2626;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 48px 24px;
      }

      .candidate {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 24px;
        margin-top: 24px;
        box-shadow: 0 16px 40px rgb(15 23 42 / 0.06);
      }

      .badge {
        display: inline-flex;
        border-radius: 999px;
        padding: 4px 10px;
        background: rgb(5 150 105 / 0.12);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .diagrams {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }

      .diagram {
        min-height: 280px;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px;
        background: #f8fafc;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="badge">Architecture review</p>
        <h1>{{repo name}}</h1>
        <p>{{date}} · solid box = module · dashed line = seam · red arrow = leakage</p>
      </header>

      <section id="candidates">
        <!-- Candidate cards go here. -->
      </section>

      <section id="top-recommendation">
        <!-- One concise recommendation card. -->
      </section>
    </main>
  </body>
</html>
```

## Candidate card

Each candidate is one `<article class="candidate">` with sparse prose and strong visuals.

Include:

- **Title** — short, names the deepening.
- **Badge row** — recommendation strength: `Strong`, `Worth exploring`, or `Speculative`.
- **Dependency category** — use the names from `DEEPENING.md`.
- **Files** — monospaced list of involved modules/files.
- **Before / After diagram** — the centrepiece.
- **Problem** — one sentence explaining the friction.
- **Solution** — one sentence explaining what changes.
- **Wins** — short bullets using **locality**, **leverage**, **interface**, and **seam**.
- **Doc impact** — `.pi/contexts/**` terms or ADRs that may need updates.
- **ADR callout** — only when real friction justifies revisiting an ADR.

If a paragraph is needed to explain the diagram, redraw the diagram.

## Diagram patterns

Pick the shape that communicates the candidate with the least prose.

### Mermaid graph

Use for dependencies, call graphs, and sequences. Fences must use exactly `mermaid` when the
artifact is Markdown; in HTML, use the renderer supported by the current visual pipeline. If the
syntax is uncertain, use inline SVG or plain boxes instead.

### Hand-built boxes and arrows

Use positioned `<div>` boxes and inline SVG arrows when Mermaid layout hides the point. This is
best for showing a deep module absorbing shallow wrappers.

### Cross-section

Use stacked horizontal bands to show calls passing through too many thin modules. The after view
should collapse them into one thicker module with faded internals.

### Mass diagram

Draw an **interface** rectangle beside an **implementation** rectangle. A shallow module has an
interface nearly as large as its implementation; a deep module has a small interface over a larger
implementation.

### Call-graph collapse

Before: nested boxes for a scattered call tree. After: one deep module box, with former helpers
shown as internal details.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace. Serif optional for headings.
- Colour sparingly: one accent (emerald or indigo) plus red for leakage and amber for warnings.
- Keep diagrams ~320px tall so before/after sits comfortably side by side without scrolling.
- Use compact labels inside diagram boxes — they should read as schematic, not as UI.
- Prefer inline CSS and inline SVG. Mermaid allowed only when the relationship is graph-shaped
  and the runtime can render it reliably.
- The report is otherwise static — no app code, no interactivity beyond Mermaid rendering.

## Tone

Use `.pi/contexts/**/CONTEXT.md` vocabulary for domain concepts and `LANGUAGE.md` vocabulary
for architecture. Concision is not an excuse to drift.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter,
leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) ·
boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullets** name the gain in glossary terms: *"locality: bugs concentrate in one module"*,
*"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the
wrappers"*. Don't write *"easier to maintain"* or *"cleaner code"* — those terms aren't in the
glossary and don't earn their place.

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet,
make it a bullet. If a bullet could be cut, cut it. If a term isn't in `LANGUAGE.md`, reach for
one that is before inventing a new one.

## Top recommendation

End with one larger card containing:

- candidate name
- why it should go first
- expected leverage/locality gain
- key risk or unresolved question

That's it. Anchor-link to the candidate's card above.

Do not propose detailed interfaces in the report. Ask the user which candidate they want to
explore next.
