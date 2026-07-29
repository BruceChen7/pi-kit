---
description: Generate a Visual Artifact plan review — current codebase state vs. proposed implementation plan
---
Generate a comprehensive plan review as a Visual Artifact via the `create_visual_artifact` tool, comparing the current codebase against a proposed implementation plan.

This prompt produces a reviewed visual artifact, not source-code implementation. It uses the `create_visual_artifact` tool — pass `nodes` as a JSON string of the node array, and `data` as a JSON string when present — not a standalone HTML page.

**Inputs:**
- Plan file: `$1` (path to a markdown plan, spec, or RFC document)
- Codebase: `$2` if provided, otherwise the current working directory

**Data gathering phase** — read and cross-reference these before generating:

1. **Read the plan file in full.** Extract:
   - The problem statement and motivation
   - Each proposed change (files to modify, new files, deletions)
   - Rejected alternatives and their reasoning
   - Any explicit scope boundaries or non-goals

2. **Read every file the plan references.** For each file mentioned in the plan, read the current version in full. Also read files that import or depend on those files — the plan may not mention all ripple effects.

3. **Map the blast radius.** From the codebase, identify:
   - What imports/requires the files being changed (grep for import paths)
   - What tests exist for the affected files (look for corresponding `.test.*` / `.spec.*` files)
   - Config files, types, or schemas that might need updates
   - Public API surface that callers depend on

4. **Cross-reference plan vs. code.** For each change the plan proposes, verify:
   - Does the file/function/type the plan references actually exist in the current code?
   - Does the plan's description of current behavior match what the code actually does?
   - Are there implicit assumptions about code structure that don't hold?

**Verification checkpoint** — before generating the artifact, produce a structured fact sheet of every claim you will present in the review:
- Every quantitative figure: file counts, estimated lines, function counts, test counts
- Every function, type, and module name you will reference from both the plan and the codebase
- Every behavior description: what the code currently does vs. what the plan proposes
- For each, cite the source: the plan section or the file:line where you read it
Verify each claim against the code and the plan. If something cannot be verified, mark it as uncertain rather than stating it as fact. This fact sheet is your source of truth during artifact generation — do not deviate from it.

**Artifact structure** — build a spec object with 9 sections mapped to Visual Artifact node types, then call `create_visual_artifact` with `nodes: JSON.stringify(spec.nodes)` and `data: JSON.stringify(spec.data)` when `data` is present.

Sections 1-4 are the visual anchor — use `heading` (h1/h2) + `text` (size lg/xl). Sections 5+ are reference/exploratory — wrap them in `accordion` nodes to keep the artifact compact and under the 30 top-level node limit.

### Section-to-node mapping

| # | Section | VA Node Type(s) | Notes |
|---|---------|-----------------|-------|
| 1 | **Plan summary** | `heading` (h1) + `text` (xl) + `badge` | Lead with intuition, then scope. Use text xl for the lead paragraph. |
| 2 | **Impact dashboard** | `kpi-grid` | Use 4-6 high-signal metrics: files to modify/create/delete, est. lines, new tests, dependencies. Omit redundant zeros. Completeness (tests/docs/migration) goes in `badge` nodes below the grid. |
| 3 | **Current architecture** | `mermaid` | Current-subsystem diagram. Use `flowchart` syntax, double-quoted labels. Use the same layout direction as section 4. |
| 4 | **Planned architecture** | `mermaid` | Post-plan subsystem diagram. Use the same layout direction as section 3. **Label convention for diff visibility (no CSS):** prefix new nodes with `"+"`, removed with `"-"`, modified with `"~"`. |
| 5 | **Change-by-change breakdown** | `accordion` | One accordion (collapsible). Each change = one accordion item. Inside each item: `side-by-side` (left=current code, right=planned code) + `callout`(info) for rationale. Flag discrepancies where plan describes current behavior incorrectly. |
| 6 | **Dependency & ripple analysis** | `table` + `badge` | Table with columns: file, impact type, status. Use badge variants: success=covered, warning=unmentioned, danger=missed. |
| 7 | **Risk assessment** | `accordion` | One accordion. Items: Edge cases, Assumptions, Ordering risks, Rollback complexity, Cognitive complexity. Per item: `card` + `badge`(severity: info=low, warning=medium, danger=high). Each cognitive complexity flag includes a mitigation suggestion. |
| 8 | **Plan review** | `accordion` | One accordion. Items: Good (success badge), Bad (danger badge), Ugly (warning badge), Questions (info badge). Per item: `card` + `list` with file:plan-section references. If nothing to flag, say "None found." |
| 9 | **Understanding gaps** | `kpi-grid` + `card` + `list` | Two `stat-card`s: Rationale Coverage (covered/total) and Cognitive Flags (count). Below: a `list` of flagged items with severity, and explicit recommendations. |

