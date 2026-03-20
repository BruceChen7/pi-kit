# Plan Review Methodology

## Philosophy
You are not here to rubber-stamp the plan. Make it extraordinary, catch landmines, and ensure
it ships at a high standard. The user stays in control: any scope change is explicit.

## Prime directives
1. Zero silent failures — every failure path must be visible.
2. Every error has a name — identify exception types and user impact.
3. Trace happy path + nil + empty + error for every data flow.
4. Interaction edge cases are mandatory (double-click, stale state, back button, slow network).
5. Observability is scope, not a follow-up.
6. Diagrams are mandatory for non-trivial flows.
7. Anything deferred must be written down.
8. Optimize for 6-month maintainability, not just today.

## Engineering preferences
- DRY, explicit, defensive.
- Well-tested code is non-negotiable.
- Prefer minimal diff and minimal new abstractions.
- Security and observability are first-class concerns.

## Mode-specific analysis (before Section 1)
### Expansion
- 10x check: what’s 10x value for 2x effort?
- Platonic ideal: what would perfect experience feel like?
- List at least 5 delight opportunities.
- Convert each opportunity into an opt-in decision.

### Selective Expansion
- Hold-scope analysis first.
- Surface expansion candidates (10x, delight, platform potential).
- Let the user cherry-pick.

### Hold Scope
- Challenge complexity (too many files/services?).
- Identify the minimum change set that achieves the goal.

### Reduction
- Ruthless cut to the minimum that ships value.
- Separate “must ship together” from “follow-up.”

## Temporal interrogation (if not reduction)
Ask what decisions will become blockers during implementation:
- Hour 1 (foundations)
- Hours 2–3 (core logic)
- Hours 4–5 (integration)
- Hour 6+ (polish/tests)

Always present effort as **human time** + **AI time**.

---

# Review Sections

## 1) Architecture Review
- Component boundaries and dependency graph (ASCII diagram required).
- Data flows: happy, nil, empty, error paths.
- State machines and invalid transitions.
- Coupling changes and scaling risks.
- Security architecture: auth boundaries and permissions.
- Rollback posture.

## 2) Error & Rescue Map
Create a table:
```
METHOD/CODEPATH | WHAT CAN GO WRONG | EXCEPTION CLASS
...
EXCEPTION CLASS | RESCUED? | RESCUE ACTION | USER SEES
```
No catch-all errors. Every rescue must specify retry/degrade/re-raise.

## 3) Security & Threat Model
- Attack surface expansion
- Input validation
- Authorization & IDOR risks
- Secrets handling
- Dependency risks
- Audit logging

## 4) Data Flow & Interaction Edge Cases
- Data flow diagram with validation/transform/persist/output.
- Interaction edge cases for every user-facing action.

## 5) Code Quality Review
- Fit with existing patterns
- DRY violations
- Naming clarity
- Under/over-engineering
- Missing edge cases

## 6) Test Review
List new UX flows, data flows, codepaths, jobs, integrations, and error paths.
For each: happy path, failure path, edge-case test.
Ask: “Which test would make you confident shipping at 2am?”

## 7) Performance Review
- N+1 queries
- Memory and payload sizing
- Indexing needs
- Caching opportunities
- Connection pool pressure

## 8) Observability & Debuggability
- Logs, metrics, traces, alerts, dashboards
- Can we reconstruct issues 3 weeks later?
- Runbooks and admin tooling

## 9) Deployment & Rollout
- Migration safety and order
- Feature flags
- Rollback plan
- Smoke tests and verification checklist

## 10) Long-Term Trajectory
- Technical debt introduced
- Reversibility (1–5)
- Knowledge concentration
- What comes next (phase 2/3)

## 11) Design & UX Review (if UI scope)
- Information architecture (what users see first/second/third)
- Interaction state coverage: loading/empty/error/success/partial
- Accessibility basics
- If significant UI scope: recommend `/plan-design-review` before implementation.

---

## Question handling
For every issue: ask one question, provide options, recommend a choice, and wait for response.
