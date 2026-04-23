# remote-approval

A Pi extension for interactive TUI sessions that mirrors the core `cc-remote-approval` workflow inside Pi.

It sends Telegram approval and idle-continuation messages so you can keep a Pi session moving while away from the terminal.

## Scope

v1 supports:

- remote approval for `bash`, `write`, and `edit` by default
- project-configurable extra intercepted tool names
- local approval UI + Telegram approval running in parallel
- session-scoped `Always`
- idle notifications on every `agent_end`
- `Continue / Dismiss`
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
    "strictRemote": false,
    "interceptTools": ["bash", "write", "edit"],
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
- `strictRemote`: if `true`, block approval when remote approval is required but unavailable
- `interceptTools`: default intercepted built-in tools
- `extraInterceptTools`: additional custom tool names to intercept
- `idleEnabled`: send idle messages on `agent_end`
- `continueEnabled`: include `Continue` in idle messages
- `contextTurns`: number of turns in preview/full-context extraction
- `contextMaxChars`: preview truncation limit per turn
- `approvalTimeoutMs`: reserved for future timeout policy; `0` means no timeout behavior in v1
- `requestTtlSeconds`: pending Telegram update TTL for shared polling state

## Behavior

### Approval flow

When an intercepted tool is called:

1. Pi shows a local approval UI.
2. The extension sends a Telegram approval message.
3. Either side can resolve first.
4. `Always` stores a session-scoped allow rule using Pi custom entries.

Telegram approval buttons:

- `✅ Allow`
- `✅ Always`
- `❌ Deny`
- `📖 Full context` (when context is available)

### Idle / continue flow

On every `agent_end` the extension sends:

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
- `approval_skipped_allow_rule`
- `approval_unavailable`
- `approval_resolved`
- `allow_rule_persisted`
- `idle_request_created`
- `session_shutdown`

Logging respects the shared third-extension log settings in `~/.pi/agent/third_extension_settings.json`.

## Notes

- v1 is designed for interactive TUI mode only
- in-flight approval or idle requests are not restored across restart
- secret masking and preview truncation are part of the extension design; do not rely on Telegram as a secure audit log