### Visual hierarchy guidelines

- **Sections 1-4**: Use `heading` h1/h2 + `text` size lg/xl. These are the primary content — no wrapping in accordion.
- **Sections 5, 7, 8**: Always wrap in `accordion` (collapsible). Each accordion item can contain multiple sub-nodes (cards, side-by-side, callouts, lists).
- **Section 6**: Keep as a plain `table` top-level node (compact enough).
- **Section 9**: Keep as `kpi-grid` + `card` + `list` top-level nodes (compact, closing summary).
- **Prose density**: Keep top-level paragraphs under roughly 100 Chinese characters or 70 English words. Move detailed evidence into lists or the reference accordion.
- **KPI semantics**: A trend arrow means directional change, not quality. Use `variant` to express success/warning/danger when a value has evaluative meaning.

### Available node types for context

Refer to the `create_visual_artifact` tool's `nodes` parameter for the full list. Key types for plan reviews:

| Type | Use for |
|------|---------|
| `heading` | Section titles (h1-h4) |
| `text` | Prose, with sizes sm/md/lg/xl |
| `list` | Bulleted items |
| `card` | Bordered container with optional title |
| `stat-card` | Single metric with trend |
| `table` | Rows and columns of data |
| `diff` | Code-level before/after diff |
| `code-block` | Highlighted code |
| `mermaid` | Flowcharts, sequence diagrams, state diagrams |
| `badge` | Short colored labels (info/success/warning/danger/default) |
| `callout` | Info/success/warning/danger callouts |
| `side-by-side` | Before/after comparison panels |
| `kpi-grid` | Dashboard-style KPI grid |
| `file-tree` | Nested file tree with optional `status` |
| `accordion` | Collapsible groups (use for reference sections 5, 7, 8) |
| `section` | Untitled section container |

### Mermaid guidelines (always follow)

- Always use double-quoted labels: `N["label text"]` not `N[label text]`
- Never use parentheses `()` inside unquoted labels
- Apply `:::` class on a separate line, NOT inline
- Keep diagram type simple: `flowchart LR`, `sequenceDiagram`, `stateDiagram-v2`
- For diff visibility in the two-architecture diagrams, use label prefixes:
  - `N["+ newModule"]` — new in planned architecture
  - `N["- removedModule"]` — present in current, removed in planned
  - `N["~ changedModule"]` — modified between current and planned
  - Add a `callout`(info) under each diagram listing which nodes changed and why

### Folding strategy (top-level node conservation)

The `create_visual_artifact` tool has a 30 top-level node limit. This mapping uses approximately 8-10 top-level nodes, well under the limit. Sections 5, 7, and 8 are accordion-wrapped (each counts as 1 top-level node).

Example condensed structure:

