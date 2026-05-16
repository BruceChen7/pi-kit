---
name: grill-with-docs
description: Use when the user wants to stress-test a plan, feature idea, or technical design against an existing codebase, domain language, CONTEXT.md, ADRs, or Pi planning workflow before implementation.
---

# Grill With Docs

## Purpose

Run a rigorous plan-grilling session grounded in the repository's code, domain language, and documented decisions. The goal is shared understanding before implementation, plus lightweight documentation updates as terms and decisions crystallise.

Default to Chinese for questions, specs, plans, and summaries unless the user explicitly asks for another language.

## Hard Rules

- Ask **one question at a time** and wait for the user's answer before continuing.
- For each question, include your recommended answer and why.
- If a question can be answered by exploring files, code, docs, or git history, investigate instead of asking.
- Challenge fuzzy terms, overloaded terms, and contradictions with existing code or docs immediately.
- Treat glossary and ADR inline updates as core behavior: once a domain term, relationship,
  avoided alias, ambiguity, or ADR-worthy decision is resolved, update or propose the durable
  record before moving on to unrelated questions.
- Do not start implementation from this skill. End by producing reviewed planning artifacts when the user wants to proceed.
- Keep pure interview sessions lightweight: if there are no file edits, code changes, or architectural commitments, the `AGENTS.md` skill-only exception applies and no plan file is required.
- Store domain docs under `.pi/contexts/`; do not create `CONTEXT.md` or ADR files in application source directories.
- Treat `.pi/contexts/**/CONTEXT.md` as a domain glossary only, not a wiki, spec,
  implementation plan, scratchpad, or repository for technical decisions.
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

Walk the design tree one decision at a time:

- clarify the user goal and success criteria
- identify actors, data, state transitions, and integration boundaries
- test edge cases with concrete scenarios
- ask what is explicitly out of scope
- compare the user's language with existing glossary terms
- compare the stated behavior with current code behavior
- surface contradictions directly and ask which source should win

Question format:

```text
问题：...

我的建议：...

为什么：...
```

### 3. Update domain language inline

When a term or relationship is resolved, update the appropriate `.pi/contexts/**/CONTEXT.md` immediately. Do not batch resolved terminology until the end.

Use `CONTEXT-FORMAT.md` for structure and rules. Key constraints:

- only include domain concepts meaningful to domain experts
- avoid general programming terms
- pick one canonical term and list avoided aliases when useful
- keep definitions to one sentence
- document relationships and flagged ambiguities
- do not include implementation steps, file-path-level designs, feature specs, temporary notes, or technical decisions

Create `.pi/contexts/CONTEXT.md` or `.pi/contexts/<context-id>/CONTEXT.md` lazily only
when there is a real resolved term to record. Put implementation decisions in `.pi/plans/**`
or ADRs, not in `CONTEXT.md`.

### 4. Offer ADRs sparingly

Offer an ADR only when all three are true:

1. **Hard to reverse** — changing later is meaningfully costly.
2. **Surprising without context** — future readers would wonder why.
3. **Real trade-off** — there were genuine alternatives.

Use `ADR-FORMAT.md`. ADRs live in the selected `.pi/contexts/**/adr/` directory and use sequential numbering like `0001-short-slug.md`. Use `.pi/contexts/adr/` for single-context or cross-context decisions; use `.pi/contexts/<context-id>/adr/` next to the relevant `.pi` `CONTEXT.md` for context-specific decisions. Create the directory lazily only when the first ADR is needed.

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

This skill depends on:

- `CONTEXT-FORMAT.md`
- `ADR-FORMAT.md`

Read those files from this skill directory before creating or editing `.pi/contexts/**/CONTEXT.md` or ADR files.
