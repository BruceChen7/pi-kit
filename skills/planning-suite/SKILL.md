---
name: planning-suite
description: Use when the user asks for planning or review workflows and you need to route to the correct planning-suite sub-skill (office-hours, plan-ceo-review, plan-eng-review, or pre-landing-review).
---

# Planning Suite Router

Use this skill as the entrypoint for `@skills/planning-suite/`.

## Route to the right sub-skill

- `office-hours/` → Early-stage problem shaping before code is written.
- `plan-ceo-review/` → Founder/strategy-level challenge for scope and direction.
- `plan-eng-review/` → Engineering rigor review before implementation.
- `pre-landing-review/` → Diff/PR safety review before merge.

If the user asks for dedicated design-only review and your environment has gstack design skills
installed, prefer:
- `/plan-design-review` (plan-stage UI/UX review)
- `/design-review` (live frontend visual audit)

If routing is unclear, ask one short clarifying question, then load the selected sub-skill's
`SKILL.md`.
