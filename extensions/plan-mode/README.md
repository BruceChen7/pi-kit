# Plan Mode

Runtime Plan Mode workflow for Pi. This extension turns the project convention of “plan first, then act” into an enforceable plugin instead of relying only on `AGENTS.md` prompt rules.

## Modes

- `auto` (default): starts in read-only Plan phase, then switches to Act after Plannotator approves a plan/spec.
- `plan`: manual read-only planning mode.
- `act`: manual implementation mode.
- `fast`: direct execution mode without plan-review gating.

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

- Plan Mode owns mode state, tool guards, TODOs, and progress UI.
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

- `bash`
- source-code `edit` / `write`

Plan/spec artifact writes are allowed only for reviewable Plannotator paths under `.pi/plans/<repo>/plan/` and `.pi/plans/<repo>/specs/`. This lets the agent create or revise the review draft while still preventing implementation before approval.

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
