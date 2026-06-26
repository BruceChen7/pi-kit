---
name: grill-with-docs
description: Use when the user wants to stress-test a plan, feature idea, or technical design against an existing codebase, domain language, CONTEXT.md, ADRs, or Pi planning workflow before implementation.
---

# Grill With Docs

## Purpose

Run a rigorous plan-grilling session grounded in the repository's code, domain language, and documented decisions. The goal is shared understanding before implementation, plus lightweight documentation updates as terms and decisions crystallise.

Default to Chinese for questions, specs, plans, and summaries unless the user explicitly asks for another language.

## Hard Rules

- Run a `/grilling` session for the core interview discipline.
- Run the `/domain-modeling` skill to build and sharpen the project's domain model inline.
- Do not start implementation from this skill. End by producing reviewed planning artifacts when the user wants to proceed.
- Keep pure interview sessions lightweight: if there are no file edits, code changes, or architectural commitments, the `AGENTS.md` skill-only exception applies and no plan file is required.
- Store domain docs under `.pi/contexts/`; do not create `CONTEXT.md` or ADR files in application source directories.
- Treat `.pi/contexts/**/CONTEXT.md` as a domain glossary only, not a wiki, spec,
  implementation plan, scratchpad, rollout note, file-path design, temporary note, or repository
  for technical decisions.
- The moment you will edit repository files (`.pi/contexts/**`, specs, plans, or code), enter the Pi plan workflow.

## Pi Workflow Integration

1. **Pure grilling only**
   - No plan file is required if the user only wants questions and discussion.
   - Still inspect the repo when needed.

2. **Documentation or implementation preparation**
   - Before editing repo docs or preparing implementation, write a plan file:
     `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`
   - The plan must use the structure required by `AGENTS.md`:
     - `## Context`
     - `## Steps`
     - `## Verification`
     - `## Review`

3. **Design/spec handoff**
   - When the grilling session resolves into a design, write the spec to:
     `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

4. **Implementation plan handoff**
   - If the user approves the spec and wants implementation, write/update:
     `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`
   - Keep steps outcome-oriented and verifiable.
   - Wait for plan review feedback before implementation.


## Process

### 1. Establish context

- Read project instructions (`AGENTS.md`, `CLAUDE.md`, or equivalent).
- Check for domain docs under `.pi/contexts/`:
  - `.pi/contexts/CONTEXT.md`
  - `.pi/contexts/CONTEXT-MAP.md`
  - `.pi/contexts/<context-id>/CONTEXT.md`
  - `.pi/contexts/adr/` or `.pi/contexts/<context-id>/adr/`
- Inspect the relevant code paths before asking questions when code can answer the question.
- If `.pi/contexts/CONTEXT-MAP.md` exists, use it to locate the relevant bounded context. If unclear, ask which context the plan belongs to.

### 2. Grill the plan

Run a `/grilling` session to walk the design tree. Use the `/domain-modeling` skill — `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` from `/domain-modeling` — to keep the domain model current as you go.

Question format:

```text
问题：...

我的建议：...

为什么：...
```

### 3. Update domain language inline

When a term or relationship is resolved, update the appropriate `.pi/contexts/**/CONTEXT.md` immediately via `/domain-modeling`. Do not batch resolved terminology until the end.

Create `.pi/contexts/CONTEXT.md` or `.pi/contexts/<context-id>/CONTEXT.md` lazily only when there is a real resolved term to record. Put implementation decisions in `.pi/plans/**` or ADRs, not in `CONTEXT.md`.

### 4. Offer ADRs sparingly

Offer an ADR only when all three are true (see `/domain-modeling` for the full guidance):

1. **Hard to reverse** — changing later is meaningfully costly.
2. **Surprising without context** — future readers would wonder why.
3. **Real trade-off** — there were genuine alternatives.

ADRs live in the selected `.pi/contexts/**/adr/` directory and use sequential numbering like `0001-short-slug.md`. Use `.pi/contexts/adr/` for single-context or cross-context decisions; use `.pi/contexts/<context-id>/adr/` next to the relevant `.pi` `CONTEXT.md` for context-specific decisions. Create the directory lazily only when the first ADR is needed.

### 5. Produce the handoff artifact

When the user says the grilling is complete, summarize the resolved design and ask whether to create a spec.

The spec should include:

- problem and desired outcome
- domain terms resolved or changed
- affected modules / boundaries
- proposed architecture and data flow
- edge cases and out-of-scope items
- ADRs proposed or created
- verification strategy
- open questions, if any

Write it to `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

## Dependency Files

This skill depends on the `/domain-modeling` skill for:

- `CONTEXT-FORMAT.md` — domain glossary structure and rules
- `ADR-FORMAT.md` — ADR template and offering guidance

Read those files from `/domain-modeling` before creating or editing `.pi/contexts/**/CONTEXT.md` or ADR files.
