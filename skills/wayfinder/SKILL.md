---
name: wayfinder
description: >
  Plan a huge chunk of work — more than one agent session can hold — by charting a shared
  map of decision tickets, then resolve them one at a time until the way to the destination
  is clear. Use when the user says "this is too big for one session", "we need a plan first",
  or when scoping a large feature before splitting into tickets.
disable-model-invocation: true
---

# Wayfinder

A task that's too big for a single session, with fog ahead — the path from here to the **destination** is unclear.
Wayfinding is about finding that path, not charging toward the destination.
This skill draws the route as a **shared map**, then tackles **decision tickets** one by one — tickets resolve decisions, not build-slice execution — until the path is clear.

Every project has a different destination. Naming the destination is the first act of mapping — it determines the shape of every ticket.
The destination might be a spec to hand off and iterate on, a decision to lock before planning, or a data-structure migration to complete in place.
The map is domain-agnostic — engineering work, curriculum content, anything that fits this shape.

**Default to Chinese for the map, tickets, summaries, and all user-facing output** unless the user explicitly asks for another language.

## Plan, Don't Execute

Wayfinder is a **planning tool** by default: every ticket resolves a decision, and when the path is clear the map is done — what remains is handoff for others to execute.
The urge to "just start building" usually means you've reached the edge of the map — it's time to hand off.
A project can override this default in its Notes — bringing execution into the map itself — but unless explicitly stated, the output is decisions, not deliverables.

## Refer by Name

Every map and ticket is a file, therefore it has a **name** — its title.
In everything a human reads — narrative, the map's "Decisions so far" list — refer by name, never by bare IDs, numbers, or paths.
A wall of `tickets/03.md, tickets/07.md` is unreadable; names are instantly legible.
File paths don't disappear — a name wraps its path — but the path is embedded inside the name, never in place of it.

---

## The Map

The map is `.pi/plans/<repo>/wayfinder/map.md` — the canonical artifact.
Its tickets are individual Markdown files in `.pi/plans/<repo>/wayfinder/tickets/`.

The map is an **index**, not a store.
It lists decisions made and points to the ticket files holding the details; a decision lives in exactly one place — its ticket — so the map never restates, only summarises and links.

### Map Body

Load the full map at low resolution once per session.
Open tickets are **not** listed in the map body — they live as individual files in `tickets/`, read on demand.

```markdown
## Destination

<What it looks like at the end of this map — the spec, decision, or change this project is finding its way to. One or two lines; every session reads this before picking a ticket.>

## Notes

<Domain; skills every session should consult; fixed preferences for this project>

## Decisions so far

<!-- Index — one line per closed ticket: enough summary to judge relevance, then a link for details -->

- [<closed ticket title>](tickets/NN-<slug>.md) — <one-line answer summary>

## Not yet specified

<!-- See "Fog of War": in-scope fog, not yet ready to ticket; graduates as the frontier advances -->

## Out of scope

<!-- See "Out of Scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Every ticket is a Markdown file in `tickets/`, numbered by dependency order.
Its body is the question itself, sized for a ~100K token agent session:

```markdown
# <NN> — <ticket title>

## Type

<research | prototype | grilling | task>

## HITL / AFK

<human-in-the-loop or agent-driven>

## Question

<The decision or investigation this ticket resolves>

## Dependencies

- <path to prerequisite ticket, or "None — can start immediately">

## Acceptance Criteria

- [ ] criterion 1
- [ ] criterion 2

## Output

<What must be produced when closing: decision record, prototype link, research notes, etc.>
```

A session **claims** a ticket by adding `**Status:** In progress` to the header of its ticket file in `tickets/` — **claim first, then start**, so parallel sessions don't collide.
This status marker *is* the claim: open tickets without "In progress" are unclaimed.

**Dependency tracking**:
- List prerequisite ticket paths in the ticket file's `## Dependencies` section
- The **frontier** is tickets whose dependencies are all closed, are themselves open, and are unclaimed — the known edge
- A ticket can only start after all its dependencies are closed

