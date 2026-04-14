# Plannotator Auto

Auto-configures the Plannotator plan file and enters plan mode after plan updates.

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
  - `/plannotator-annotate`
- If the current active plan file already matches the updated plan file, no new commands are queued.
- If another plan update arrives before the queued commands run, the pending queue is replaced with the newest plan file.
- Auto-trigger waits until the agent is idle and the prompt editor is empty (to avoid interrupting streaming or overwriting input). It retries briefly if busy.
- In interactive TUI mode it submits commands by simulating Enter; in non-interactive modes it notifies you to run the commands manually.
- If the editor has pending input, auto-trigger is skipped and a notification is shown.

## Logging

Debug logs go through the shared extension logger (default: `~/.pi/agent/pi-debug.log`).
