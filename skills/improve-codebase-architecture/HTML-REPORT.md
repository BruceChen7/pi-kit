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

- **Title** — short, names the deepening (e.g. "Collapse the Order intake pipeline").
- **Badge row** — recommendation strength (`Strong` = emerald green, `Worth exploring` = amber,
  `Speculative` = slate grey), plus a tag for the **dependency category** from `DEEPENING.md`
  (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
- **Files** — monospaced list of involved modules/files.
- **Before / After diagram** — the centrepiece. Two columns, side by side.
- **Problem** — one sentence. What hurts.
- **Solution** — one sentence. What changes.
- **Wins** — short bullets (≤6 words), using **locality**, **leverage**, **interface**, and **seam**.
- **Doc impact** — `.pi/contexts/**` terms or ADRs that may need updates.
- **ADR callout** — only when real friction justifies revisiting an ADR; one line in an
  amber-tinted box.

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the
diagram.

## No-paragraph rule (critical)

**If the diagram needs a paragraph to be understood, redraw the diagram.** The diagram is the
prose. The text labels, arrows, and layout carry the weight. Keep each candidate's prose to
one sentence each for Problem and Solution, plus ≤6-word wins bullets.

## Diagram patterns

Pick the shape that communicates the candidate with the least prose. Mix patterns — don't make
every diagram look the same; variety is part of the point.

### Mermaid graph (workhorse for dependencies / call flow)

Use for dependencies, call graphs, and sequences. Fences must use exactly `mermaid` when the
artifact is Markdown; in HTML, use the renderer supported by the current visual pipeline. If the
syntax is uncertain, use inline SVG or plain boxes instead.

Wrap Mermaid in a card so it doesn't feel parachuted in. Style with `classDef` to colour leakage
edges red and the deep module dark. Sequence diagrams work well for "before: 6 round-trips;
after: 1."

```html
<div class="diagram">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### Hand-built boxes and arrows (when Mermaid layout fights you)

Use positioned `<div>` boxes and inline SVG arrows when Mermaid layout hides the point. This is
best for showing a deep module absorbing shallow wrappers. Modules as `<div>`s with borders and
labels; arrows as inline SVG `<line>` or `<path>` elements positioned absolutely over a relative
container.

### Cross-section (good for layered shallowness)

Use stacked horizontal bands to show calls passing through too many thin modules. The after view
should collapse them into one thicker module with faded internals.

Before: 6 thin layers each doing nothing. After: 1 thick band labelled with the consolidated
responsibility.

### Mass diagram (good for "interface as wide as implementation")

Two rectangles per module — one for interface surface area, one for implementation.

Before: interface rectangle is nearly as tall as the implementation rectangle (**shallow**).
After: interface rectangle is short, implementation rectangle is tall (**deep**).

### Call-graph collapse (good for scattered call trees)

Before: a tree of function calls rendered as nested boxes.
After: the same tree collapsed into one box, with the now-internal calls shown faded inside it.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace. Serif optional for headings
  (`font-family: Georgia, "Times New Roman", serif` works well with slate/stone palette).
- Colour sparingly: one accent (emerald or indigo) plus red for leakage and amber for warnings.
- Keep diagrams ~320px tall so before/after sits comfortably side by side without scrolling.
- Use compact, uppercase labels (`font-size: 11px; letter-spacing: 0.06em`) inside diagram boxes
  — they should read as schematic, not as UI.
- Prefer inline CSS and inline SVG. Mermaid allowed only when the relationship is graph-shaped
  and the runtime can render it reliably.
- The only scripts are the Mermaid ESM import (if used). The report is otherwise static — no
  app code, no interactivity beyond Mermaid's own rendering.

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

One larger card containing:

- candidate name
- why it should go first (one sentence)
- expected leverage/locality gain
- key risk or unresolved question

Anchor-link to the candidate's card above. That's it — no additional prose.

Do not propose detailed interfaces in the report. Ask the user which candidate they want to
explore next.
esolved question

That's it. Anchor-link to the candidate's card above.

Do not propose detailed interfaces in the report. Ask the user which candidate they want to
explore next.