Answers don't live in the ticket body — they're recorded at close time (see [Advancing the Map](#advancing-the-map)).
Artifacts created while solving a ticket (prototype code, research notes) live in `.pi/plans/<repo>/wayfinder/assets/` or are linked from the ticket — they're not pasted into the ticket body.

---

## Ticket Types

Every ticket is **HITL** (human-in-the-loop, requires working with the human) or **AFK** (agent-driven independently).
HITL tickets can only be resolved through live conversation; an agent can never substitute for the human side (a grilling that answers its own questions is broken).

- **Research (AFK)**: Read docs, third-party APIs, or local knowledge bases to surface facts a decision depends on.
  Resolved through independent research sub-agents or dedicated research sessions.
  Use when knowledge outside the current working directory is needed.

- **Prototype (HITL)**: Raise the fidelity of a discussion by building a cheap, rough, concrete artifact —
  an outline, a rough attempt, a stub, or UI/logic code through the `/prototype` skill.
  Link the prototype as an attachment.
  Use when "what does it look like" or "how should it behave" is the key question.

- **Grilling (HITL)**: Conversation through the `/grilling` and `/domain-modeling` skills, in frontier rounds.
  Default type.

- **Task (HITL or AFK)**: Physical work that must be done before making a **decision** —
  nothing to decide, prototype, or research, but the discussion is blocked without it.
  Registering a service so its API can be evaluated, provisioning access, moving data to see its shape.
  This is the only type that **executes** rather than decides — it earns its place by unblocking a decision, not by delivering the destination.
  AFK when the agent can drive it independently; otherwise give the human a precise checklist (HITL).
  Resolves on completion; the answer records what was done and any facts subsequent tickets depend on (credential locations, new URLs, row counts).

---

## Fog of War

The map is **deliberately incomplete**: don't draw what you can't yet see.
Beyond the active tickets is the **fog of war** — decisions and investigations you can dimly sense but can't yet pin down because they depend on still-open questions.
Solving a ticket clears the fog in front of it, graduating what's now certain into new tickets — one by one, until the path to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where this fuzzy view is written down:
suspected questions, areas to revisit later.
It's the undiscovered frontier toward the destination — everything here is in scope, just not clear enough to ticket.
It can be loose or thorough; it also serves as a signpost for collaborators reading the project direction.

**Fog or ticket?** The test is: can you state the question precisely right now — **not** can you answer it right now.

- **Ticket when** the question is clear — even if it's blocked and you can't act yet.
- **Not yet specified when** you can't state it that clearly yet. Don't cut pre-fog into ticket-sized pieces: it's coarser than tickets, and a patch of fog might graduate to multiple tickets once the frontier reaches it, or might not.

**Not yet specified** excludes what's already decided (Decisions so far), what's already an active ticket, and what's out of scope (next section).

---

## Out of Scope

Fog converges only toward the destination. The destination fixes scope, so work beyond the destination is **out of scope** — it's not fog, and it doesn't belong in **Not yet specified**.
It has its own **Out of scope** section on the map: work you've consciously excluded from this project.
Scope, not clarity, puts it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it only returns when the map is redrawn, and then as a new project, not a resumption.

Ruling something out of scope is a scoping act, not a step on the path.
When an existing ticket ends up sitting outside the destination — mistakenly placed in scope during mapping, or exposed by a resolution — **close it** (closed tickets are explicitly off the frontier) and leave a line in the **Out of scope** section: a summary plus why it's out of scope, linked to the closed ticket.
It doesn't go into **Decisions so far**, which records the path actually walked — scope boundaries aren't a step on the path.

---

## Invocation

Two modes. In both, **resolve at most one ticket per session** — except research tickets (which can be parallel).

### Drawing the Map

The user invokes with a vague idea.

1. **Name the destination.**
   Run a `/grilling` and `/domain-modeling` session to clarify what this map is finding — a spec, a decision, or a change.
   The destination fixes scope, so nail it first.

2. **Draw the frontier.**
   Grilling again, this time **breadth-first**: spread across the whole space rather than digging deep on any one thread, surfacing open decisions and the first steps possible now.
   **If no fog surfaces at this stage** — the path to the destination is clear and the whole journey fits in one session — you don't need a map.
   Stop and ask the user how they'd like to proceed.

3. **Create the map file.**
   Write `.pi/plans/<repo>/wayfinder/map.md`:
   Fill in Destination and Notes, leave Decisions so far empty, sketch the fog into **Not yet specified**.

4. **Create the tickets you can identify now.**
   Number them by dependency order, save to `.pi/plans/<repo>/wayfinder/tickets/NN-<slug>.md`.
   Wire up dependencies in `## Dependencies`. This step sorts tickets into the frontier and the blocked queue.
   Everything not yet determinable stays in the fog — the **Not yet specified** section.

5. **Trigger research subtasks.**
   For each `research` ticket just created, fire off independent research sub-sessions to resolve in parallel, storing results in `.pi/plans/<repo>/wayfinder/assets/` and linking from the ticket.

6. **Stop.**
   Drawing is a single-session job; it doesn't resolve any tickets itself.

   Before moving to implementation, if the map will produce artifacts that affect domain language or architectural decisions, go through Plannotator review:
   Submit the map and ticket structure as `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-wayfinder-design.md`
   and get feedback via `plannotator_auto_submit_review`.

### Advancing the Map

The user invokes with a map path. Tickets are **optional** — when no ticket is specified, you pick the next decision, not the user.

1. **Load the map.**
   Read `.pi/plans/<repo>/wayfinder/map.md` — low-resolution view, not every ticket's body.

2. **Pick a ticket.**
   Use the one the user specified, if any. Otherwise take the first from the frontier (by dependency order).
   **Claim it**: add `**Status:** In progress` to the ticket file header.

3. **Resolve it.**
   **Zoom in on demand**: read the full body of related or closed tickets as needed; invoke skills named in `## Notes`.
   When uncertain, use `/grilling` and `/domain-modeling`.

4. **Record the resolution.**
   Update the ticket file:
   - `## Answer`: record the decision or finding
   - `**Status:** Resolved`
   Then append a line to the map's **Decisions so far**: `- [<title>](tickets/NN-<slug>.md) — <one-line answer summary>`

5. **Handle newly surfaced tickets.**
   Add newly surfaced tickets (create and number by dependency order);
   clear from **Not yet specified** what the answer has made certain, so each piece of graduated fog exists only as its new tickets.
   If the answer reveals that a ticket — this one or another — sits outside the destination, **rule it out of scope** rather than resolving it on the path.
   If a decision invalidates other parts of the map, update or delete the affected tickets.

Users may run unblocked tickets in parallel, so expect other sessions to be editing the map and ticket files simultaneously.

6. **Map completion — synthesize design document.**
   When all tickets are closed and the path to the destination is clear, the map is complete.
   By default the output is the map itself (decisions in tickets). If the user or project Notes specify a need for a comprehensive design document (architecture overview, data structures, algorithms, implementation plan), create it as a standalone artifact at:
   `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-wayfinder-design.md`
   This file synthesizes all resolved decisions, fog that cleared, and out-of-scope rulings into a single reference document.
   Same path convention as the spec review at drawing time — the date and topic distinguish them.

---

## Plannotator Review Integration

- **When drawing completes**: submit the map and ticket structure as a spec review:
  `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-wayfinder-design.md`
  via `plannotator_auto_submit_review`.
- **During advancement, when domain terms or ADR-worthy decisions emerge**: update `.pi/contexts/**/CONTEXT.md` or create an ADR through `/domain-modeling`.
- **When a ticket resolution warrants recording an architectural decision**: write it to an ADR or plan file, not just the ticket.

## Dependencies

This skill depends on the following locally available skills:

- `/grilling` — core interview loop
- `/domain-modeling` — domain terminology and ADR maintenance
- `/prototype` — needed for prototype tickets
- `herdr-squad` or independent sub-agents — available for research tickets

## Quick Reference

| Concept | Local Path |
|---|---|
| Map file | `.pi/plans/<repo>/wayfinder/map.md` |
| Ticket directory | `.pi/plans/<repo>/wayfinder/tickets/` |
| Assets directory | `.pi/plans/<repo>/wayfinder/assets/` |
| Spec review (drawing stage) | `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-wayfinder-design.md` |
| Synthesized design document | `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-wayfinder-design.md` |
| Domain glossary | `.pi/contexts/**/CONTEXT.md` |
| ADR directory | `.pi/contexts/**/adr/` |

## Version Comparison

| Aspect | upstream wayfinder | Pi adaptation |
|---|---|---|
| Map storage | GitHub/GitLab issue (`wayfinder:map` label) | `.pi/plans/<repo>/wayfinder/map.md` |
| Tickets | child issues with `wayfinder:<type>` labels | `.pi/plans/<repo>/wayfinder/tickets/NN-<slug>.md` |
| Blocking tracking | native issue tracker blocking | `## Dependencies` section + file ordering |
| Claiming | assignee | `**Status:** In progress` in ticket header |
| Frontier | tracker query | scan ticket directory by numeric order |
| Parallelism | native tracker allows multi-session | convention: check status before starting |
| Release review | — | `plannotator_auto_submit_review` |

## Attribution

Adapted from the `wayfinder` skill in https://github.com/mattpocock/skills (v1.1.0+) under the MIT License.
