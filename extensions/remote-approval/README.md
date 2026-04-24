# remote-approval

A Pi extension for interactive TUI sessions that mirrors the core `cc-remote-approval` workflow inside Pi.

It sends Telegram approval and idle-continuation messages so you can keep a Pi session moving while away from the terminal.

## Scope

v1 supports:

- remote fallback for approval events emitted by internal extensions
- delayed Telegram delivery when local handling has not completed within `approvalTimeoutMs`
- idle notifications emitted by `extensions/notify/`
- destructive-command approval events emitted by `extensions/safe-delete/`
- `Continue / Dismiss` for idle events
- reply-anchored continuation instructions via `pi.sendUserMessage()`
- multi-session routing within one Telegram bot/chat
- short context preview + `Full context` reply-thread expansion

v1 does **not** support:

- print / RPC / headless usage
- remote questionnaires/forms
- Slack / Discord channels
- restoring in-flight requests across restart

## Configuration

Set values in either:

- `~/.pi/agent/third_extension_settings.json`
- `<repo>/.pi/third_extension_settings.json`

Credentials should live in the global settings file. Project settings should only override behavior.

Recommended setup:

```json
{
  "remoteApproval": {
    "enabled": true,
    "channelType": "telegram",
    "botToken": "123456:ABC...",
    "chatId": "123456789",
    "strictRemote": true,
    "interceptTools": [],
    "extraInterceptTools": [],
    "idleEnabled": true,
    "continueEnabled": true,
    "contextTurns": 3,
    "contextMaxChars": 200,
    "approvalTimeoutMs": 0,
    "requestTtlSeconds": 600
  }
}
```

## Config fields

- `enabled`: master on/off switch
- `channelType`: currently only `telegram`
- `botToken`: Telegram bot token (global)
- `chatId`: Telegram chat id (global)
- `strictRemote`: if `true` (default), remote approval events that cannot reach Telegram resolve as denied; set to `false` to wait for the local decision instead
- `interceptTools`: deprecated; kept for settings compatibility and no longer used by `remote-approval`
- `extraInterceptTools`: deprecated; kept for settings compatibility and no longer used by `remote-approval`
- `idleEnabled`: send remote idle messages for idle events emitted by `notify`
- `continueEnabled`: include `Continue` in idle messages
- `contextTurns`: number of turns in preview/full-context extraction
- `contextMaxChars`: preview truncation limit per turn
- `approvalTimeoutMs`: delay before escalating unhandled internal events to Telegram; `0` escalates immediately
- `requestTtlSeconds`: pending Telegram update TTL for shared polling state

## Behavior

### Approval flow

`remote-approval` does not subscribe to `tool_call` or intercept commands directly.
Internal extensions emit approval events on the shared Pi event bus instead.

For `safe-delete` events:

1. `safe-delete` detects a destructive command and starts the native local confirmation.
2. It emits a `safe-delete.approval` event with the local decision promise.
3. `remote-approval` waits `approvalTimeoutMs`.
4. If the local decision is still pending, it sends a Telegram approval message.
5. The first local or remote decision resolves the `safe-delete` confirmation.

Telegram approval buttons:

- `✅ Allow`
- `❌ Deny`
- `📖 Full context` (when context is available)

### Idle / continue flow

`notify` emits an idle event after it sends the local desktop notification.
If the event has not been marked handled after `approvalTimeoutMs`, `remote-approval` sends:

- `✏️ Continue`
- `❌ Dismiss`
- `📖 Full context` (when context is available)

`Continue` sends a force-reply prompt. The reply text is injected back into Pi with `pi.sendUserMessage()`.

## Multi-session routing

Multiple Pi sessions can share one Telegram bot/chat.

Routing rules:

- callbacks route by Telegram `message_id`
- reply text routes by `reply_to_message.message_id`
- bare text is ignored
- updates are coordinated through a shared lock/offset/pending queue under `$TMPDIR/pi-kit/remote-approval/telegram/`

## Logging

The extension uses `extensions/shared/logger.ts` under the `remote-approval` logger name.

Useful events currently logged:

- `session_start`
- `notify_idle_remote_request_created`
- `notify_idle_remote_skipped_handled`
- `safe_delete_remote_skipped_local_resolved`
- `session_shutdown`

Logging respects the shared third-extension log settings in `~/.pi/agent/third_extension_settings.json`.

## Notes

- v1 is designed for interactive TUI mode only
- in-flight approval or idle requests are not restored across restart
- secret masking and preview truncation are part of the extension design; do not rely on Telegram as a secure audit log
