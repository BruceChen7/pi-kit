# Plan Mode

Plan Mode gives Pi two clear workflows:

- `act`: do the work directly.
- `plan`: write a reviewable plan/spec first, wait for approval, execute automatically after approval, then return to `act`.

Use `act` for normal coding, tests, git operations, and small safe changes. Use `plan` when you want a review gate before implementation.

## Quick start

```text
/plan-mode status
/plan-mode act
/plan-mode plan
```

Typical `plan` workflow:

1. Choose `/plan-mode plan`.
2. Ask Pi to do the work.
3. Pi writes a plan/spec and submits it to Plannotator.
4. If review is denied, Pi revises the same artifact and submits it again.
5. After approval, Pi executes automatically.
6. When the approved work is complete, Plan Mode returns to `act`.

By default, Plan Mode starts in `act`. For normal interactive runs, Pi may show a short mode selector; if you do not choose within 5 seconds, it stays in `act`.

## Commands

- `/plan-mode act`: direct execution. No reviewed plan/spec is required.
- `/plan-mode plan`: one-shot review-first workflow. Approval means Pi should execute the approved plan automatically.
- `/plan-mode status`: show the user-facing workflow state.
- `/plan-mode format html|markdown`: choose the plan artifact format for this session.

`review` is not a separate user mode. Review is what `plan` does before execution.

## User-facing states

Plan Mode hides the internal state machine. Status and widgets should use product states such as:

- `Act`
- `Planning`
- `Waiting for review`
- `Approved, executing`
- `Completed, back to Act`

Internally, the extension may still track lower-level state to enforce guards and continue the approved execution path. That detail should not appear in user-facing copy.

## Review-first workflow

`plan` mode is intentionally strict. Pi writes a reviewable plan/spec, submits it to Plannotator, and waits for approval before implementation.

The normal flow is:

1. Pi creates a concrete TODO list.
2. Pi writes a plan or spec under `.pi/plans/<repo>/...`.
3. Pi submits it for review.
4. If review is denied, Pi revises the same file and submits again.
   Keep the first `#` heading unchanged across denied revisions unless the reviewer explicitly asks for a rename so Plannotator can show version diffs.
5. After approval, Pi executes the approved work automatically.
6. After completion, the workflow returns to `act`.

If an already approved plan/spec is edited after interruption or revision, the previous approval no longer authorizes that content. Submit the edited artifact for review again before continuing from it.

Operational commands such as tests, lint, git status, commit, or push are not automatically exempt while `plan` is waiting for review. Switch to `act` when you want direct command execution without a review gate.

## TODO progress

Plan Mode uses TODO tools to show the active run in the below-editor widget:

- `act_mode_todo` in `act`
- `plan_mode_todo` while planning or waiting for review
- `act_mode_todo` during approved execution

During implementation, Pi should:

- mark a task `in_progress` before starting it
- mark it `done` after finishing it
- keep the widget aligned with the current step

Completed runs remain visible briefly as an `已交付` task list, then clear on the next run or user turn.

## Writing a plan or spec

For reviewed implementation work, write artifacts in one of these paths:

```text
.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md
.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html
.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md
```

Then submit the artifact:

```text
plannotator_auto_submit_review({ path })
```

Markdown plan files should use this standard shape:

```markdown
## Context
- Goal, success criteria, constraints, affected files/modules, non-goals, and open questions. Use Chinese by default.

## Steps
- [ ] Outcome-oriented, verifiable checkbox steps.

## Verification
- Test commands, manual checks, or skipped checks with reasons.

## Review
- Final review notes: change points, verification results, remaining risks, and bug/root-cause reasons when relevant.
```

For code-changing Markdown plans/specs that affect logic, state, data models, control flow, or process flow, include before/after diagrams and a small key code sketch. Put extra plan details inside the four standard sections instead of adding new top-level `##` sections.

HTML plan files are first-class plan artifacts only under `plan/`, not `specs/`. Switch the current session with:

```text
/plan-mode format html
/plan-mode format markdown
```

HTML mode requires agents to write a self-contained HTML plan with the `plannotator-visual-explainer` Plan path. HTML plan content is not checked by the Markdown artifact policy; reviewers judge content in Plannotator.

## Configuration

Plan Mode reads settings from `planMode` in `third_extension_settings.json`.

Most users only need these options:

```json
{
  "planMode": {
    "defaultMode": "act",
    "planArtifactFormat": "markdown",
    "requireReview": true,
    "preset": "strict"
  }
}
```

Presets:

- `strict`: review-first defaults.
- `balanced`: review requirements with automatic continuation after approval.
- `solo`: fewer review waiting reminders, with the same approved-plan continuation.

Explicit settings override preset defaults.

## Troubleshooting

If Pi is not editing files:

- Check `/plan-mode status`.
- If the workflow is `Planning` or `Waiting for review`, approve the plan or switch to `/plan-mode act`.
- If a plan was rejected, revise the same plan file and submit it again. Keep the first `#` heading unchanged unless the reviewer explicitly asked for a rename; Plannotator keys plan-version diffs from that heading.

If approval does not start implementation:

- Check that `/plan-mode status` shows `Approved, executing`.
- Check that the approved plan path is the latest submitted artifact.
- If the artifact was edited after approval, submit it for review again.

If a file write is blocked:

- While planning or waiting for review, only reviewable plan/spec files can be written.
- In `act`, source-code writes are allowed, but safety guards may still require reading an existing file before editing it.
- Paths must stay inside the current working directory or configured allowed paths.

## Advanced details

Plan Mode owns workflow state, runtime guards, TODOs, and progress UI. Plannotator Auto owns plan/spec detection and review feedback.

Runtime guards are fail-closed while planning or waiting for review: shell commands and source-code writes are blocked except for reviewable plan/spec artifacts. Optional guards such as `cwdOnly` and `readBeforeWrite` protect path access and existing-file writes even in `act`.
