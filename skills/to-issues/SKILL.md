---
name: to-issues
description: Use when the user wants to break a PRD, plan, spec, or conversation into independently-grabbable implementation issues, local Pi issue files, or optional external issue-tracker tickets.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets). Each slice should be narrow but complete enough to demo or verify independently.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native output

Primary reviewed output is an issue-breakdown spec:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-issues-design.md`

This path should trigger `plannotator-auto` spec review because it ends with `-design.md`.

After review approval, create local issue files under:

`.pi/plans/<repo>/issues/<topic-slug>/NN-<issue-slug>.md`

Do not create issue files in source directories. Only publish to GitHub/Jira/Linear/etc. when the user explicitly asks or the repo has a clear configured issue tracker workflow.

## Process

### 1. Gather context

Work from the current conversation context. If the user passes a file path, PRD, spec, URL, or issue reference, fetch/read the full content and comments when available.

Read when relevant:

- `AGENTS.md` or equivalent repo instructions
- `.pi/plans/<repo>/specs/` and `.pi/plans/<repo>/plan/`
- `.pi/contexts/**/CONTEXT.md` as glossary only, not as issue/spec/implementation storage
- `.pi/contexts/**/adr/`
- relevant code paths if needed for dependencies or vertical slicing

### 2. Draft vertical slices

Break the work into **tracer bullet** issues. Each issue is a thin vertical slice through all necessary integration layers, not a horizontal slice of one layer.

Rules:

- Each slice delivers a narrow but complete path through the system.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over a few thick ones.
- Prefer `AFK` over `HITL` when safe.

Types:

- `AFK` — can be implemented and merged without human interaction.
- `HITL` — requires a human decision, design review, external credential, or architectural approval.

### 3. Quiz the user

Present the proposed breakdown as a numbered list. For each slice show:

- **Title**
- **Type**: HITL / AFK
- **Blocked by**
- **User stories covered** if the source material has them
- **Verification**

Ask:

- Does the granularity feel right: too coarse, too fine, or correct?
- Are dependencies correct?
- Should any slices be merged or split?
- Are HITL/AFK labels correct?

Iterate until the user approves.

### 4. Update durable language and decisions inline

Before writing the final issue-breakdown spec, handle any durable records that the breakdown
crystallized:

- update `.pi/contexts/**/CONTEXT.md` for resolved domain terms, relationships, avoided aliases,
  or ambiguities
- propose or create an ADR in `.pi/contexts/**/adr/` for hard-to-reverse, surprising trade-offs
  with real alternatives
- do not leave confirmed glossary or ADR material only inside issue bodies

### 5. Write reviewed issue-breakdown spec

Write the approved breakdown to:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-issues-design.md`

Include:

- source PRD/spec reference
- dependency graph
- approved issue list
- publish target: local `.pi` files or external tracker
- risks and open questions

Wait for `plannotator-auto` review feedback and address annotations.

### 6. Create local issues or publish externally

Default local issue path:

`.pi/plans/<repo>/issues/<topic-slug>/NN-<issue-slug>.md`

Publish/create in dependency order so blockers can be referenced.

If publishing externally:

- ask for the tracker if unclear
- ask for labels if unclear
- preserve the local reviewed breakdown as the source of truth
- do not close or modify a parent issue unless the user explicitly asks

## Local issue template

```md
# <Issue title>

## Parent

Reference to the parent PRD/spec/issue, if any.

## Type

AFK or HITL.

## What to build

A concise end-to-end description of this vertical slice. Describe behavior, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Verification

Commands, checks, or manual review needed to prove the slice works.

## Blocked by

- None — can start immediately

Or references to blocking local/external issues.
```
