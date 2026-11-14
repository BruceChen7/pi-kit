# Safe Delete Extension

This extension intercepts **bash** tool calls and prompts for confirmation when a command looks destructive.

## Hooked tool

- **Tool:** `bash`
- **Event:** `tool_call`（经共享护栏流水线，阶段 id `safe-delete`，kind `ask`）
- Only runs when `ctx.hasUI` is true (so it can prompt for confirmation).

## Commands & patterns it detects

> The extension analyzes the full command through the shared shell structure layer
> (`extensions/shared/shell/`): it splits pipelines/compound commands, ignores heredoc
> bodies (a script you _write_ is not a script you _run_), and flattens literal nested
> scripts (`sh -c "…"`, `eval "…"`) into ordinary command segments — so
> `sh -c "rm -rf ~/Documents"` is caught too.
>
> The decision itself lives in `analyze.ts` as a pure function: directory sizes, the
> protected-path list, and the home directory are injected ports, so every branch is
> testable without touching the disk.

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
