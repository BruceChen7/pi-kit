# Plannotator Auto

Auto-configures the Plannotator plan file, enters plan mode after plan updates, and queues code review only for non-plan file changes.

## Configuration

By default, Plannotator Auto watches the plan directory `.pi/plans/<repo>/plan/` (repo slug = basename of the repo) and expects plan files named `YYYY-MM-DD-<slug>.md`. You can override the plan path (relative to the project root) in `~/.pi/agent/third_extension_settings.json`.

Directory example:

```json
{
  "plannotatorAuto": {
    "planFile": ".pi/plans/my-repo/plan"
  }
}
```

Single-file example:

```json
{
  "plannotatorAuto": {
    "planFile": ".pi/PLAN.md"
  }
}
```

To disable Plannotator Auto explicitly:

```json
{
  "plannotatorAuto": {
    "planFile": null
  }
}
```

## Behavior

- When the agent `write`/`edit` tool updates the configured plan file (file mode) **or** writes a `YYYY-MM-DD-*.md` file inside the configured plan directory (directory mode), it queues:
  - `/plannotator-set-file <planFile>`
  - If Plannotator is already active on a different plan file, it queues `/plannotator <oldPlanFile>` to exit, then `/plannotator <planFile>` to re-enter with the new plan; otherwise it queues `/plannotator <planFile>`.
- It does **not** auto-run `/plannotator-annotate` or auto-submit the plan for review. Plan approval still happens only when the agent calls `plannotator_submit_plan`.
- If the current active plan file already matches the updated plan file, no new commands are queued.
- If another plan update arrives before the queued commands run, the pending plan-command queue is replaced with the newest plan file.
- Successful `write`/`edit` calls to **non-plan files** mark the repo as changed. On `agent_end`, if the repo is dirty and UI is available, it asks Plannotator to open the shared **code-review** flow over `plannotator:request`.
- Plan-file activation still uses Plannotator slash commands (`/plannotator-set-file`, `/plannotator`) because the upstream shared event API does not expose plan-mode activation yet.
- Auto-trigger waits until the agent is idle, then dispatches queued plan commands with `pi.sendUserMessage()`. Shared code review requests are retried briefly if plan commands are still draining.
- If Plannotator is not loaded or does not respond on the shared event channel, review auto-trigger is skipped and a warning is shown instead of falling back to slash-command injection.

## Logging

Debug logs go through the shared extension logger (default: `~/.pi/agent/pi-debug.log`).
