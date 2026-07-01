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

This skill reports findings; it does **not** auto-fix code.

Default to Chinese unless the user explicitly asks for another language.

## Axes

- **Standards** — does the diff follow documented project standards, architecture decisions,
  domain language, style expectations, and Pi workflow rules? Only report issues that violate a
  documented standard or clearly contradict established repo patterns. Cite the source.
- **Spec** — does the diff faithfully implement the originating issue, PRD, plan, spec, or user
  request? Report missing requirements, partial requirements, scope creep, and behavior that
  appears implemented but wrong.

Keep the axes separate. Do not merge, average, or rerank the two reports. A change can pass
Standards while failing Spec, or pass Spec while failing Standards.

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

Use the three-dot diff so the comparison is against the merge base, not merely the current
branch tip. Always include `--no-ext-diff`. Do not silently change the user's fixed point.

### 2. Identify the spec source

Look for the originating requirements in this order:

1. A path supplied by the user.
2. Issue or PR references in commit messages.
3. `.pi/plans/<repo>/specs/**` files matching the branch, feature, or changed area.
4. `.pi/plans/<repo>/plan/**` files matching the branch, feature, or changed area.
5. `docs/`, `specs/`, `.scratch/`, or `TODOS.md` if the repo uses them.
6. If nothing is found, ask the user where the spec is. If there is no spec, report
   `no spec available` under the Spec axis. Do not invent implied requirements from the diff;
   only use observable user intent if it exists in the conversation.

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

#### Smell baseline

On top of whatever the repo documents, the Standards axis always carries the **smell baseline**
below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo
documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something
  the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"),
  never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

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
