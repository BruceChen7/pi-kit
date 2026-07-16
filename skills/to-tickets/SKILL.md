---
name: to-tickets
description: Break a plan, spec, or conversation into independently-grabbable tracer-bullet tickets, each declaring its blocking edges — as local Pi issue files, or optional external issue-tracker tickets.
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native output

Primary reviewed output is a ticket-breakdown spec:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-tickets-design.md`

This path triggers `plannotator-auto` spec review because it ends with `-design.md`.

After review approval, create local ticket files under:

`.pi/plans/<repo>/issues/<topic-slug>/NN-<ticket-slug>.md`

Do not create ticket files in source directories. Only publish to GitHub/Jira/Linear/etc. when the user explicitly asks or the repo has a clear configured issue tracker workflow.

## Process

### 1. Gather context

Work from the current conversation context. If the user passes a reference (a spec path, plan file, or issue URL), fetch and read its full body and comments.

Read when relevant:

- `AGENTS.md` or equivalent repo instructions
- `.pi/plans/<repo>/specs/` and `.pi/plans/<repo>/plan/`
- `.pi/contexts/**/CONTEXT.md` — as glossary only, not as ticket/spec/implementation storage
- `.pi/contexts/**/adr/`
- relevant code paths if needed for dependency resolution or vertical slicing

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Prefer many thin slices over a few thick ones
- Prefer AFK over HITL when safe
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

Types:

- **AFK** — can be implemented and merged without human interaction.
- **HITL** — requires a human decision, design review, external credential, or architectural approval.

#### Wide refactors

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**:

1. **Expand** — add the new form beside the old so nothing breaks.
2. **Migrate** — move call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists.
3. **Contract** — delete the old form once no caller remains, in a ticket blocked by every migrate batch.

When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work
- **Verification**: how to prove the slice works

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?
- Are HITL/AFK labels correct?

Iterate until the user approves the breakdown.

### 5. Update durable language and decisions inline

Before writing the final ticket-breakdown spec, handle any durable records that the breakdown crystallized:

- update `.pi/contexts/**/CONTEXT.md` for resolved domain terms, relationships, avoided aliases, or ambiguities
- propose or create an ADR in `.pi/contexts/**/adr/` for hard-to-reverse, surprising trade-offs with real alternatives
- do not leave confirmed glossary or ADR material only inside ticket bodies

### 6. Write reviewed ticket-breakdown spec

Write the approved breakdown to:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-tickets-design.md`

Include:

- source spec/plan reference
- dependency graph
- approved ticket list with types and blocking edges
- publish target: local `.pi` files or external tracker
- risks and open questions

Wait for `plannotator-auto` review feedback and address annotations.

### 7. Create local tickets or publish externally

Default local ticket path:

`.pi/plans/<repo>/issues/<topic-slug>/NN-<ticket-slug>.md`

Create in dependency order (blockers first) so blocking references can be resolved.

If publishing externally:

- ask for the tracker if unclear
- ask for labels if unclear
- preserve the local reviewed breakdown as the source of truth
- do not close or modify a parent issue unless the user explicitly asks

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

## Local ticket template

```md
# <NN> — <Ticket title>

## Parent

Reference to the parent spec/plan/issue, if any.

## Type

AFK or HITL.

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Verification

Commands, checks, or manual review needed to prove the slice works.

## Blocked by

- None — can start immediately

Or references to blocking local/external tickets.
```

In either form, avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Attribution

Adapted from the `to-tickets` skill in https://github.com/mattpocock/skills (v1.1.0+) under the MIT License.
