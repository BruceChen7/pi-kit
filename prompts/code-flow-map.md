---
description: Map a code flow with Visual Artifact, key data structures, blast radius, and grill-me checks
argument-hint: "[flow/module/question]"
---
Map the existing code flow for: ${@:-<ask me which flow/module/question first>}

Generate a Visual Artifact code-flow learning map via the `create_visual_artifact` tool from
`extensions/visual-artifact`. This is for understanding existing code, not implementing changes.

If no concrete flow/module/question was provided, ask me exactly one scope question and wait. Do not
start broad repo exploration until I answer.

## Mission

Help me rebuild a working mental model of one code path:

- What triggers it and where it enters the system
- Which modules/functions/types participate
- Which data structures and state transitions matter
- Which IO boundaries, side effects, adapters, env/config, clocks, or globals are involved
- What might break if this flow changes
- Where tests or verification hooks already exist
- What I should be grilled on to prove I understand it

## Investigation phase

Use source evidence first. Prefer `cs_search` to locate likely implementations, then `read` the best
files in full context. Use `rg` for exact identifiers, callers, tests, config keys, and error strings.

Gather these facts before generating the artifact:

1. **Entry points** — commands, handlers, routes, event listeners, scheduled jobs, hooks, or public
   APIs that start the flow.
2. **Main control flow** — important branches, validation, transformations, retries, fallbacks,
   early returns, and error paths.
3. **Key data structures** — domain types, DTOs, schemas, config objects, persisted records,
   in-memory state, and ownership/lifecycle rules.
4. **Boundaries and side effects** — filesystem, git, network, subprocesses, model/provider calls,
   TUI/RPC/UI interactions, databases, caches, env vars, clocks, and global state.
5. **Blast radius** — callers, downstream consumers, tests, docs, settings, package exports,
   generated files, migrations, and compatibility contracts that depend on this flow.
6. **Tests and verification** — existing test files, smoke tests, scripts, manual commands, and
   missing coverage.
7. **Gotchas** — non-obvious coupling, ordering requirements, implicit invariants, race conditions,
   stale state risks, and names that hide domain meaning.

## Verification checkpoint

Before calling `create_visual_artifact`, produce a compact fact sheet. Every claim that will appear
in the artifact must include evidence:

- `file:line` for functions, types, behavior, branches, invariants, and tests
- command output for counts or git-derived claims
- `uncertain` label for anything inferred but not verified

Do not present unsupported guesses as facts. If evidence conflicts, call out the conflict.

## Artifact structure

Build a `spec` object and call `create_visual_artifact` with:

- `slug`: `code-flow-map-<topic-slug>`
- `title`: `Code Flow Map: <topic>`
- `artifactType`: `explainer`
- `description`: one sentence naming the investigated flow and repo
- `topics`: comma-separated tags such as `code-flow,<topic>,learning`
- `nodes`: `JSON.stringify(spec.nodes)`
- `data`: `JSON.stringify(spec.data)` only when useful

Keep the artifact under Visual Artifact limits: max 30 top-level nodes, max 100 total nodes. Fold
detailed reference material into `accordion` nodes.

### Section-to-node mapping

| # | Section | Node types | Purpose |
|---|---------|------------|---------|
| 1 | Executive mental model | `heading`, `text`, `badge` | A short summary of what the flow does and why it exists. |
| 2 | Flow dashboard | `kpi-grid` | 4-6 metrics: entry points, key modules, data types, side effects, tests, risk flags. |
| 3 | Control-flow diagram | `mermaid` | Main path plus important branches and failure paths. |
| 4 | Data/state map | `mermaid` or `table` | Key structures, owners, lifecycle transitions, and persistence boundaries. |
| 5 | Boundary map | `table` + `badge` | IO/adapters/side effects with risk level and evidence. |
| 6 | Blast radius | `file-tree` or `table` | Callers, dependents, tests, docs, config, compatibility surface. |
| 7 | Walkthrough | `timeline` or `accordion` | Step-by-step execution with file/function references. |
| 8 | Tests and gaps | `table`, `callout` | Existing coverage and missing verification. |
| 9 | Gotchas and invariants | `accordion`, `card`, `list` | What must stay true, and what is easy to misunderstand. |
| 10 | Grill-me starter | `callout` or `card` | The first question you will ask me after creating the artifact. |

### Compact spec shape

```ts
const spec = {
  slug: "code-flow-map-<topic-slug>",
  title: "Code Flow Map: <topic>",
  artifactType: "explainer",
  description: "Evidence-backed map of <topic> in <repo>.",
  nodes: [
    { "type": "heading", "props": { "text": "Code Flow Map: <topic>", "level": "h1" } },
    { "type": "text", "props": { "text": "<one-paragraph mental model>", "size": "xl" } },
    { "type": "kpi-grid", "props": { "columns": 3, "items": [] } },
    { "type": "mermaid", "props": { "definition": "flowchart LR\n  A[\"Entry\"] --> B[\"Core step\"]" } },
    { "type": "mermaid", "props": { "definition": "flowchart TB\n  D[\"DTO\"] --> S[\"State\"]" } },
    { "type": "accordion", "props": { "items": [
      { "title": "Boundary Map", "nodes": [] },
      { "title": "Blast Radius", "nodes": [] },
      { "title": "Walkthrough", "nodes": [] },
      { "title": "Tests and Gaps", "nodes": [] },
      { "title": "Gotchas and Invariants", "nodes": [] }
    ] } },
    { "type": "callout", "props": {
      "title": "Grill-me starter",
      "text": "<first comprehension question>",
      "variant": "info"
    } }
  ]
};

create_visual_artifact({
  slug: spec.slug,
  title: spec.title,
  artifactType: spec.artifactType,
  description: spec.description,
  topics: "code-flow,<topic>,learning",
  nodes: JSON.stringify(spec.nodes),
  data: spec.data ? JSON.stringify(spec.data) : undefined,
});
```

## Visual Artifact and Mermaid rules

- Use Visual Artifact nodes, not standalone HTML.
- Do not use `plannotator_auto_submit_review`.
- Do not open a browser directly; the Visual Artifact tool handles the window.
- Use compact Mermaid diagrams; prefer one control-flow diagram and one data/state diagram.
- Always use double-quoted Mermaid labels: `N["label text"]`, not `N[label text]`.
- Never use parentheses inside unquoted labels.
- Apply Mermaid `:::` classes on separate lines, not inline.
- Keep top-level prose short; move evidence and details into accordions.

## Grill me after the artifact

After the artifact is created, ask me exactly one comprehension question and wait for my answer.
Use this format, in my language:

```text
问题：...

我的建议：...

为什么：...
```

Start with the highest-leverage question: the one misconception that would most likely cause a bad
change to this flow. Do not ask multiple questions at once.

Ultrathink.

$@
