---
name: plan-code-review
description: >
  Review changes since a fixed point along two axes — Standards (does the diff follow this
  repo's documented standards?) and Spec (does the diff implement the originating plan, PRD,
  issue, or user request?). Use when the user wants to review a branch, PR, work-in-progress
  changes, or asks to "review since X".
---

# Plan Code Review

Run a Pi-native two-axis review of the diff between `HEAD` and a fixed point.

This skill reports findings; it does **not** auto-fix code. Use
`planning-suite/pre-landing-review` when the user wants a merge-readiness risk pass with safe
auto-fixes.

Default to Chinese unless the user explicitly asks for another language.

## Axes

- **Standards** — does the diff follow documented project standards, architecture decisions,
  domain language, style expectations, and Pi workflow rules?
- **Spec** — does the diff faithfully implement the originating issue, PRD, plan, spec, or user
  request?

Keep the axes separate. Do not merge, average, or rerank the two reports.

## Process

### 1. Pin the fixed point

Use exactly the fixed point the user supplied: branch, commit, tag, `main`, `HEAD~5`, or similar.
If they did not specify one, ask:

```text
Review against what — a branch, commit, tag, or main?
```

Do not proceed until the fixed point is clear.

Capture these commands for the review:

```bash
git diff --no-ext-diff <fixed-point>...HEAD
git log <fixed-point>..HEAD --oneline
```

Use the three-dot diff so the comparison is against the merge base. Always include
`--no-ext-diff`.

### 2. Identify the spec source

Look for the originating requirements in this order:

1. A path supplied by the user.
2. Issue or PR references in commit messages.
3. `.pi/plans/<repo>/specs/**` files matching the branch, feature, or changed area.
4. `.pi/plans/<repo>/plan/**` files matching the branch, feature, or changed area.
5. `docs/`, `specs/`, `.scratch/`, or `TODOS.md` if the repo uses them.
6. If nothing is found, ask the user where the spec is. If there is no spec, report
   `no spec available` under the Spec axis.

### 3. Identify standards sources

Collect documented standards and conventions before reading the diff deeply. Common sources:

- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`
- `.pi/contexts/CONTEXT.md`, `.pi/contexts/CONTEXT-MAP.md`, and
  `.pi/contexts/<context-id>/CONTEXT.md`
- `.pi/contexts/**/adr/*.md`
- `.pi/plans/**` when it contains accepted process constraints
- `STYLE.md`, `STANDARDS.md`, `STYLEGUIDE.md`, or similar docs
- `.editorconfig`, `biome.json`, `eslint.config.*`, `prettier.config.*`, `tsconfig.json`

For machine-enforced standards, note the source but do not duplicate what tooling already checks
unless the diff obviously bypasses or contradicts it.

### 4. Read the diff and related files

Read the full diff first. Then read related files outside the diff only when needed to verify:

- existing module boundaries and public interfaces
- state transitions and data flow
- domain terminology
- tests that define expected behavior
- nearby patterns the diff claims to follow

### 5. Report separately

Use this final format:

```md
## Standards

- [severity] file/path:line — finding. Cite the documented standard.

## Spec

- [severity] file/path:line — finding. Quote or cite the requirement.

## Summary

Standards: <count> findings. Spec: <count> findings. Worst issue: <one line or none>.
```

Severity values:

- `blocking` — likely wrong behavior, broken workflow, or hard standards violation
- `non-blocking` — should be fixed, but does not prevent landing
- `question` — needs user or product judgment

If an axis has no findings, say so explicitly. If the Spec axis has no source, do not invent
requirements; state `no spec available` and only review against observable intent if the user
provided one in conversation.
