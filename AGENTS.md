## Workflow Orchestration

### Plan Mode Default
* Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions), unless it qualifies for the "Skill-only exception" below.
* If something goes sideways, STOP and re-plan immediately - don't keep pushing
* Use plan mode for verification steps, not just building. Write detailed specs upfront to reduce ambiguity

### Skill Integration (Plan Mode + Skills)

### Skill-only exception (no plan required)
* If the user request is **only** to run a skill as a **pure workflow** (no code changes, no file edits, no architectural decisions), skip plan mode and do not create a `.pi/plans/...` plan file.
* The moment the task includes edits/implementation (even if guided by a skill), fall back to plan mode.

* Plan mode is still required for non-trivial tasks even when executing a multi-step skill.
* Keep plans lightweight: reference the skill as a single checklist item instead of duplicating sub-steps.
* Skill ordering takes precedence. If a plan conflicts with a skill’s required sequence, update the plan to match the skill; if unclear, stop and re-plan/ask.
* Verification should map to the skill’s outcomes (not its internal steps).

**Lightweight plan template (skill-driven task):**
```markdown
## Steps
- [ ] Prepare change set (files + context)
- [ ] Execute skill: branch-commit-push (git workflow)

## Verification
- `git status` clean
- Branch exists and is pushed to origin
```

**Example:** Use `branch-commit-push` whenever committing/pushing; keep the plan step at the outcome level and rely on the skill for the step-by-step prompts (new branch, stage, commit, push).

## Task Management

1. **Plan First**: Write plan to `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md` with checkable items (kebab-case slug). (Exception: the "Skill-only exception" above.)
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to the plan file you created
6. **Capture Lessons**: Update `.pi/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.


### Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it


### Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
