# Plan Mode

Runtime Plan Mode workflow for Pi. This extension turns the project convention of “plan first, then act” into an enforceable plugin instead of relying only on `AGENTS.md` prompt rules.

## Modes

- `auto` (default): starts in read-only Plan phase, then switches to Act after Plannotator approves a plan/spec.
- `plan`: manual read-only planning mode.
- `act`: manual implementation mode.
- `fast`: direct execution mode without plan-review gating.

## Workflow-only bypass

`auto:plan` can temporarily bypass plan review for pure operational workflows such as
`commit all changes`, `commit and push`, `git status`, `git diff`, `run tests`, or
`run lint`. These requests do not ask the agent to implement behavior, so requiring a
plan/spec draft adds friction without improving safety.

The bypass is intentionally narrow:

- It only activates when the prompt looks like a workflow and does not contain
  implementation intent such as fixing, implementing, adding, creating, refactoring, or
  optimizing code.
- It allows `bash` so the agent can run git, npm, and verification commands.
- It still blocks `edit` and `write`, including plan/spec draft writes, because a workflow
  bypass must not become an implementation path.
- It can continue across short confirmation replies like `yes` or `no` while unfinished
  TODOs remain, for example when the agent asks whether to include untracked files.
- It clears after the workflow has no unfinished TODOs, so later implementation requests
  return to normal plan review.

## Commands

```text
/plan-mode status
/plan-mode auto
/plan-mode plan
/plan-mode act
/plan-mode fast
```

## Tool

`plan_mode_todo` manages the workflow TODO list.

During Act phase, update a task to `in_progress` before starting it and `done` after finishing it. The widget highlights the current step as `当前 #<id>/<total>` with completion counts.

## Plannotator Auto Integration

Plan Mode is intentionally separate from `extensions/plannotator-auto/`:

- Plan Mode owns mode state, tool guards, TODOs, and progress UI. Progress details are
  shown in the TODO widget above the editor; Plan Mode does not use the status area below
  the editor for `auto:act 3/3`-style summaries.
- Plannotator Auto owns plan/spec detection and review feedback.

For implementation tasks, create a reviewable artifact under one of the paths watched by Plannotator Auto, for example:

```text
.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md
.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md
```

After the file is written, Plannotator Auto gates the session and asks the agent to call:

```text
plannotator_auto_submit_review({ path })
```

Before that submit call is allowed, Plan Mode validates standard plan artifacts with the
Artifact Policy below. If review is denied, revise the same file and submit again. When the
review result says `Review approved for ...`, Plan Mode switches `auto:plan` to `auto:act`.

## Artifact Policy

Plan Mode enforces a default Markdown structure for files under
`.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`, so this format is protected even when a
project does not load `AGENTS.md`.

Standard plan files must contain these top-level sections, in order:

```markdown
## Context
- Describe the user's goal, success criteria, current constraints, affected files or
  modules, explicit non-goals, and open questions. Use Chinese by default.

## Steps
- [ ] Use outcome-oriented, verifiable checkbox steps.

## Verification
- List test commands, manual checks, or skipped checks with reasons.

## Review
- Placeholder is allowed before implementation, but it should say the final review will
  record change points, verification results, remaining risks, and bug/root-cause reasons.
```

Additional `##` sections are rejected by default. Put extra details into one of the four
standard sections instead, so every plan stays predictable and easy to scan.

The policy is checked when the agent calls `plannotator_auto_submit_review` and again at
`agent_end` for the latest plan artifact. Draft writes are not blocked, which lets the
agent build or revise the Markdown incrementally.

Spec/PRD files under `.pi/plans/<repo>/specs/` are not forced to use this plan template;
they can keep their own PRD/spec structure.

## Runtime Guards

In Plan phase, runtime guards block:

- `bash`, unless workflow-only bypass is active
- source-code `edit` / `write`

Plan/spec artifact writes are allowed only for reviewable Plannotator paths under `.pi/plans/<repo>/plan/` and `.pi/plans/<repo>/specs/`. This lets the agent create or revise the review draft while still preventing implementation before approval. During workflow-only bypass, `edit` and `write` remain blocked so the agent does not create plan/spec drafts for workflow-only requests.

This is enforced through Pi's `tool_call` hook, not just prompt instructions.

Optional guards are enabled by default:

- `cwdOnly`: path access must stay inside the current cwd or configured allowed paths.
- `readBeforeWrite`: existing files must be read before `edit` or `write`.

## Configuration

Configuration is read from the shared pi-kit settings namespace `planMode` in `third_extension_settings.json`.

Example:

```json
{
  "planMode": {
    "defaultMode": "auto",
    "preserveExternalTools": true,
    "requireReview": true,
    "guards": {
      "cwdOnly": true,
      "allowedPaths": [],
      "readBeforeWrite": true
    },
    "artifactPolicy": {
      "enabled": true,
      "planFormat": "pi-standard",
      "allowExtraSections": false,
      "requireSectionOrder": true,
      "requireChinese": true,
      "requireReviewDetails": true
    }
  }
}
```
