---
description: Generate a Visual Artifact diff review — before/after architecture comparison with code review analysis
---
Generate a comprehensive diff review as a Visual Artifact via the `create_visual_artifact` tool.

This prompt produces a reviewed visual artifact, not source-code implementation. It uses the `create_visual_artifact` tool — pass `nodes` as a JSON string of the node array, and `data` as a JSON string when present — not a standalone HTML page.

**Scope detection** — determine what to diff based on `$1`:
- Branch name (e.g. `main`, `develop`): working tree vs that branch
- Commit hash: that specific commit's diff (`git show <hash>`)
- `HEAD`: uncommitted changes only (`git diff` and `git diff --staged`)
- PR number (e.g. `#42`): `gh pr diff 42`
- Range (e.g. `abc123..def456`): diff between two commits
- No argument: default to `main`

**Data gathering phase** — run these first to understand the full scope:
- `git diff --stat <ref>` for file-level overview
- `git diff --name-status <ref> --` for new/modified/deleted files (separate src from tests)
- Line counts: compare key files between `<ref>` and working tree (`git show <ref>:file | wc -l` vs `wc -l`)
- New public API surface: grep added lines for exported symbols, public functions, classes, interfaces (adapt the pattern to the project's language — `export`/`function`/`class`/`interface` for TS/JS, `def`/`class` for Python, `func`/`type` for Go, etc.)
- Feature inventory: grep for new actions, keybindings, config fields, event types on both sides
- Read all changed files in full — include surrounding code paths needed to validate behavior
- Check whether `CHANGELOG.md` has an entry for these changes
- Check whether `README.md` or `docs/*.md` need updates given any new or changed features
- Reconstruct decision rationale: if this work was done in the current session, mine the conversation for approaches discussed, alternatives rejected, and trade-offs made. Check for progress docs (`~/.agent/memory/{project}/progress.md`, `~/.pi/agent/memory/{project}/progress.md`) or plan files that may contain reasoning. For committed changes, read commit messages and PR descriptions.

**Verification checkpoint** — before generating the artifact, produce a structured fact sheet of every claim you will present in the review:
- Every quantitative figure: line counts, file counts, function counts, test counts
- Every function, type, and module name you will reference
- Every behavior description: what code does, what changed, before vs. after
- For each, cite the source: the git command output that produced it, or the file:line where you read it
Verify each claim against the code. If something cannot be verified, mark it as uncertain rather than stating it as fact. This fact sheet is your source of truth during artifact generation — do not deviate from it.

**Artifact structure** — build a spec object with the following 10 sections mapped to Visual Artifact node types, then call `create_visual_artifact` with `nodes: JSON.stringify(spec.nodes)` and `data: JSON.stringify(spec.data)` when `data` is present.

Sections 1-3 are the visual anchor — use one concise `text` node with `size: "lg"` or `"xl"` and a `heading` with `level: "h1"`. Keep the executive summary to two short paragraphs. Sections 6+ (file map, test coverage, code review, decision log, re-entry context) are reference material — wrap them in `accordion` nodes to keep the artifact compact and under the 30 top-level node limit.

### Section-to-node mapping

| # | Section | VA Node Type(s) | Notes |
|---|---------|-----------------|-------|
| 1 | **Executive summary** | `heading` (h1) + `text` (xl) + `badge` | Lead with intuition, then scope. Use text xl for the lead paragraph. |
| 2 | **KPI dashboard** | `kpi-grid` | Use 4-6 high-signal metrics only, with at most 3 columns. Omit redundant zero-value metrics. Put CHANGELOG/docs status in badges, not KPI cards. |
| 3 | **Module architecture** | `mermaid` | Include one compact dependency graph only when it clarifies a non-obvious relationship. Do not wrap Mermaid in another card. |
| 4 | **Major feature comparisons** | `side-by-side` | Use at most two focused comparisons for genuinely different before/after behavior. Set `leftLabel`/`rightLabel` for headers. |
| 5 | **Flow diagrams** | `mermaid` | Include at most one additional flow/sequence diagram and only when it adds information not already shown by the architecture graph. |
| 6 | **File map** | `file-tree` | Full tree with `status: "added"\|"modified"\|"deleted"` on items. Wrap in `accordion` (collapsed by default) to save top-level slots. |
| 7 | **Test coverage** | `table` + `stat-card` | Before/after test counts. Inline tables must use `headers` and `rows`; use `columns` only with a referenced `dataKey`. |
| 8 | **Code review** | `card` + `badge` + `list` | Four categories: Good (green badge), Bad (danger badge), Ugly (warning badge), Questions (default badge). Each card contains a `list` of findings with file:line references. If nothing to flag, say "None found." |
| 9 | **Decision log** | `card` + `badge` + `text` | Per decision: `card` with Decision (bold text), Rationale (prose), Alternatives (list), Confidence (badge: green=high, default=medium, warning=low). Low-confidence cards: include a note to document before committing. |
| 10 | **Re-entry context** | `accordion` (collapsed) | Collapsed by default. Inside: `list` items for Key invariants, Non-obvious coupling, Gotchas, Don't-forget. |

### Folding strategy (top-level node conservation)

The `create_visual_artifact` tool has a 30 top-level node limit. Sections 6-10 should be wrapped in `accordion` nodes (each accordion counts as 1 top-level node) to stay well under the limit while keeping all content accessible.

Use the following structure to minimize top-level node count for the in-memory `spec` object before stringifying `spec.nodes` for the tool call:

```json
{
  "slug": "diff-review-<YYYY-MM-DD>-<topic>",
  "title": "Diff Review: <descriptive title>",
  "artifactType": "review",
  "nodes": [
    // Section 1: Executive summary — heading + text xl + badges
    { "type": "heading", "props": { "text": "<title>", "level": "h1" } },
    { "type": "text", "props": { "text": "<intuition paragraph>", "size": "xl" } },
    { "type": "text", "props": { "text": "<scope paragraph>" } },

    // Section 2: KPI dashboard
    { "type": "kpi-grid", "props": {
      "columns": 3,
      "items": [
        { "label": "Files Changed", "value": 12, "trend": "up" },
        { "label": "Lines Added", "value": 340, "trend": "up" },
        { "label": "New Modules", "value": 2, "trend": "neutral" },
        { "label": "Tests", "value": 8, "trend": "up" }
      ]
    } },

    // Sections 3-5: direct nodes
    { "type": "mermaid", "props": { "definition": "<flowchart>" } },
    { "type": "side-by-side", "props": {
      "leftLabel": "Before",
      "rightLabel": "After",
      "left": [ /* before content nodes */ ],
      "right": [ /* after content nodes */ ]
    } },

    // Sections 6-10: accordion-wrapped
    { "type": "accordion", "props": { "items": [
      // File map
      { "title": "File Map", "nodes": [{ "type": "file-tree", "props": { "items": [...] } }] },
      // Test coverage
      { "title": "Test Coverage", "nodes": [...] },
      // Code review
      { "title": "Code Review", "nodes": [...] },
      // Decision log
      { "title": "Decision Log", "nodes": [...] },
      // Re-entry context
      { "title": "Re-entry Context", "nodes": [...] }
    ] } }
  ]
}
```

### Visual hierarchy guidelines

- **Sections 1-3**: Use `heading` h1/h2 + `text` size lg/xl. These are the primary content — no wrapping in accordion.
- **Sections 4-5**: Prefer one focused comparison and one diagram over repeating several structurally similar blocks.
- **Sections 6-10**: Always wrap in `accordion` (collapsed). Each accordion item can contain multiple sub-nodes (cards, tables, lists, file-trees).
- **Diff color language**: Use `badge` and `callout` variants to convey meaning — `success` for added/good, `danger` for removed/bad, `warning` for modified/ugly, `info` for neutral/question.
- **Prose density**: Keep top-level paragraphs under roughly 100 Chinese characters or 70 English words. Move detailed evidence into lists or the reference accordion.
- **KPI semantics**: A trend arrow means directional change, not quality. Use `variant` to express success/warning/danger when a value has evaluative meaning.

### Available node types for context

Refer to the `create_visual_artifact` tool's `nodes` parameter for the full list. Key types for diff reviews:

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
| `file-tree` | Nested file tree with optional `status` (added/modified/deleted) |
| `accordion` | Collapsible groups (use for reference sections 6-10) |
| `section` | Untitled section container |

### Mermaid guidelines (always follow)

- Always use double-quoted labels: `N["label text"]` not `N[label text]`
- Never use parentheses `()` inside unquoted labels
- Apply `:::` class on a separate line, NOT inline
- Keep diagram type simple: `flowchart LR`, `sequenceDiagram`, `stateDiagram-v2`

After assembling the full `spec` object, call `create_visual_artifact` with `slug`, `title`, `artifactType`, and `description` from `spec`, plus `nodes: JSON.stringify(spec.nodes)` and `data: JSON.stringify(spec.data)` when `spec.data` exists.

Example:

```ts
const spec = {
  slug: "diff-review-<YYYY-MM-DD>-<topic>",
  title: "Diff Review: <descriptive title>",
  artifactType: "review",
  description: "<optional description>",
  nodes: [
    /* ArtifactNode[] */
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

Ultrathink.

$@