```json
{
  "slug": "plan-review-<YYYY-MM-DD>-<topic>",
  "title": "Plan Review: <plan title>",
  "artifactType": "review",
  "nodes": [
    // Section 1: Plan summary — heading + text xl + badges
    { "type": "heading", "props": { "text": "<title>", "level": "h1" } },
    { "type": "text", "props": { "text": "<intuition paragraph>", "size": "xl" } },
    { "type": "text", "props": { "text": "<scope paragraph>" } },
    { "type": "badge", "props": { "text": "tests: covered|missing", "variant": "success|danger" } },

    // Section 2: Impact dashboard
    { "type": "kpi-grid", "props": { "columns": 3, "items": [
      { "label": "Files to Modify", "value": 5, "trend": "up" },
      { "label": "New Files", "value": 2, "trend": "up" },
      { "label": "Est. Lines", "value": "+340/-120", "trend": "up" },
      { "label": "New Tests", "value": 3, "trend": "up" },
      { "label": "Dependencies Affected", "value": 1, "trend": "neutral" }
    ] } },

    // Section 3: Current architecture
    { "type": "mermaid", "props": { "definition": "flowchart LR\n  A[\"auth middleware\"] --> B[\"handler\"]\n  B --> C[\"db query\"]" } },

    // Section 4: Planned architecture (same layout, +/−/~ prefixes)
    { "type": "mermaid", "props": { "definition": "flowchart LR\n  A[\"+ cache layer\"] --> B[\"auth middleware\"]\n  B --> C[\"~ handler\"]\n  C --> D[\"db query\"]" } },
    { "type": "callout", "props": { "text": "New: cache layer. Modified: handler gains cache check. Removed: direct db fallback.", "variant": "info" } },

    // Section 5: Change-by-change breakdown (accordion)
    { "type": "accordion", "props": { "items": [
      { "title": "Change 1: src/handler.ts — add cache check",
        "nodes": [
          { "type": "side-by-side", "props": {
            "leftLabel": "Current",
            "rightLabel": "Planned",
            "left": [{ "type": "code-block", "props": { "code": "function handle(req) { ... }", "language": "typescript" } }],
            "right": [{ "type": "code-block", "props": { "code": "function handle(req) { cache.get(req.id) ... }", "language": "typescript" } }]
          } },
          { "type": "callout", "props": { "text": "Rationale: reduce db load on repeated requests (plan §3.1)", "variant": "info" } }
        ]
      }
    ] } },

    // Section 6: Dependency & ripple analysis (table)
    { "type": "table", "props": { "headers": ["File", "Impact", "Status"], "rows": [
      ["src/router.ts", "imports handler", "covered"],
      ["tests/handler.test.ts", "needs new test cases", "unmentioned"]
    ] } },

    // Section 7: Risk assessment (accordion)
    { "type": "accordion", "props": { "items": [
      { "title": "Edge cases", "nodes": [
        { "type": "card", "props": { "title": "Cache miss storm on cold start",
          "nodes": [{ "type": "badge", "props": { "text": "medium", "variant": "warning" } },
                    { "type": "text", "props": { "text": "Plan doesn't address pre-warm strategy." } }]
        } }
      ] },
      { "title": "Assumptions", "nodes": [...] },
      { "title": "Ordering risks", "nodes": [...] },
      { "title": "Rollback complexity", "nodes": [...] },
      { "title": "Cognitive complexity", "nodes": [...] }
    ] } },

    // Section 8: Plan review (accordion)
    { "type": "accordion", "props": { "items": [
      { "title": "Good", "nodes": [
        { "type": "card", "props": { "title": "Good",
          "nodes": [{ "type": "badge", "props": { "text": "success", "variant": "success" } },
                    { "type": "text", "props": { "text": "Separation of cache logic from handler is clean (plan §3.2)." } }]
        } }
      ] },
      { "title": "Bad", "nodes": [...] },
      { "title": "Ugly", "nodes": [...] },
      { "title": "Questions", "nodes": [...] }
    ] } },

    // Section 9: Understanding gaps (kpi-grid + card + list)
    { "type": "kpi-grid", "props": { "columns": 2, "items": [
      { "label": "Rationale Coverage", "value": "3/5", "trend": "neutral" },
      { "label": "Cognitive Flags", "value": "2", "trend": "up" }
    ] } },
    { "type": "card", "props": { "title": "Recommendations",
      "nodes": [{ "type": "list", "props": { "items": [
        "Document rationale for Change 2 and Change 4 before implementing — plan doesn't explain why these approaches were chosen over alternatives.",
        "Add pre-warm strategy to address medium-severity cache-miss-storm risk."
      ] } }]
    } }
  ]
}
```

