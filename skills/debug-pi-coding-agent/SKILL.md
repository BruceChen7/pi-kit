---
name: debug-pi-coding-agent
description: Use when pi-coding-agent extensions or plugins behave unexpectedly, logs are missing, slash commands/hooks/tools do not fire, or TUI/RPC behavior differs from expected.
---

# Debug Pi Coding Agent

## Overview

Debug pi extension failures from code to logs: identify the loaded extension path and logger tag, ensure useful branch logs exist, enable debug logging, then analyze the exact log stream.

## When to Use

Use for pi-coding-agent or pi-kit issues involving `extensions/` plugins, custom tools, slash commands, hooks, `ctx.ui`, `/reload`, missing logs, or TUI/RPC differences. Do not use for ordinary app bugs unrelated to pi extensions.

## Quick Reference

| Need | Check |
|---|---|
| Plugin code | `extensions/<plugin>/index.ts` or package `pi.extensions` |
| Logger tag | `createLogger("tag", { stderr: null })` |
| Debug config | `~/.pi/agent/third_extension_settings.json` |
| Default log | `~/.pi/agent/pi-debug.log` |
| Filter extension | `rg '\[ext:<name>\]' ~/.pi/agent/pi-debug.log` |
| Apply changes | `/reload` or restart pi |
| Raw TUI ANSI | `PI_TUI_WRITE_LOG=/tmp/tui-ansi.log ...` |

## Workflow

1. Inspect `extensions/<plugin>` first. Confirm how it loads, the events/tools/commands it registers, and the exact logger tag.
2. Check key logs exist before reproducing:
   - startup/config: `session_start`, config loaded, reload path
   - skip branches: disabled, no UI, no repo, missing path, excluded command
   - external work: command args, HTTP status, child exit, sanitized error
   - outcomes: accepted, skipped, blocked, completed
3. Enable global third-extension debug logging:

```json
{
  "third_extensions": {
    "log": {
      "minLevel": "debug"
    }
  }
}
```

Use `~/.pi/agent/third_extension_settings.json`, not pi core `~/.pi/agent/settings.json`. Omit `logFilePath` for the default `~/.pi/agent/pi-debug.log`; if overriding, use an absolute path or `$ENV_VAR`, not `~`.

4. `/reload` or restart pi, reproduce once, then inspect:

```bash
log=~/.pi/agent/pi-debug.log
rg '\[ext:<name>\]' "$log"
rg '<event-or-message-fragment>' "$log"
tail -200 "$log"
```

Read lines as `[ext:<name>][level][timestamp] message {json}`. Find the first unexpected skip, missing event, stale config, wrong cwd, thrown error, or absent reload.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Editing pi core settings for extension log level | Use `third_extension_settings.json` |
| Searching logs before reading code | First identify the tag and expected messages |
| Logging only success | Add skip/error branch logs with context |
| `logFilePath: "~/.pi/..."` | Omit it or use absolute path / `$ENV_VAR` |
| No logs after settings edit | `/reload`, restart, and confirm `logFilePath` is not `null` |
| Logging secrets | Sanitize tokens, URLs, headers, payloads |

## Extra Pi Debug Hooks

- Hidden `/debug` writes rendered TUI lines and recent LLM messages to `~/.pi/agent/pi-debug.log`.
- For raw TUI output, start pi or the repro with `PI_TUI_WRITE_LOG=/tmp/tui-ansi.log`.
