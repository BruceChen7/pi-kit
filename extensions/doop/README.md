# doop Extension

Pi-kit extension for a [doop](https://github.com/kgoedecke/doop) canvas: bind one canvas to the session, then read its open comments as an ordered worklist.

The 42 doop design tools are **not** re-implemented here. They stay in the doop MCP server; this extension only owns what MCP cannot: a bound canvas, a stable shape for "what is open", and a footer line that says which canvas that is.

## Configuration

`~/.pi/agent/doop.json` (created by `/doop bind`, or write it yourself, mode 0600):

```json
{
  "baseUrl": "http://localhost:4300",
  "agentKey": "dpk_...",
  "canvasId": "U43rjP-JxT",
  "agentName": "pi"
}
```

Mint the key in doop under **Settings → Agent keys**. `baseUrl` defaults to `http://localhost:4300`; `agentName` defaults to `pi` and is the identity used for presence, attribution and "this comment is my own".

Environment overrides, useful for a one-off run without touching the file: `DOOP_BASE_URL`, `DOOP_AGENT_KEY`, `DOOP_CANVAS_ID`, `DOOP_AGENT_NAME`, `DOOP_CONFIG_PATH`.

The file holds a bearer credential. It is written with mode 0600; do not commit it.

## Commands

| Command | What it does |
| --- | --- |
| `/doop bind <canvasId>` | Bind the canvas (the id in `http://localhost:4300/c/<id>`). Footer starts showing it. |
| `/doop review` | Read the open comments, fold them into a worklist, hand it to the agent as a follow-up message. |
| `/doop status` | Show base URL, bound canvas, agent name, and the open/skipped counts. |
| `/doop off` | Unbind. |

## Tool

`doop_comments({ canvas_id? })` — read-only. Returns the worklist of the bound canvas (or `canvas_id` when given):

```
doop canvas U43rjP-JxT: 2 open comments (1 skipped: resolved, ours, or no usable anchor)

1. comment c1 — element cta in frame f1 — rich
   make the CTA solid
   anchor html: <button data-doop-id="cta">Book</button>
```

with a matching `structuredContent` of `{ canvasId, items, skipped }` for codemode scripts. A failure comes back as `{ canvasId, items: [], skipped: 0, error }` plus the next step in the text: re-mint the key (auth), start the server (unreachable), fix the canvas id (canvas), or read the doop version (protocol).

## What the worklist already decided

- Resolved threads are dropped, not shown as history.
- Replies fold into their root and are counted; they are not separate items.
- A thread this agent opened is dropped unless a human replied to it.
- Duplicate ids collapse; oldest first.
- A comment with no usable anchor (no `frameId`, no `pageId`) is skipped rather than guessed.

That makes the list a function of the server's state: running `/doop review` twice gives the same answer, and the only thing that closes a thread is `resolve_comment` on the canvas.

## Not in v1

- **No resident loop.** Nothing polls or wakes the agent; the list is produced when a human runs `/doop review` or the model calls `doop_comments`.
- **No reply/resolve wrappers.** `reply_to_comment` and `resolve_comment` are on MCP already; wrapping them would be a second contract to keep.
- **No WebSocket.** `/ws` authenticates with a better-auth session cookie, not an agent key, so subscribing would mean storing a password or a browser flow. That is a v2 decision, and it would also need a doop server change to subscribe without joining presence.
