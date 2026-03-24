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

- When the agent `write`/`edit` tool updates the configured plan file, and Plannotator is idle,
  it sends `/plannotator-set-file <planFile>` and triggers `/plannotator` automatically.

## Logging

Debug logs go through the shared extension logger (default: `~/.pi/agent/pi-debug.log`).
