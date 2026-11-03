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
  "agentName": "pi",
  "watch": false,
  "cards": false
}
```

`watch` and `cards` are persisted, not session-local: turning either on means the next session starts it too.

Mint the key in doop under **Settings → Agent keys**. `baseUrl` defaults to `http://localhost:4300`; `agentName` defaults to `pi` and is the identity used for presence, attribution and "this comment is my own".

Pointing `baseUrl` at a self-hosted instance over HTTPS works unchanged; better-auth then names the cookie `__Secure-better-auth.session_token` and the extension accepts and echoes either spelling.

Environment overrides, useful for a one-off run without touching the file: `DOOP_BASE_URL`, `DOOP_AGENT_KEY`, `DOOP_CANVAS_ID`, `DOOP_AGENT_NAME`, `DOOP_CONFIG_PATH`.

The file holds a bearer credential. It is written with mode 0600; do not commit it.

## Commands

| Command | What it does |
| --- | --- |
| `/doop bind <canvasId>` | Bind the canvas (the id in `http://localhost:4300/c/<id>`). Footer starts showing it. |
| `/doop review` | Read the open comments, fold them into a worklist, hand it to the agent as a follow-up message. |
| `/doop status` | Show base URL, bound canvas, agent name, the open/skipped counts, the watch state and whether cards are on. |
| `/doop off` | Unbind. |
| `/doop login` | Sign in with the doop account and keep only the session cookie (see Credentials). |
| `/doop logout` | Delete the stored cookie and close the socket. |
| `/doop watch on\|off` | Subscribe to the canvas WebSocket; a pushed comment wakes the agent when it settles. |
| `/doop cards on\|off` | Take canvas cards from doop and run them in this session (see Credentials for the cost). |

## Credentials

`~/.pi/agent/doop-auth.json` (also 0600) holds the better-auth session cookie and the email it belongs to — never the password. `/doop login` takes the password from the first source it finds:

1. `DOOP_PASSWORD` in the environment (scripted runs);
2. the macOS keychain entry `security add-generic-password -s pi-kit-doop -a <email> -w`;
3. one UI prompt, if neither exists.

`/doop cards on` runs canvas cards as ordinary prompts in **this** session: it spends this session's own model quota, uses this session's MCP credential (not the card's run token), and turns itself off on shutdown.

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

- **No reply/resolve wrappers.** `reply_to_comment` and `resolve_comment` are on MCP already; wrapping them would be a second contract to keep.
- **No batch/settle heuristics of its own.** What arrives on the socket is queued as-is and drained on `agent_settled`; deciding *when* to work is pi's job.

What v1 left out is now here: `/doop watch` keeps a resident WebSocket (reconnecting with backoff) instead of waiting for a human to run `/doop review`, and `/doop login` stores a session cookie instead of a password. `/doop cards` goes the other way — doop hands this session a card, and it runs on the local agent.
