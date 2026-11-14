# Safe Delete Extension

This extension intercepts **bash** tool calls and prompts for confirmation when a command looks destructive.

## Hooked tool

- **Tool:** `bash`
- **Event:** `tool_call`
- Only runs when `ctx.hasUI` is true (so it can prompt for confirmation).

## Commands & patterns it detects

> The extension analyzes the full command, splits pipelines/compound commands, and checks each sub-command.

### Deletions

- `rm` / `rmdir`
  - Protected paths (e.g. `/`, `/usr`, `$HOME`, `~/Desktop`, `~/.ssh`, etc.)
  - Recursive deletions over **100MB** (`rm -r/-R`)
  - Wildcard explosions like `rm -rf /*`, `rm -rf ~/*`, `rm -rf ../*`

- `find ... -delete`
- `find ... -exec rm ...`
  - Protected paths or large targets

- Piped deletions
  - `... | xargs rm ...`

### Permission/ownership changes

- `chmod -R ...` / `chown -R ...`
  - Protected paths

### Git cleanup

- `git clean -fdx` (or any `git clean` with `-f` + `-d`/`-x`)

### Truncation / overwrite

- Bare redirection at the beginning: `> file`
- `truncate` (large files)

### Device / filesystem destruction

- `dd ... of=/dev/...`
- `mkfs` / `newfs` / `format`
- `mv ... /dev/null`

### Sudo escalation

- If a detected command is prefixed with `sudo`, the threat is escalated to **critical**.

## Notes

- The extension uses a protected-path allowlist (system roots + common home subfolders) and size threshold to decide when to prompt.
- If any threats are detected, it shows a confirmation dialog; denying blocks the command.
