---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
---

# Grilling

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Default to Chinese for questions, recommendations, and summaries unless the user explicitly asks for another language.

## Rules

- Ask **one question at a time** and wait for the user's answer before continuing. Asking multiple questions at once is bewildering.
- For each question, include your recommended answer and why.
- **Facts vs decisions.** If a question is a *fact* that can be found by exploring the codebase, docs, or git history, look it up rather than asking the user. If it's a *decision*, put it to the user with your recommendation and wait for their answer before continuing.
- Challenge contradictions, overloaded terms, unclear success criteria, and hidden trade-offs.
- Do not implement from this skill directly — grilling is for planning, not building.
- Do not enact the plan until the user confirms we have reached a shared understanding.

## Relationship to other skills

`/grill-me` and `/grill-with-docs` both delegate to this skill for the core interview loop, but each adds its own discipline:

- **`/grill-me`** — lightweight, stateless grilling for standalone plans with no codebase.
- **`/grill-with-docs`** — grilling grounded in a codebase, with inline domain glossary and ADR updates via `/domain-modeling`.

## Attribution

Adapted from the `grilling` skill in https://github.com/mattpocock/skills (v1.1.0+) under the MIT License.
