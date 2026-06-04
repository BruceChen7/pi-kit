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
      /* ================================================================
         Theme — uses Plannotator-injected CSS vars when available
         (HtmlViewer injects --background, --foreground, --card, --border,
         --muted, --accent, --font-sans, --font-mono, etc. into the
         iframe), with prefers-color-scheme fallbacks for standalone
         viewing.
         ================================================================ */
      :root {
        color-scheme: light dark;
        --ink:  #0f172a;
        --back: #fafaf9;
        --card-bg: #ffffff;
        --line: #e2e8f0;
        --dim:  #64748b;
        --green: #059669;
        --amber: #d97706;
        --red:   #dc2626;
        --diagram-bg: #f1f5f9;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --ink:  #e2e8f0;
          --back: #0b1121;
          --card-bg: #131c31;
          --line: #1e2a45;
          --dim:  #8892a8;
          --green: #34d399;
          --amber: #fbbf24;
          --red:   #f87171;
          --diagram-bg: #0f1829;
        }
      }

      body {
        margin: 0;
        background: var(--background, var(--back));
        color: var(--foreground, var(--ink));
        font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-size: 16px;
        line-height: 1.6;
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 40px 24px 80px;
      }

      h1 {
        font-size: 1.75rem;
        font-weight: 700;
        line-height: 1.3;
        margin: 8px 0 4px;
      }

      h2 {
        font-size: 1.25rem;
        font-weight: 600;
        margin: 28px 0 8px;
      }

      p, li {
        font-size: 0.9375rem;
        line-height: 1.65;
      }

      /* ---- Cards ---- */
      .candidate {
        background: var(--card, var(--card-bg));
        border: 1px solid var(--border, var(--line));
        border-radius: 16px;
        padding: 28px;
        margin-top: 28px;
        box-shadow: 0 1px 3px oklch(from var(--foreground, #0f172a) l c h / 0.08);
      }

      /* ---- Badges ---- */
      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        line-height: 1.4;
      }

      .badge-strong {
        background: oklch(from var(--green, #059669) l c h / 0.18);
        color: var(--green);
      }

      .badge-worth {
        background: oklch(from var(--amber, #d97706) l c h / 0.18);
        color: var(--amber);
      }

      .badge-speculative {
        background: oklch(from var(--dim, #64748b) l c h / 0.18);
        color: var(--dim);
      }

      /* ---- Diagrams ---- */
      .diagrams {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin: 16px 0;
      }

      .diagram {
        min-height: 280px;
        border: 1px solid var(--border, var(--line));
        border-radius: 12px;
        padding: 16px;
        background: var(--code-bg, var(--diagram-bg));
        font-size: 0.8125rem;
        overflow-x: auto;
      }

      .diagram-label {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-foreground, var(--dim));
        margin-bottom: 8px;
      }

      /* ---- Multi-line file list ---- */
      .file-list {
        font-family: var(--font-mono, ui-monospace, "JetBrains Mono", "SF Mono", monospace);
        font-size: 0.8125rem;
        line-height: 1.6;
        color: var(--muted-foreground, var(--dim));
        padding: 8px 0;
        margin: 0;
        list-style: none;
      }

      .file-list li::before {
        content: "— ";
        color: var(--muted-foreground, var(--dim));
      }

      /* ---- Wins bullets ---- */
      .wins {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px 0;
        margin: 0;
        list-style: none;
      }

      .wins li {
        background: oklch(from var(--accent, #059669) l c h / 0.1);
        color: var(--accent, var(--green));
        border-radius: 999px;
        padding: 2px 12px;
        font-size: 0.8125rem;
        font-weight: 500;
        white-space: nowrap;
      }

      /* ---- ADR callout ---- */
      .adr-callout {
        background: oklch(from var(--amber, #d97706) l c h / 0.12);
        border-left: 3px solid var(--amber);
        border-radius: 6px;
        padding: 10px 14px;
        margin: 12px 0;
        font-size: 0.875rem;
        color: var(--foreground, var(--ink));
      }

      /* ---- Header / Meta ---- */
      .meta {
        color: var(--muted-foreground, var(--dim));
        font-size: 0.875rem;
      }

      /* ---- Top recommendation ---- */
      #top-recommendation .candidate {
        border-color: var(--accent, var(--green));
        box-shadow: 0 0 0 1px var(--accent, var(--green));
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
