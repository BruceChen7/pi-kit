# Plan Mode

Runtime Plan Mode workflow for Pi. It enforces “plan first, then act” with runtime
guards, a TODO widget, and Plannotator approval before implementation.

## Recommended workflow

Use `auto` for normal work:

1. The session starts in `auto:plan`.
2. For implementation requests, create a concrete TODO list and a reviewable plan/spec.
3. Submit the plan/spec to Plannotator.
4. After approval, Plan Mode switches to `auto:act` and implementation can proceed.
5. If the planning TODOs are already complete, a follow-up confirmation such as `approve`,
   `go ahead`, or `同意实施` continues the approved plan in `auto:act`.
6. During Act phase, update TODOs from `in_progress` to `done` as work completes.

Auto Mode chooses between three user-visible outcomes: answer directly, run a safe
workflow directly, or require plan/spec review. Pure operational workflows, such as git
status, commit, push, tests, or lint, switch the turn to direct workflow execution when
the Plan Mode plugin classifier produces valid structured intent feedback. Direct
workflow execution may show `auto:act`, but it is still limited to safe git/npm bash;
source-code writes remain blocked. Stateful git operations such as `git add`,
`git commit`, and `git push` may change repository state, so Plan Mode calls this
out in the injected guidance. Missing, invalid, unavailable, timed-out, or
low-confidence intent feedback fails closed and requires the safer planning path,
with the latest decision reason shown in status/follow-up messages.

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
  When active, Plan Mode warns that review workflow guards are bypassed.

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
where possible, a copyable snippet for the missing standard content. If review is denied,
revise the same file and submit again. Approval applies to the
currently submitted artifact; switching to a newer artifact requires a fresh review.
After an approved plan is complete on the planning side, short continuation prompts keep
that same approved plan executable. Unrelated new implementation requests still return to
`auto:plan` and require their own reviewed plan/spec. New TODO runs do not inherit a
previous approved plan name unless they are part of that explicit continuation or are
bound by a fresh review approval.

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

Runtime guards enforce the selected Auto outcome:

- plan-required turns block `bash` and source-code `edit` / `write`, except for writing
  reviewable plan/spec artifacts
- direct workflow turns allow only the narrow safe git/npm bash allow-list
- direct workflow turns still block source-code `edit` / `write` even when shown as
  `auto:act`

Plan Mode starts each normal user turn by asking a plugin-owned classifier for structured
intent feedback. Event-provided `intentFeedback` is still accepted for compatibility, but
Plan Mode no longer depends on Pi core injecting it.

Plan Mode consumes structured intent feedback and folds it into three Auto decisions:

- direct answer: no plan/spec obligation for read-only questions
- direct workflow: safe git/npm workflow execution without plan/spec review
- plan required: normal TODO + plan/spec review for implementation, ambiguity, or invalid
  classifier output

The old keyword/regular-expression intent classifier is not used as a runtime fallback.
If the plugin classifier cannot run because there is no active model, model auth is
unavailable, the request times out, or the response is invalid, Plan Mode keeps the safe
fail-closed behavior.

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
    },
    "intentClassifier": {
      "enabled": true,
      "timeoutMs": 3000
    }
  }
}
```
