# Plan Mode

Runtime Plan Mode workflow for Pi. It enforces “plan first, then act” with runtime
guards, a TODO widget, and Plannotator approval before implementation.

## Recommended workflow

Plan Mode defaults to `act` for direct execution. Use `review` when you want the
review-first workflow:

1. The session starts in `act` unless configuration overrides `defaultMode`.
2. For implementation requests, create a concrete TODO list and a reviewable plan/spec.
3. Submit the plan/spec to Plannotator.
4. After approval, Plan Mode switches to `review:act` and implementation can proceed.
5. If the planning TODOs are already complete, Plan Mode automatically continues
   implementation from the approved plan without a second confirmation.
6. During Act phase, update TODOs from `in_progress` to `done` as work completes.

Review Mode is intentionally fail-closed: normal user turns stay in `review:plan` until a
reviewable plan/spec is approved. Operational work such as git status, commit, push,
tests, or lint no longer receives an automatic workflow bypass; use `act` when you want
direct command execution.

## Modes and commands

```text
/plan-mode status
/plan-mode review
/plan-mode plan
/plan-mode act
```

- `act` is the default mode.
- Before a normal interactive agent run in default `act`, Plan Mode shows a mode
  selector and a notification; if there is no choice within 3 seconds, it stays in
  `act`.
- Prompts that explicitly ask to plan first, such as “please plan this”, enter
  `plan` directly without showing the selector.
- `review` keeps the review-first workflow for teams that prefer explicit plan/spec review.
- `plan` keeps the session in read-only planning mode.
- `act` allows implementation without waiting for review approval.
- `/plan-mode status` reports a user-facing run state such as Planning, Waiting for
  review, Ready to act, Executing, or Done, plus internal details when useful.

## TODO tool

`plan_mode_todo` manages the active Plan Run.

During Act phase, update a task to `in_progress` before starting it and `done` after
finishing it. The below-editor widget highlights the current step, shows completion
counts, and collapses completed runs to a one-line summary until a new run replaces it or
`clear` hides it. Reviewed plan runs show the approved plan name; ordinary
manual/workflow runs show a generic task-completed summary so stale plan names do not
leak into unrelated work.

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

Code-changing plans/specs must also include a key code sketch. This is a minimal,
reviewable snippet for the important types, function signatures, branch conditions,
state transitions, or test assertions. It is not a full implementation dump. In standard
plan artifacts, put the sketch inside `## Context`, for example under a lower-level
`### 关键代码草案` heading, because extra top-level `##` sections are rejected.

After writing the artifact, submit it for review:

```text
plannotator_auto_submit_review({ path })
```

If artifact policy rejects a plan, the error includes a concrete fix suggestion and,
where possible, a copyable snippet for common missing standard content such as section
headings, checkbox steps, Chinese content, or Review details. If review is denied,
revise the same file and submit again. Approval applies to the
currently submitted artifact; switching to a newer artifact requires a fresh review.
After an approved plan is complete on the planning side, Plan Mode automatically injects
an implementation continuation for that same approved plan. Unrelated new implementation
requests still return to `review:plan` and require their own reviewed plan/spec. New TODO
runs do not inherit a previous approved plan name unless they are part of that explicit
continuation or are bound by a fresh review approval.

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

Runtime guards enforce the selected mode:

- plan-required turns block `bash` and source-code `edit` / `write`, except for writing
  reviewable plan/spec artifacts
- `review` no longer classifies prompts or bypasses review for operational workflows
- use `act` for direct command execution without the reviewed-plan workflow

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

Presets are optional shortcuts:

- `strict`: default review-first behavior.
- `balanced`: keep review requirements with the same automatic approval continuation.
- `solo`: disable review waiting reminders with the same automatic approval continuation.

Explicit settings override preset defaults.

```json
{
  "planMode": {
    "defaultMode": "act",
    "preserveExternalTools": true,
    "requireReview": true,
    "preset": "strict",
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

## Troubleshooting

If approval does not automatically start implementation, check that the session is still
in `review` mode, the approved plan path is present in Plan Mode status, and the previous
turn was not aborted before the approved continuation could be persisted.
