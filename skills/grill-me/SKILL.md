---
name: grill-me
description: >-
  Use when the user wants to be grilled on a plan, design, feature idea, implementation
  approach, or trade-off; when they say "grill me", "stress-test this", "challenge this
  plan", or ask for relentless one-question-at-a-time interrogation. In this repo, match
  the Pi planning flow: inspect code/docs before asking, keep pure grilling lightweight,
  and use .pi/plans/pi-kit spec/plan review gates before file edits or implementation.
---

# Grill Me

## Purpose

Relentlessly interview the user about a plan or design until there is shared understanding.
Walk the decision tree one branch at a time, resolve dependencies between decisions, and
challenge fuzzy assumptions before implementation.

Default to Chinese for questions, recommendations, summaries, specs, and plans unless the
user explicitly asks for another language.

## Hard Rules

- Ask **one question at a time** and wait for the user's answer before continuing.
- For every question, include your recommended answer and why.
- If a question can be answered by exploring this repo's code, docs, plans, or history,
  investigate instead of asking the user.
- Challenge contradictions, overloaded terms, unclear success criteria, and hidden trade-offs.
- Do not implement from this skill directly.
- Pure grilling sessions are lightweight: if no repo files, specs, plans, or code will change,
  no plan file is required.
- The moment the conversation will create or modify repo files, specs, plans, domain docs, or
  implementation, enter the Pi planning/review flow.

## Pi Repo Flow

Use this flow in `pi-kit`:

1. **Pure grilling**
   - Inspect relevant files when they can answer a question.
   - Ask one unresolved question at a time.
   - End with a concise summary of resolved decisions, open questions, and recommended next step.

2. **Design handoff**
   - When the grilling session resolves into a design, write the spec to:
     `.pi/plans/pi-kit/specs/YYYY-MM-DD-<topic>-design.md`
   - Use the repo's required plan/spec conventions and wait for review before relying on it.

3. **Implementation handoff**
   - Before implementation or process-changing edits, write/update:
     `.pi/plans/pi-kit/plan/YYYY-MM-DD-<slug>.md`
   - Include `## Context`, `## Steps`, `## Verification`, and `## Review`.
   - Use Chinese checkbox steps.
   - If logic, state, data model, control flow, or process flow changes, include before/after
     diagrams that distinguish data changes from logic changes and mark added/removed/modified
     parts.
   - Submit the artifact for Plannotator review and address feedback before implementation.

4. **Domain-doc escalation**
   - If the grilling uncovers domain terms, ADR-worthy decisions, or context documentation needs,
     follow `grill-with-docs` for `.pi/contexts/**` and ADR handling.

## Question Format

```text
问题：...

我的建议：...

为什么：...
```

## Grilling Checklist

Walk down the design tree in this order, skipping items already answered by repo inspection:

- goal, user, and success criteria
- current repo behavior and affected modules
- data, state, lifecycle, and ownership
- control flow and integration boundaries
- failure modes, edge cases, and rollback
- testing and verification surface
- explicit non-goals
- migration, compatibility, and rollout
- whether the decision deserves a spec, plan, context update, or ADR

## Relationship to `grill-with-docs`

Use `grill-me` as the lightweight entry point for direct plan interrogation. Escalate to or
follow `grill-with-docs` when the session needs durable domain language, context maps, ADRs,
or heavier documentation maintenance.
