---
name: improve-codebase-architecture
description: Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, deepen shallow modules, improve testability, or make a codebase easier for Pi agents to navigate.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability, locality, leverage, and Pi-agent navigability.

This skill is built on a shared design vocabulary — run the `/codebase-design` skill for the full architecture terminology (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**). Use these terms exactly in every suggestion — don't drift into "component", "service", "API", or "boundary."

The domain language in `.pi/contexts/**/CONTEXT.md` gives names to good seams; ADRs under `.pi/contexts/adr/` record decisions this skill should not re-litigate.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native rules

- Review architecture first; do not implement refactors from this skill.
- Use `.pi/contexts/` for domain docs and ADRs. Do **not** create root `CONTEXT.md`, root `docs/adr/`, or context docs inside source directories.
- Treat `.pi/contexts/**/CONTEXT.md` as a domain glossary only. Architecture proposals,
  interface sketches, file paths, rollout notes, implementation plans, and technical decisions
  belong in `.pi/plans/**` or ADRs, not in the glossary.
- If the task is only architecture exploration with no file edits, the `AGENTS.md` skill-only exception applies and no plan file is required.
- Before writing `.pi/contexts/**`, specs, plans, or any code, write a plan file at `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md` using the required `AGENTS.md` sections
- When architecture exploration resolves a domain term, relationship, avoided alias, ambiguity,
  or durable trade-off, update the relevant `.pi/contexts/**/CONTEXT.md` or propose/create an
  ADR inline before continuing the review.
- When producing an architecture review artifact, write it to `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md` so `plannotator-auto` can review it.

## Required vocabulary

Use these terms exactly in every suggestion. Full definitions are in the `/codebase-design` skill.

- **Module** — anything with an interface and an implementation.
- **Interface** — everything a caller must know to use the module correctly.
- **Implementation** — the code inside a module.
- **Depth** — leverage at the interface; **deep** means much behavior behind a small interface.
- **Seam** — where an interface lives; use this, not "boundary".
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth.

Key principles:

- **Deletion test:** if deleting the module makes complexity vanish, it was a pass-through; if complexity reappears across callers, it earned its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Process

### 1. Explore

Read:

- `AGENTS.md` or equivalent repo instructions
- `.pi/contexts/CONTEXT.md` or `.pi/contexts/CONTEXT-MAP.md`
- relevant `.pi/contexts/<context-id>/CONTEXT.md`
- relevant ADRs under `.pi/contexts/adr/` or `.pi/contexts/<context-id>/adr/`
- `/codebase-design` for the architecture vocabulary and deepening guidance

Then inspect the code organically. Note where you experience friction:

- understanding one concept requires bouncing between many small modules
- modules are **shallow**: their interface is nearly as complex as their implementation
- extracted helpers improve unit-testability but reduce **locality** for real behavior
- tightly-coupled modules leak across their **seams**
- important behavior is untested or hard to test through the current **interface**

Apply the **deletion test** to suspected shallow modules.

### 2. Present candidates as an HTML report

For any non-trivial review (multiple candidates, meaningful call graphs, before/after structure,
or more than one file group), write a Pi-native HTML report using `HTML-REPORT.md`. Write the
artifact to:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-architecture-review.html`

Submit the artifact for review through `plannotator_auto_submit_review` when the workflow
requires it.

For trivial reviews (single candidate, no structural change), a numbered list in the
spec/plan document is sufficient — but lean toward visuals when the architecture trade-offs
would benefit from a diagram.

Each candidate — whether in HTML or list form — includes:

- **Files** — files/modules involved
- **Problem** — why the current architecture causes friction
- **Solution** — plain-English change, not final interface design
- **Benefits** — explain via **locality**, **leverage**, and improved tests
- **Before / After diagram** — side-by-side visual illustrating the shallowness and deepening
- **Recommendation strength** — `Strong`, `Worth exploring`, or `Speculative`
- **Dependency category** — from `/codebase-design`'s deepening guidance (`in-process`, `local-substitutable`,
  `ports & adapters`, `mock`)
- **Doc impact** — `.pi/contexts/**` terms or ADRs that may need updates

Use `.pi/contexts/**/CONTEXT.md` vocabulary for domain names and `/codebase-design` vocabulary for
architecture. If a candidate contradicts an existing ADR, surface it only when friction is real
enough to justify revisiting the ADR.

End the report with a **Top recommendation** section: which candidate to tackle first and why.

Do **not** propose detailed interfaces yet. After the report is written, ask: “Which candidate
would you like to explore?”

### 3. Grilling loop

Once the user picks a candidate, run the `/grill-with-docs` discipline (which uses `/grilling` for the core interview loop and `/domain-modeling` for glossary/ADR updates).

Side effects happen inline as decisions crystallise — update `.pi/contexts/**/CONTEXT.md` via `/domain-modeling` when domain terms sharpen, and offer ADRs only for hard-to-reverse, surprising, trade-off decisions.

If the user rejects a candidate with a load-bearing reason, ask whether to record an ADR so future architecture reviews do not re-suggest it.

### 4. Interface exploration

If the user wants alternative interfaces for a deepened module, run the `/codebase-design` skill and follow its design-it-twice pattern from `DESIGN-IT-TWICE.md`.

Pi adaptation: if no subagent facility is available, run 3 distinct design passes yourself and clearly label them as described in `/codebase-design`.

### 5. Handoff artifact

When the review is ready to preserve, write an architecture review/design artifact to:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

Include:

- candidates considered
- chosen candidate, if any
- domain terms/ADRs touched under `.pi/contexts/`
- proposed module shape and seam placement
- dependency category from `DEEPENING.md`
- testing strategy through the new interface
- risks and open questions


## Dependencies

This skill depends on:

- `/codebase-design` — shared architecture vocabulary, deepening guidance, and design-it-twice pattern
- `/domain-modeling` — domain glossary format and ADR format
- `HTML-REPORT.md` — HTML review report scaffold
- `LANGUAGE.md` — local convenience copy of the architecture glossary
- `DEEPENING.md` — local convenience copy of deepening guidance
- `INTERFACE-DESIGN.md` — local convenience copy of interface exploration guidance

For shared architecture vocabulary, you can also invoke `/codebase-design` directly when deeper guidance on module design principles is needed.
