# Plan Mode

Plan Mode helps Pi follow a safer workflow: plan the work, review the plan when needed,
then act with visible progress. It is useful when a change needs design review, step-by-step
execution, or protection from accidental edits during planning.

Use `act` when you want Pi to execute directly. Use `review` when you want Pi to write a
plan or spec first and wait for approval before implementation.

## Quick start

```text
/plan-mode status
/plan-mode act
/plan-mode review
/plan-mode plan
```

Typical usage:

1. Choose the mode you want.
2. Ask Pi to do the work.
3. For reviewed work, Pi writes a plan/spec and submits it for review.
4. After approval, Pi continues with the approved implementation.
5. Track progress in the TODO widget while Pi works.

By default, Plan Mode starts in `act`. For normal interactive runs, Pi may show a short
mode selector; if you do not choose within 3 seconds, it stays in `act`.

## Modes

- `act`: execute directly. Use this for normal coding, tests, git operations, and quick
  changes.
- `review`: require a reviewed plan/spec before implementation. Use this for larger or
  riskier code changes.
- `plan`: stay in read-only planning mode. Use this when you only want analysis or a plan.
- `status`: show the current run state, such as Planning, Waiting for review, Ready to
  act, Executing, or Done.

If your prompt clearly asks to plan first, such as “please plan this”, Plan Mode enters
`plan` directly.

## Review-first workflow

`review` mode is intentionally strict. Pi writes a reviewable plan/spec, submits it to
Plannotator, and waits for approval before implementation.

The normal flow is:

1. Pi creates a concrete TODO list.
2. Pi writes a plan or spec under `.pi/plans/<repo>/...`.
3. Pi submits it for review.
4. If review is denied, Pi revises the same file and submits again.
   Keep the first `#` heading unchanged across denied revisions unless the
   reviewer explicitly asks for a rename so Plannotator can show version diffs.
5. After approval, Pi implements the approved plan and updates TODO progress.

Operational commands such as tests, lint, git status, commit, or push are not automatically
exempt from review mode. Switch to `act` when you want direct command execution.

## TODO progress

Plan Mode uses TODO tools to show the active run in the below-editor widget:

- `act_mode_todo` in `act` mode
- `plan_mode_todo` in `plan` mode and reviewed planning flows

During implementation, Pi should:

- mark a task `in_progress` before starting it
- mark it `done` after finishing it
- keep the widget aligned with the current step

Completed runs remain visible briefly as an `已交付` task list, then clear on the next run
or user turn.

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
- Goal, success criteria, constraints, affected files/modules, non-goals, and open
  questions. Use Chinese by default.

## Steps
- [ ] Outcome-oriented, verifiable checkbox steps.

## Verification
- Test commands, manual checks, or skipped checks with reasons.

## Review
- Final review notes: change points, verification results, remaining risks, and
  bug/root-cause reasons when relevant.
```

For code-changing Markdown plans/specs that affect logic, state, data models, control
flow, or process flow, include before/after diagrams and a small key code sketch. Put
extra plan details inside the four standard sections instead of adding new top-level
`##` sections.

HTML plan files are first-class plan artifacts only under `plan/`, not `specs/`. Switch
the current session with:

```text
/plan-mode format html
/plan-mode format markdown
```

HTML mode requires agents to write a self-contained HTML plan with the
`plannotator-visual-explainer` Plan path. HTML plan content is not checked by the
Markdown artifact policy; reviewers judge content in Plannotator.

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
- If the session is in `plan` or `review:plan`, switch to `act` or approve the plan.
- If a plan was rejected, revise the same plan file and submit it again. Keep
  the first `#` heading unchanged unless the reviewer explicitly asked for a
  rename; Plannotator keys plan-version diffs from that heading.

If approval does not start implementation:

- Check that the session is still in `review` mode.
- Check that `/plan-mode status` shows the approved plan path.
- Ask Pi to continue from the approved plan if the previous turn was interrupted.

If a file write is blocked:

- In planning modes, only reviewable plan/spec files can be written.
- In `act`, source-code writes are allowed, but safety guards may still require reading an
  existing file before editing it.
- Paths must stay inside the current working directory or configured allowed paths.

## Advanced details

Plan Mode owns mode state, runtime guards, TODOs, and progress UI. Plannotator Auto owns
plan/spec detection and review feedback.

Runtime guards are fail-closed in planning modes: shell commands and source-code writes
are blocked except for reviewable plan/spec artifacts. Optional guards such as `cwdOnly`
and `readBeforeWrite` protect path access and existing-file writes even in `act` mode.
