---
name: zero-tech-debt
description: >
  Use when implementing, reviewing, or refactoring a change that has accumulated compatibility cruft,
  migration leftovers, feature-flag branches, accidental abstractions, or "temporary" code. Rework the
  change as if the intended UX and architecture had existed from day one, deleting obsolete paths and
  preserving only intentional compatibility boundaries.
---

# Zero Tech Debt

## Intent

Treat the current desired product and architecture as the starting point, not as a patch layered on top
of old decisions. Your job is to make the final state look inevitable: clear UX, direct data flow,
minimal branches, and no fossilized implementation history unless the compatibility need is explicit.

This skill is useful near the end of a feature, migration, or refactor, when the code works but still
carries scaffolding from how it got there.

## When to Use

Use this skill when:

- a change has fallback paths, feature flags, transitional adapters, duplicated models, or temporary
  names that are no longer needed,
- the implementation reveals the sequence of development rather than the intended final design,
- the user asks to remove tech debt, polish a feature, simplify after migration, or make code look like
  it was designed this way from the beginning,
- a PR is correct but feels harder to explain than the product behavior it supports.

Do not use this skill to delete compatibility that users, data migrations, external APIs, or rollout
plans still require. First prove the old path is obsolete.

## Workflow

1. **Name the intended final state**
   - Describe the UX, API, data model, or architecture that should exist now.
   - Identify which behavior is intentional and which behavior only exists because of history.

2. **Separate real constraints from fossils**
   - Keep constraints with current product, operational, or compatibility value.
   - Mark old branches, aliases, flags, adapters, duplicated schemas, and migration glue as removal
     candidates.

3. **Rewrite from the destination backward**
   - Prefer one canonical path over layered conditionals.
   - Rename concepts to match the final domain language.
   - Collapse transitional abstractions once they no longer hide meaningful complexity.
   - Delete dead tests that only assert old scaffolding; keep or add tests for the intended contract.

4. **Check safety before deletion**
   - Search for external callers, persisted data, configuration, dashboards, docs, and rollout hooks.
   - Confirm migrations have completed or provide a small, explicit migration boundary.
   - If compatibility must remain, isolate it behind a named adapter with an owner and removal trigger.

5. **Verify the result reads like first-principles design**
   - A new reader should understand what the system does without learning the migration story first.
   - The shortest explanation of the code should match the intended product behavior.

## Review Checklist

Ask these questions before finishing:

- What would this code look like if we had built only the current desired behavior?
- Which branches exist because of real product states, and which exist because of rollout history?
- Are there two names, shapes, or APIs for one concept?
- Can old compatibility be deleted now? If not, is its owner and removal condition explicit?
- Do tests protect the final contract rather than the temporary path?

## Response Format

When reporting work, include:

1. The intended final state.
2. What historical cruft was removed or intentionally kept.
3. What safety checks were performed before deletion.
4. What verification ran and any remaining compatibility risk.
