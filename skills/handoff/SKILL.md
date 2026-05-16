---
name: handoff
description: >
  Compact the current conversation into a handoff document so another agent can continue the
  work. Use when the user asks to hand off, summarize for the next session, preserve context,
  or prepare a continuation note.
---

# Handoff

Write a compact handoff document for a fresh agent to continue the work.

Default to Chinese unless the user explicitly asks for another language.

## Core rules

- Save the document to a path produced by `mktemp -t handoff-XXXXXX.md`.
- Read the file before writing to it, even though it should normally be empty.
- Do not duplicate content already captured in durable artifacts. Reference paths or URLs instead.
- Prefer references to `.pi/plans/**`, `.pi/contexts/**`, commit SHAs, review comments, and issue
  IDs over copied prose.
- Do not paste full specs, plans, ADRs, diffs, logs, or command output. Summarize only what the
  next agent needs and link to the durable source.
- Do not commit, push, or modify project files unless the user explicitly asks.
- If the user passed arguments, treat them as the next session's intended focus.

## What to inspect

Before writing, gather only enough context to make the next session safe:

- current user goal and latest explicit instruction
- relevant `.pi/plans/<repo>/specs/**` or `.pi/plans/<repo>/plan/**` files
- active review comments, if any
- changed files and current git status, if relevant; if there are uncommitted changes, include a
  short `git status --short` summary
- verification commands already run and their results
- known blockers, open questions, or remaining risks

Do not paste entire specs, plans, diffs, or logs into the handoff. Link to them by path and
summarize only the decision or status the next agent needs.

## Document shape

Use this template:

```md
# Handoff: <short topic>

## Current goal

<What the next agent should optimize for.>

## Completed

- <Durable result or decision, with path/commit/reference when possible.>

## Remaining work

- <Next actionable step.>

## Avoid repeating

- <Work already done, investigation already tried, or artifacts already created.>

## Key files and artifacts

- `<path>` — <why it matters>

## Verification status

- Run: `<command>` — <result>
- Not run: `<command>` — <reason>

## Risks and open questions

- <Risk/question and suggested resolution path.>

## Suggested skills for next session

- `<skill-name>` — <why>
```

## Process

1. Create a temp path:

   ```bash
   mktemp -t handoff-XXXXXX.md
   ```

2. Read the temp file before writing.
3. Write the handoff using the template above.
4. Return the path and a 2-3 bullet summary to the user.

## Quality bar

A good handoff lets a fresh agent answer these questions in under one minute:

- What is the user trying to accomplish?
- What has already been decided or changed?
- Where are the durable artifacts?
- What should I do next?
- What should I avoid repeating?
