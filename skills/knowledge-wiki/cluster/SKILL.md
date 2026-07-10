---
name: knowledge-wiki-cluster
description: >
  Find groups of concepts that share an implied parent slug and handle them: if the parent
  does not exist, create it; if it already exists, link unconnected children to it. For
  each child, fold (merge content into parent and delete child), link (keep as standalone,
  linked to parent), or merge into a sibling that already covers its content. Run after
  accumulating new concepts or when the wiki has clusters of narrowly-named sub-concepts
  without a parent.
---

# Knowledge Wiki Cluster

Detect clusters of concepts that share an implied parent slug, then decide for each child whether to **fold** (merge content into parent and delete the child) or **link** (keep the child as a standalone concept linked to the parent). The goal is to reduce total concept count by absorbing thin, redundant, or retired sub-concepts into a parent article.

Two cluster types are handled:
- **New-parent** (`parentExists: false`): the implied parent concept does not exist yet — create it, then fold/link/merge children.
- **Existing-parent** (`parentExists: true`): the implied parent already exists and these children have not yet been dismissed — fold/link/merge each one.

## Dependencies

- `./candidates.mjs` — candidate detection (find-implied-parent-concepts)
- `./wiki-state.mjs` — state tracking (dismiss-pair, prune-cluster-pairs)
- `../state/wiki-index.mjs` — index management (upsert-concept)
- `../concept/wiki-concept.mjs` — concept management (create, insert-connected-concept, insert-source, delete-connected-concept)
- `./lib/` — local helper modules for this skill
- qmd knowledge base with `Wiki/Concepts/` directory

## Path Resolution

