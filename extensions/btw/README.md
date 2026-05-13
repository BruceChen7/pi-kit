# btw

`btw` is a side conversation plugin for pi. Use it when the main agent is working and you want to ask a quick question, think through an idea, or prepare context without interrupting the active run.

The side conversation is separate from the main agent by default. The main agent will not see your `btw` messages unless you explicitly inject or summarize them back into the main session.

## When to use it

Use `/btw` when you want to:

- Ask what the agent is doing while it continues working.
- Discuss an alternative plan without changing the current task.
- Draft follow-up instructions before sending them to the main agent.
- Keep a short side thread during a long implementation or review.

## Commands

### `/btw <message>`

Ask a side question using the current session as context.

```text
/btw is this implementation plan too risky?
```

The answer appears in a small widget above the editor. This does not send anything to the main agent.

### `/btw:new [message]`

Start a fresh side thread. If you include a message, it asks that question immediately.

```text
/btw:new help me compare two API designs
```

Use this when the previous side conversation is no longer relevant.

### `/btw:clear`

Dismiss the widget and clear the current side thread.

```text
/btw:clear
```

### `/btw:inject [instructions]`

Send the full side conversation to the main agent as follow-up context.

```text
/btw:inject implement the approach we discussed
```

Use this when the side conversation contains details the main agent should act on. After injection, the side thread is cleared.

### `/btw:summarize [instructions]`

Summarize the side conversation first, then send the summary to the main agent.

```text
/btw:summarize use this as the implementation direction
```

Use this instead of `/btw:inject` when the side thread is long or noisy. After the summary is injected, the side thread is cleared.

## Widget controls

- The `btw` widget appears above the editor.
- It shows the latest exchange by default.
- Press `ctrl+shift+b` to expand or collapse long output.
- Run `/btw:clear` to dismiss it.

## How context works

Each `/btw` message sees:

1. The visible main session conversation so far.
2. Previous messages in the current `btw` side thread.
3. Your new side question.

The main agent does not automatically see the side thread. To bring side-thread context back into the main session, use `/btw:inject` or `/btw:summarize`.

## Persistence

`btw` side conversations are saved with the session and restored after restart. Clearing, injecting, summarizing, or starting a new thread creates a reset point so old side messages do not leak into the next thread.

## Tips

- Use `/btw` for thinking and clarification.
- Use `/btw:summarize` before injecting a long discussion.
- Use `/btw:new` when switching topics.
- Be explicit in injection instructions, for example: `implement this`, `use this as review feedback`, or `only consider this as background`.
