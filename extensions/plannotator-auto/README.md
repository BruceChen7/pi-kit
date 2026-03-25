# Plannotator Auto

Auto-configures the Plannotator plan file and enters plan mode after plan updates.

## Configuration

By default, Plannotator Auto uses `.pi/PLAN.md` in the project root. You can override the plan file path (relative to the project root) in `~/.pi/agent/settings.json`:

```json
{
  "plannotatorAuto": {
    "planFile": "docs/PLAN.md"
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

- When the agent `write`/`edit` tool updates the configured plan file, and Plannotator is idle, it queues:
  - `/plannotator-set-file <planFile>`
  - `/plannotator`
  - `/plannotator-annotate`
- Auto-trigger waits until the agent is idle and the prompt editor is empty (to avoid interrupting streaming or overwriting input). It retries briefly if busy.
- In interactive TUI mode it submits commands by simulating Enter; in non-interactive modes it notifies you to run the commands manually.
- If the editor has pending input, auto-trigger is skipped and a notification is shown.

## Logging

Debug logs go through the shared extension logger (default: `~/.pi/agent/pi-debug.log`).