Resolve every local path (`./*.mjs`, `../state/*.mjs`, `../concept/*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/cluster/`
- `./candidates.mjs` resolves to `skills/knowledge-wiki/cluster/candidates.mjs`
- `./wiki-state.mjs` resolves to `skills/knowledge-wiki/cluster/wiki-state.mjs`
- `../state/wiki-index.mjs` resolves to `skills/knowledge-wiki/state/wiki-index.mjs`
- `../concept/wiki-concept.mjs` resolves to `skills/knowledge-wiki/concept/wiki-concept.mjs`
- `./lib/` resolves inside the same skill directory

## Steps

### 1. Establish the working directory

The knowledge base root is the Git repository root. Run `git rev-parse --show-toplevel` and store the result as `KNOWLEDGE_PATH`.

Use `KNOWLEDGE_PATH` for all subsequent steps. Append `--base-path "{KNOWLEDGE_PATH}"` to every `node ./...` command that accepts it.

### 2. Find clusters

```bash
node ./candidates.mjs find-implied-parent-concepts --base-path "{KNOWLEDGE_PATH}"
```

This outputs `{ "clusters": [...] }` sorted **deepest first** (most hyphens in `impliedParent`), with ties broken by cluster size descending. Both new-parent and existing-parent clusters are interleaved in this single ordering. Each entry has:
- `impliedParent` — the parent slug
- `children` — array of `{ path, dismissed }` objects, where `path` is the concept file path (e.g. `Wiki/Concepts/audi-etron.md`) and `dismissed` is `true` if this child was previously dismissed from this cluster pair, `false` otherwise
- `parentExists` — `false` if the parent concept needs to be created; `true` if it already exists

A cluster appears only when it has at least the usual number of `dismissed: false` children (≥2 for new-parent, ≥1 for existing-parent). Previously dismissed children are included with `dismissed: true` as potential Anchor targets for sibling merges.

Derive each child's slug from its `path` field: `Wiki/Concepts/audi-etron.md` → `audi-etron`. Use this slug wherever `{child-slug}` appears below.

If the `clusters` array is empty, print `No clusters found.` and stop.

### 3. LLM pre-filter

For **new-parent clusters only** (`parentExists: false`), auto-dismiss clusters where the implied parent is a common English modifier rather than a meaningful proper noun or specific topic — e.g. `smart` grouping `smart-home` with `smart-money`, or `the` grouping `the-economist` with `the-expanse`. Children spanning clearly unrelated domains are a reliable signal for auto-dismissal. Skip this filter for existing-parent clusters — the parent's existence already confirms it is a real topic.

For each auto-dismissed cluster, run once per child:

```bash
node ./wiki-state.mjs dismiss-pair knowledge-wiki-cluster "Wiki/Concepts/{impliedParent}.md" "Wiki/Concepts/{child-slug}.md" --base-path "{KNOWLEDGE_PATH}"
```

Be conservative — wrongly dismissed pairs require manually editing `Wiki/.state.json` to recover.

### 4. Present and resolve each cluster

Process one cluster at a time. Use a **separate interaction for each cluster**.

Maintain an **in-memory processed set** of `impliedParent` slugs handled in this session. After creating a parent, exclude already-processed slugs from the refreshed cluster list.

---

#### 4a. Read, summarize, and assess

Determine the **Display Name** for the implied parent:
- If `parentExists` is `true`, read the parent concept file and take the Display Name from its H1 heading (`# …`).
- If `parentExists` is `false`, derive a human-readable name from the slug (e.g. `audi` → `Audi`, `apple-watch` → `Apple Watch`).

Read every child concept file, then classify each one in two passes:

1. **Fold vs. Anchor.** `dismissed: true` children are **Anchors** automatically. For `dismissed: false` children, independently judge each as a **Fold-candidate** (thin, narrow, or low-standalone-value — would fold into the parent) or an **Anchor** (substantive: rich prose, multiple sources, or broad cross-links — would stay standalone).
2. **Sibling merges.** For each `dismissed: false` Fold-candidate, check whether its content is a **strict subset** of any Anchor's content in the same cluster. If so, recommend **Merge into `{anchor-slug}`** instead of Fold.

Present a cluster summary as a normal assistant message (not in a code block):

---
**Cluster: {Display Name}  ({N} children, {existing parent | new parent})**

| Child | Description | Recommendation |
|-------|-------------|----------------|
| `{child-slug}` | {one-sentence description} | **Fold** — {reason} |
| `{child-slug}` *(dismissed)* | {one-sentence description} | **Link** — previously dismissed; auto-classified as Anchor |
| `{child-slug}` | {one-sentence description} | **Merge into `{anchor-slug}`** — {reason} |

---

Then write 1–2 sentences of reasoning.

#### 4b. Ask what to do

Render the summary, reasoning, numbered options, and reply instructions as one normal markdown message, then wait for the user's reply.

**If `parentExists` is `false`:**

| # | Option | Description |
|---|--------|-------------|
| 1 | `Proceed` | Create "{Display Name}" and apply the recommendations above (fold, link, or merge into a sibling) |
| 2 | `Link all` | Create "{Display Name}" and link all children to it, keeping them standalone |
| 3 | `Fold all` | Create "{Display Name}" and fold every child into it |
| 4 | `Dismiss` | These don't belong together; never show this cluster again |

Accept 1, 2, 3, or 4; also accept `skip`, `review one by one`, or `stop`.

**If `parentExists` is `true`:**

| # | Option | Description |
|---|--------|-------------|
| 1 | `Proceed` | Ensure bidirectional links to "{Display Name}" and apply the recommendations above |
| 2 | `Link all` | Link all children to "{Display Name}" but keep them standalone |
| 3 | `Fold all` | Link all children to "{Display Name}" and fold every child into it |
| 4 | `Dismiss` | The slug prefix is coincidental; never show this cluster again |

Accept 1, 2, 3, or 4; also accept `skip`, `review one by one`, or `stop`.

---

#### 4c. Executing decisions

Do not create or edit any files until all decisions are collected.

**If Proceed:** Record the 4a table recommendations as final decisions. Proceed to **Execute**.

**If Link all:** Record every `dismissed: false` child as Link, overriding sibling-merge or fold recommendations. Proceed to **Execute**.

**If Fold all:** Record every `dismissed: false` child as Fold, overriding sibling-merge recommendations. `dismissed: true` children are never folded. Proceed to **Execute**.

**If Review one by one:** Process sibling-merge candidates first, then remaining children one at a time. For each, present recommendation and ask:

| # | Option | Description |
|---|--------|-------------|
| 1 | `Fold "{child}" into "{Display Name}"` | Merge child's content into parent, then delete child |
| 2 | `Link "{child}"` | Keep child standalone; will be linked to parent |

Accept 1, 2, `done`, or `stop`.

**If `stop`:** Exit without creating any files.

**Execute:**

If creating a new parent (parentExists is false and at least one child will be Folded or Linked):

1. Create the parent:
   ```bash
   node ../concept/wiki-concept.mjs create "{impliedParent}" "{Display Name}" --type Synthesis --icon notepad --base-path "{KNOWLEDGE_PATH}"
   ```
2. Read the file, insert a 1–3 paragraph topic overview. Update tags with union of child tags.
3. Update the index:
   ```bash
   node ../state/wiki-index.mjs upsert-concept "{impliedParent}" "{Display Name}" "{one-line English description}" --base-path "{KNOWLEDGE_PATH}"
   ```

**Execute sibling merges** (merge Fold-candidate into Anchor):

For each child whose outcome is Merge into `{anchor-slug}`, follow the merge-3c process from the `knowledge-wiki-merge` skill:
- primary = anchor, secondary = child
- Use `../concept/wiki-concept.mjs` for insert-source, insert-connected-concept
- Use `./wiki-backlinks.mjs update-after-merge` for backlinks (in the merge directory)
  → Run `node ../merge/wiki-backlinks.mjs update-after-merge ...`

Actually, since the backlinks script is in the merge directory, reference it directly:
```bash
node ../merge/wiki-backlinks.mjs update-after-merge \
  "Wiki/Concepts/{secondary-slug}.md" \
  "Wiki/Concepts/{primary-slug}.md" \
  "{primary display name}" \
  --base-path "{KNOWLEDGE_PATH}"
```

**Link children bidirectionally:**

For each `dismissed: false` child with final outcome Link:
```bash
node ../concept/wiki-concept.mjs insert-connected-concept "{impliedParent}" "{child-slug}" "{child-display-name}" --base-path "{KNOWLEDGE_PATH}"
node ../concept/wiki-concept.mjs insert-connected-concept "{child-slug}" "{impliedParent}" "{Display Name}" --base-path "{KNOWLEDGE_PATH}"
```

Then record the pair as dismissed so it is not re-evaluated:
```bash
node ./wiki-state.mjs dismiss-pair knowledge-wiki-cluster "Wiki/Concepts/{impliedParent}.md" "Wiki/Concepts/{child-slug}.md" --base-path "{KNOWLEDGE_PATH}"
```

**Execute folds:**

For each child where Fold was chosen, follow the merge-3c process from `knowledge-wiki-merge`:
- primary = parent, secondary = child
- All path references use `../concept/wiki-concept.mjs` and `../merge/wiki-backlinks.mjs`

**Wrap up:** Add `{impliedParent}` to the in-memory processed set. Re-run step 2 and replace working cluster list with fresh output, excluding processed slugs.

---

#### 4d. If Dismiss or "skip"

**If Dismiss:** run `dismiss-pair` once per child:
```bash
node ./wiki-state.mjs dismiss-pair knowledge-wiki-cluster "Wiki/Concepts/{impliedParent}.md" "Wiki/Concepts/{child-slug}.md" --base-path "{KNOWLEDGE_PATH}"
```

**If "skip":** no state changes. Add `{impliedParent}` to the in-memory processed set for this session.

---

### 5. Print summary

```
Knowledge Wiki Cluster

Auto-dismissed {N} cluster(s) (meaningless prefix):
  - [{impliedParent}]

Created {N} concept(s):
  - {impliedParent} — {Display Name}
      Folded {Nf} child(ren): {child-slug}, ...
      Not folded {Nn} child(ren): {child-slug}, ...

Merged {N} child(ren) into sibling(s):
  - {child-slug} → {anchor-slug}

Dismissed {N} cluster(s):
  - [{impliedParent}]

Skipped {N} cluster(s).
[Omit any section with 0 items.]
```