### Change-by-change content guidelines (section 5)

For each change in the plan, an accordion item containing:

- `side-by-side` with `leftLabel: "Current"` and `rightLabel: "Planned"`
  - Left: `code-block` of current code/function signatures
  - Right: `code-block` of planned code as described in the plan
- `callout` (info variant) for rationale: extract _why_ the plan chose this approach. Pull from the plan's reasoning, rejected alternatives section, or inline justifications
- If the plan has a "rejected alternatives" section, map those rejections to the specific changes they apply to
- Flag changes where the plan says _what_ to do but not _why_ — these are pre-implementation cognitive debt
- Flag any discrepancies where the plan's description of current behavior doesn't match the actual code

### Risk assessment content guidelines (section 7)

Five categories, each as an accordion item:

- **Edge cases** — what the plan doesn't address
- **Assumptions** — what the plan assumes about the codebase that should be verified
- **Ordering risks** — if changes need a specific sequence
- **Rollback complexity** — if things go wrong
- **Cognitive complexity** — non-obvious coupling, action-at-a-distance, implicit ordering, contracts that exist only in developer memory. Each flag gets a mitigation suggestion. Broader concerns (overengineering, lock-in, maintenance burden) belong in section 8's Ugly.

Per item: `card` with severity `badge` (info=low, warning=medium, danger=high).

### Plan review content guidelines (section 8)

Four categories in one accordion:

- **Good** (green/success) — solid design decisions, well-reasoned tradeoffs
- **Bad** (red/danger) — gaps: missing files, unaddressed edge cases, incorrect assumptions
- **Ugly** (amber/warning) — subtle concerns: complexity, maintenance burden, future problems
- **Questions** (blue/info) — ambiguities needing plan author's clarification

Each item references specific plan sections and code files. If nothing to flag, say "None found."

### Understanding gaps guidelines (section 9)

Rolls up decision-rationale gaps from section 5 and cognitive complexity flags from section 7:

- Two `stat-card`s in a `kpi-grid`: Rationale Coverage (covered/total) and Cognitive Flags (count)
- A `card` containing a `list` of explicit recommendations: "Before implementing, document the rationale for changes X and Y — the plan doesn't explain why these approaches were chosen over alternatives"
- This section makes cognitive debt visible _before_ the work starts, when it's cheapest to address.

After assembling the full `spec` object, call `create_visual_artifact` with `slug`, `title`, `artifactType`, and `description` from `spec`, plus `nodes: JSON.stringify(spec.nodes)` and `data: JSON.stringify(spec.data)` when `spec.data` exists.

Example:

```ts
const spec = {
  slug: "plan-review-<YYYY-MM-DD>-<topic>",
  title: "Plan Review: <descriptive title>",
  artifactType: "review",
  description: "<optional description>",
  nodes: [
    /* ArtifactNode[] — see example structure above */
  ],
  data: {
    /* optional shared datasets */
  },
};

create_visual_artifact({
  slug: spec.slug,
  title: spec.title,
  artifactType: spec.artifactType,
  description: spec.description,
  nodes: JSON.stringify(spec.nodes),
  data: spec.data ? JSON.stringify(spec.data) : undefined,
});
```

Do NOT:
- Write standalone HTML files
- Use `plannotator_auto_submit_review`
- Reference css-patterns.md, plannotator theme, or plan directories
- Generate hero images via `surf` CLI
- Open a browser directly

The Visual Artifact window handles rendering, theming, and interaction. Do not assume diagrams have zoom controls; keep Mermaid definitions compact enough to read at the default size.

Use a current-vs-planned visual language through badge/callout variants: success/blue for current state, success/green for planned additions, warning for areas of concern, danger for gaps or risks.

Ultrathink.

$@
