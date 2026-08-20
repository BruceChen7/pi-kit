# btw

`btw` is a side-conversation plugin for pi. When the main agent is working, use
`/btw` to ask a quick question, think through an idea, or prepare context
without interrupting the active run.

The side conversation happens in a **real, read-only pi sub-session** that can
inspect the repository, and its answers stream into a **top-center overlay**.
Nothing reaches the main agent unless you explicitly inject it back.

## When to use it

Use `/btw` when you want to:

- Ask what the agent is doing while it continues working.
- Discuss an alternative plan without changing the current task.
- Have a side agent read files in the repo and answer with evidence.
- Draft follow-up instructions before sending them to the main agent.

## Commands

### `/btw [message]`

Open the side-conversation overlay. With a message, it asks immediately using
the current session as context; without one, it just opens the overlay on the
latest exchange.

```text
/btw is this implementation plan too risky?
/btw what does this error actually mean?
```

### `/btw:new [message]`

Start a fresh side thread (disposes the old side session). Optionally kick it
off with a message.

```text
/btw:new help me compare two API designs
```

### `/btw:clear`

Dismiss the overlay and clear the current side thread.

### `/btw:inject [instructions]`

Send the full side conversation to the main agent as follow-up context.

```text
/btw:inject implement the approach we discussed
```

### `/btw:summarize [instructions]`

Summarize the side conversation first (using a fast model), then send the
summary to the main agent.

```text
/btw:summarize use this as the implementation direction
```

`/btw:inject` and `/btw:summarize` both reset the thread and dismiss the
overlay after injecting.

## Overlay keys

The overlay is a top-center floating panel (requires the pi TUI).

| Key | Action |
|-----|--------|
| `Enter` | submit a follow-up in the input |
| `Esc` | abort while answering; close when idle |
| `c` | copy the current answer (raw markdown) to the clipboard |
| `←` / `→` | page through this session's side Q&A history |
| `↑` / `↓` | scroll a long answer |
| `Alt+/` | toggle focus between the overlay and the main editor (overlay stays visible; `Ctrl+Alt+W` as fallback) |

Earlier questions appear as a dimmed list above the current answer. History is
capped at the most recent 20 exchanges.

## How context works

Each `/btw` ask runs against a lazily-created **in-memory sub-session**:

1. Seeded with the main session's current messages.
2. Given read-only tools (`read`, `grep`, `find`, `ls`) — it can inspect the
   repository but cannot modify anything.
3. Its system prompt is composed from the main session's prompt plus a "btw
   role" prompt, so it understands your project rules.
4. Model and thinking level follow the main session's current model, re-synced
   before every ask.

Follow-ups typed into the overlay continue the same sub-session. The side
thread exists only in memory as `exchanges[]`; the main agent sees it only when
you run `/btw:inject` or `/btw:summarize`.

## Persistence / environment

- **In-memory only.** Restarting or reloading pi clears the side thread — it is
  a side note, not session state.
- **TUI only.** The overlay needs interactive TUI mode; `/btw` outside the TUI
  shows an error.
- Reads `grep` via the standard tool; no `bash`/`edit`/`write`.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Main pi session (TUI)                                    │
│  User ↔ Main agent                                        │
│                                                           │
│  /btw ──▶ overlay (top-center, ctx.ui.custom)             │
│             │ exchanges[] = display + inject 单一真源      │
│             ▼                                             │
│  read-only AgentSession 子会话 (in-memory)                │
│   ├─ seed 主会话消息 (buildSessionContext+convertToLlm)    │
│   ├─ tools: read/grep/find/ls                             │
│   ├─ 继承主会话模型 + thinking level                      │
│   └─ subscribe 事件 → overlay 实时渲染                    │
│                                                           │
│  inject/summarize → sendUserMessage(followUp) → reset     │
└──────────────────────────────────────────────────────────┘

模块：core.ts（纯逻辑）· session.ts（子会话 boot/dispose）·
      overlay.ts（展示组件）· index.ts（编排/命令）
```

## Tips

- Use `/btw` for thinking and clarification; the side agent can read files for
  you.
- Use `/btw:summarize` before injecting a long discussion.
- Use `/btw:new` when switching topics.
- Be explicit in injection instructions, for example: `implement this`, `use
  this as review feedback`, or `only consider this as background`.
