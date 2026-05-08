# Notify Extension

Sends best-effort desktop notifications when an agent turn ends.

## Behavior

- Successful turn with assistant text: title `π`, body is the assistant summary.
- Successful turn without assistant text: title `Ready for input`, empty body.
- Failed turn: title `π failed`, body is the assistant summary or a fallback error message.
- Truncated turn: title `π output truncated`, body is the partial assistant summary or a fallback message.
- Aborted turn: skipped by default. Set `notify.notifyOnAbort` to `true` to send `π stopped`.

Failure, truncation, and aborted notifications do not emit the `notify.idle` internal event. That
keeps the idle event focused on successful ready-for-input turns.

## Transport

Notifications use OSC 777:

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
