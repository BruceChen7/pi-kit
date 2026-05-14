---
name: to-prd
description: Use when the user wants to turn the current conversation, plan, or design context into a PRD for Pi planning, reviewed specs, or optional issue-tracker publication.
---

# To PRD

Turn the current conversation context and codebase understanding into a PRD. Do **not** interview the user from scratch; synthesize what is already known. Ask only for blockers that cannot be inferred.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native output

Primary output is a reviewed Pi spec, not an immediate external issue:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

Use a slug that makes the artifact obviously PRD-related, e.g. `2026-05-06-checkout-prd-design.md`. This path should trigger `plannotator-auto` spec review.

Only publish to GitHub/Jira/Linear/etc. when the user explicitly asks or the repo has a clear configured issue tracker workflow. If publishing externally, still create the reviewed Pi spec first unless the user says not to.

## Context sources

Read when relevant:

- `AGENTS.md` or equivalent repo instructions
- existing plan/spec files under `.pi/plans/<repo>/`
- domain language under `.pi/contexts/CONTEXT.md`, `.pi/contexts/CONTEXT-MAP.md`, or `.pi/contexts/<context-id>/CONTEXT.md`
- ADRs under `.pi/contexts/adr/` or `.pi/contexts/<context-id>/adr/`
- relevant code paths and prior tests

Do not create root `CONTEXT.md`, `docs/adr/`, or product docs in source directories from this skill.

Treat `.pi/contexts/**/CONTEXT.md` as a domain glossary only. Do not put PRD content,
implementation plans, file-path-level designs, temporary notes, or technical decisions there.
Put feature requirements in `.pi/plans/<repo>/specs/**`, implementation plans in
`.pi/plans/<repo>/plan/**`, and hard-to-reverse decisions in ADRs.

## Process

1. **Explore enough context**
   - Understand current code shape if not already explored.
   - Use `.pi/contexts/**/CONTEXT.md` vocabulary throughout.
   - Respect ADRs under `.pi/contexts/**/adr/`.

2. **Sketch implementation modules**
   - Identify major **modules** likely to be built or modified.
   - Look for opportunities to create deep modules: lots of behavior behind a simple, testable interface.
   - Check with the user that these modules match expectations and ask which modules need tests.

3. **Write the PRD spec**
   - Write to `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`.
   - Wait for `plannotator-auto` review feedback and address annotations.

4. **Optional publish**
   - If the user wants an external issue, publish the approved PRD to the configured tracker.
   - Apply the repo's triage label if one is known; otherwise ask.

## PRD template

```md
# <Feature / PRD title>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list of user stories:

1. As an <actor>, I want a <feature>, so that <benefit>.

Cover the full feature surface, including edge cases and non-happy paths.

## Implementation Decisions

- Modules that will be built or modified
- Interfaces that may change
- Technical clarifications
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Avoid file paths and code snippets unless they are essential; they become stale quickly.

## Testing Decisions

- What good tests assert: external behavior, not implementation details
- Which modules will be tested
- Existing similar tests to follow
- Verification commands or manual checks

## Documentation Decisions

- `.pi/contexts/**/CONTEXT.md` terms to add/update, if any
- `.pi/contexts/**/adr/` records to create, if any

## Out of Scope

Explicitly deferred work.

## Further Notes

Open questions, risks, rollout notes, or follow-ups.
```
