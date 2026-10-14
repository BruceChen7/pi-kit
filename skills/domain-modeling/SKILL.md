---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing `.pi/contexts/**/GLOSSARY.md`, or recording or editing an ADR.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* `.pi/contexts/**/GLOSSARY.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

Default to Chinese when interacting with the user unless they explicitly ask for another language.

## Pi file structure

Most repos have a single context. Domain docs live under `.pi/contexts/` to avoid polluting application source directories:

```
<repo>/
├── .pi/
│   └── contexts/
│       ├── GLOSSARY.md
│       └── adr/
│           ├── 0001-event-sourced-orders.md
│           └── 0002-postgres-for-write-model.md
└── src/
```

If a `.pi/contexts/GLOSSARY-MAP.md` exists, the repo has multiple contexts. The map points to where each one lives:

```
<repo>/
├── .pi/
│   └── contexts/
│       ├── GLOSSARY-MAP.md
│       ├── adr/                          ← system-wide decisions
│       ├── ordering/
│       │   ├── GLOSSARY.md
│       │   └── adr/                      ← context-specific decisions
│       └── billing/
│           ├── GLOSSARY.md
│           └── adr/
└── src/
```

Create files lazily — only when you have something to write. If no `.pi/contexts/` exists, create it when the first term is resolved. Use the format in [GLOSSARY-FORMAT.md](GLOSSARY-FORMAT.md) for glossary entries and [ADR-FORMAT.md](ADR-FORMAT.md) for architectural decisions.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `.pi/contexts/**/GLOSSARY.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update GLOSSARY.md inline

When a term is resolved, update `.pi/contexts/**/GLOSSARY.md` right there. Don't batch these up — capture them as they happen. Use the format in [GLOSSARY-FORMAT.md](GLOSSARY-FORMAT.md).

`GLOSSARY.md` should be totally devoid of implementation details. Do not treat `GLOSSARY.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](ADR-FORMAT.md).

## Attribution

Adapted from the `domain-modeling` skill in https://github.com/mattpocock/skills (v1.3.1) under the MIT License.
Changes synced through v1.3.1: GLOSSARY.md / GLOSSARY-MAP.md naming, updated trigger description. Pi path convention `.pi/contexts/` is kept.
