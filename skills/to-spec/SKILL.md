---
name: to-spec
description: Use when the user wants to turn the current conversation, plan, or design context into a reviewed spec for Pi planning, or optional issue-tracker publication.
---

# To Spec

Turn the current conversation context and codebase understanding into a spec (you may know this document as a PRD). Do **not** interview the user from scratch — just synthesize what is already known. Ask only for blockers that cannot be inferred.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native output

Primary output is a reviewed Pi spec, not an immediate external issue:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

Use a slug that makes the artifact obviously spec-related, e.g. `2026-05-06-checkout-spec-design.md`.

Only publish to GitHub/Jira/Linear/etc. when the user explicitly asks or the repo has a clear configured issue tracker workflow. If publishing externally, still create the reviewed Pi spec first unless the user says not to.

## Context sources

Read when relevant:

- `AGENTS.md` or equivalent repo instructions
- existing plan/spec files under `.pi/plans/<repo>/`
- domain language under `.pi/contexts/CONTEXT.md`, `.pi/contexts/CONTEXT-MAP.md`, or `.pi/contexts/<context-id>/CONTEXT.md`
- ADRs under `.pi/contexts/adr/` or `.pi/contexts/<context-id>/adr/`
- relevant code paths and prior tests

Do not create root `CONTEXT.md`, `docs/adr/`, or product docs in source directories from this skill.

Treat `.pi/contexts/**/CONTEXT.md` as a domain glossary only. Do not put spec content,
implementation plans, file-path-level designs, rollout notes, temporary notes, UI copy drafts,
or technical decisions there. Put feature requirements in `.pi/plans/<repo>/specs/**`,
implementation plans in `.pi/plans/<repo>/plan/**`, and hard-to-reverse decisions in ADRs.

## Process

### 1. Explore enough context

- Understand current code shape if not already explored.
- Use `.pi/contexts/**/CONTEXT.md` vocabulary throughout.
- Respect ADRs under `.pi/contexts/**/adr/`.

### 2. Sketch test seams

- Identify the **seams** at which the feature will be tested. Existing seams should be preferred
  to new ones. Use the highest seam possible (closest to the user-facing behavior).
- If new seams are needed, propose them at the highest point you can. The fewer seams across
  the codebase, the better — the ideal number is one.
- Then identify the major **modules** likely to be built or modified behind those seams.
- Look for opportunities to create deep modules: lots of behavior behind a simple, testable
  interface.
- Check with the user that these seams and modules match expectations, and ask which modules
  need tests.

### 3. Update durable language and decisions inline

- If the spec crystallizes domain terms, relationships, avoided aliases, or ambiguities, update
  the relevant `.pi/contexts/**/CONTEXT.md` before writing the final spec.
- If the spec contains a hard-to-reverse, surprising trade-off with real alternatives, propose
  or create an ADR in `.pi/contexts/**/adr/` rather than only listing it in the spec.

### 4. Write the spec

Write to `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md` using the template below.

### 5. Optional publish

If the user wants an external issue, publish the approved spec to the configured tracker.

<spec-template>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending.
</user-story-example>

This list of user stories should be extensive and cover all aspects of the feature, including edge cases and non-happy paths.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets — they become stale quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Documentation Decisions

- `.pi/contexts/**/CONTEXT.md` terms to add/update, if any
- `.pi/contexts/**/adr/` records to create, if any

## Out of Scope

Explicitly deferred work.

## Further Notes

Open questions, risks, rollout notes, or follow-ups.

</spec-template>

## Attribution

Adapted from the `to-spec` skill in https://github.com/mattpocock/skills (v1.1.0+) under the MIT License.
