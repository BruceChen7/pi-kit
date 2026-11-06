# Notify Extension

Sends best-effort desktop notifications when a run settles (`agent_settled`), i.e. when Pi
will not continue on its own and is waiting for input.

## Behavior

- Successful run with assistant text: title `π`, body is the assistant summary.
- Successful run without assistant text: title `Ready for input`, empty body.
- Failed run: title `π failed`, body is the assistant summary or a fallback error message.
- Truncated run: title `π output truncated`, body is the partial assistant summary or a fallback message.
- Aborted run: skipped by default. Set `notify.notifyOnAbort` to `true` to send `π stopped`.

The trigger is `agent_settled`, not `agent_end`. `agent_end` closes one low-level run, after
which Pi may still auto-retry, compact and retry, or continue with queued follow-up messages;
notifying there fires spurious or repeated notifications. One notification per settled run.

The notification body is read from the session branch at settle time: only messages after the
last user message count, so earlier turns never leak into the summary. `agent_settled` itself
only carries `aborted`, so abort status comes from the event and error/truncation status from
the last assistant message's `stopReason`.

Failure, truncation, and aborted notifications do not emit the `notify.idle` internal event. That
keeps the idle event focused on successful ready-for-input runs.

## Duplicate loads

Pi loads one extension per entry path and dedupes by path, not by resolved file. Two symlinks to
the same extension (`notify/` and `notify.ts` in the same extensions directory) therefore register
two `agent_settled` handlers and send every notification twice.

`install-plugins.sh` prunes the abandoned symlink when a plugin switches shape. As a safety net the
extension also claims each dispatch: pi hands every handler of one dispatch the same context
object, so the second instance sees the claim and returns without notifying. Different sessions,
later turns, and reloads get fresh context objects and keep notifying normally.

## Transport

The transport is picked from the **host profile** (`shared/ui-host.ts`), not by sniffing the
environment. One host, one channel:

| Profile `notifications` | Channel |
| --- | --- |
| `terminal` | OSC 777 (on a herdr pane: the `herdr notification show` CLI) |
| `host-ui` | the host's own `ctx.ui.notify` — pi-web's NoticeShelf, the nsh client's toast |
| `none` | dropped (headless `json` / `print`) |

The terminal channel writes OSC 777:

```text
ESC ] 777 ; notify ; title ; body BEL
```

Supported terminals include Ghostty, iTerm2, WezTerm, and rxvt-unicode. Unsupported terminals may
ignore the payload. The extension treats notification transport as best-effort: stdout write errors
are logged and do not fail the agent turn.

When running inside tmux, the extension wraps OSC 777 in tmux passthrough and prefixes the title
with the tmux window name when available.

Notification title and body fields are sanitized before writing the OSC payload so ESC, BEL, and
other control characters from assistant output cannot break the notification sequence.

### Why not sniff the environment

`HERDR_PANE_ID` / `TMUX` / `TERM_PROGRAM` only say which terminal started the process — not who is
reading its stdout. The pi-clients worker (`server/worker`) is launched from a herdr pane, so it
inherits all three, but its stdout is a log: the OSC 777 payload landed in `worker.log` while the
app never showed a toast. Only the host profile knows where a notification can actually reach a
person, so the transport follows it. A `host-ui` host whose `ctx.ui.notify` is missing counts as
"nowhere to send", never as a reason to fall back to the terminal.

## Configuration

Settings are read from `notify` in `.pi/third_extension_settings.json` or the global Pi settings
file.

```json
{
  "notify": {
    "enabled": true,
    "notifyOnAbort": false,
    "notifyOnFailure": true,
    "notifyOnTruncation": true,
    "maxBodyChars": 200
  }
}
```

Options:
- `enabled`: enable or disable all notify behavior. Default: `true`.
- `notifyOnAbort`: notify when the user aborts a turn. Default: `false`.
- `notifyOnFailure`: notify on error turns. Default: `true`.
- `notifyOnTruncation`: notify when output is truncated. Default: `true`.
- `maxBodyChars`: maximum notification body length after markdown simplification. Default: `200`.

## Package registration

This extension is not registered in the root `package.json` by default. Add `./extensions/notify`
to the package extension list if you want every loaded pi-kit session to emit desktop notifications.
