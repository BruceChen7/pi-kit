# Plan Mode

Runtime Plan Mode workflow for Pi. It enforces “plan first, then act” with runtime
guards, a TODO widget, and Plannotator approval before implementation.

## Recommended workflow

Use `auto` for normal work:

1. The session starts in `auto:plan`.
2. For implementation requests, create a concrete TODO list and a reviewable plan/spec.
3. Submit the plan/spec to Plannotator.
4. After approval, Plan Mode switches to `auto:act` and implementation can proceed.
5. During Act phase, update TODOs from `in_progress` to `done` as work completes.

Read-only questions may be answered directly without a plan/spec. Pure operational
workflows, such as git status or running tests, may use a narrow command bypass when no
implementation is requested.

## Modes and commands

```text
/plan-mode status
/plan-mode auto
/plan-mode plan
/plan-mode act
/plan-mode fast
```

- `auto` is the default and recommended mode.
- `plan` keeps the session in read-only planning mode.
- `act` allows implementation without waiting for auto approval.
- `fast` is an escape hatch for direct execution; prefer `auto` for normal work.

## TODO tool

`plan_mode_todo` manages the active Plan Run.

During Act phase, update a task to `in_progress` before starting it and `done` after
finishing it. The widget highlights the current step, shows completion counts, and
collapses completed runs to a one-line summary until a new run replaces it or `clear`
hides it.

## Plannotator Auto integration

Plan Mode owns mode state, runtime guards, TODOs, and progress UI. Plannotator Auto owns
plan/spec detection and review feedback.

For implementation tasks, create a reviewable artifact under one of the watched paths:

```text
.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md
.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md
```

Use `write` directly with the standard filename; the write tool creates missing
`.pi/plans` parent directories.

For code-writing plans/specs that change logic, state, data models, control flow, or
process flow, include before/after diagrams for the affected data model and flow inside
the standard plan sections.

After writing the artifact, submit it for review:

```text
plannotator_auto_submit_review({ path })
```

If review is denied, revise the same file and submit again. Approval applies to the
currently submitted artifact; switching to a newer artifact requires a fresh review.

## Artifact Policy

Plan files under `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md` must use this structure:

```markdown
## Context
- Describe the goal, success criteria, constraints, affected files/modules, non-goals,
  and open questions. Use Chinese by default.

## Steps
- [ ] Use outcome-oriented, verifiable checkbox steps.

## Verification
- List test commands, manual checks, or skipped checks with reasons.

## Review
- State that the final review will record change points, verification results, remaining
  risks, and bug/root-cause reasons.
```

Additional top-level `##` sections are rejected by default; put extra details inside one
of the four standard sections. Spec/PRD files under `.pi/plans/<repo>/specs/` may keep
their own structure.

## Runtime guards

In Plan phase, runtime guards block:

- `bash`, except for the narrow operational workflow allow-list
- source-code `edit` / `write`

Plan/spec artifact writes are allowed only for reviewable Plannotator paths:

```text
.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md
.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md
```

Optional guards are enabled by default:

- `cwdOnly`: path access must stay inside the current cwd or configured allowed paths.
- `readBeforeWrite`: existing files must be read before `edit` or `write`.

## Configuration

Configuration is read from the shared pi-kit settings namespace `planMode` in
`third_extension_settings.json`.

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
