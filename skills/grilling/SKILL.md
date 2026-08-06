---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
---

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Default to Chinese for questions, recommendations, and summaries unless the user explicitly asks for another language.

## Work in rounds

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round. Asking the whole frontier at once is not bewildering — each question carries its own recommendation, so the user answers by number.

Each question should be formatted like so:

```text
❓ **Q1** — **<问题标题>**：<问题正文，可能是多段，包括多个选项>

➡️ <我的推荐答案，附理由>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

## Facts vs decisions

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (files, codebase, git history, docs), look it up — or dispatch a sub-agent (e.g. a herdr squad) to find it. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait — ask the rest of the frontier now. The _decisions_ are the user's — put each one to them with your recommendation and wait for their answer.

## Rules

- Challenge contradictions, overloaded terms, unclear success criteria, and hidden trade-offs.
- Do not implement from this skill directly — grilling is for planning, not building.
- Do not enact the plan until the user confirms we have reached a shared understanding.
- If the user prefers the old one-question-at-a-time rhythm — a line in the global `CLAUDE.md`/`AGENTS.md` ("grilling one question at a time"), or the user says so — fall back to asking a single frontier question per round instead.

## Relationship to other skills

`/grill-me` and `/grill-with-docs` both delegate to this skill for the core interview loop, but each adds its own discipline:

- **`/grill-me`** — lightweight, stateless grilling for standalone plans with no codebase.
- **`/grill-with-docs`** — grilling grounded in a codebase, with inline domain glossary and ADR updates via `/domain-modeling`.

## Attribution

Adapted from the `grilling` skill in https://github.com/mattpocock/skills (v1.2.0+) under the MIT License.
