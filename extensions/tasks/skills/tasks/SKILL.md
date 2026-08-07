---
name: tasks
description: >-
  Discover, read, update, and report progress on tracked tasks (Linear-style
  task tracker). Use when the user asks to create a task, check task status,
  list open work, comment on a task, or move work through statuses. Task keys
  look like TASK-1 or PROD-3.
---

# Tasks

The tasks extension is a Linear-style tracker for planning and tracking work.
Use it to keep the user's work visible and to report progress as you work.

## Task keys

Tasks are identified by keys like `TASK-1`. The prefix identifies the project
(`TASK` → the project with prefix `TASK`), the number is a per-project
counter. Keys are case-insensitive: `task-1` and `TASK-1` refer to the same
task. When the user mentions a key or a task title, resolve it with
`task_show`.

## Workflow

1. **Discover** — When starting work, run `task_list` to see open tasks and
   their statuses. If the user references a task, run `task_show <key>` for
   the full description and comments.
2. **Own it** — When you start working on a task, update it to `in_progress`:
   `task_update <key> --status in_progress` (via the tool `task_update` with
   `status: "in_progress"`).
3. **Report progress** — Leave substantive milestone comments with
   `task_comment` as you make progress. Explain what you did, what you
   learned, and what remains.
4. **Finish or block** — When a task is done, set `status: "done"`. If you
   cannot proceed, set `status: "in_review"` or `canceled` and explain the
   blockage in a comment.

## Statuses

- `backlog` — not yet planned for work
- `todo` — planned, not started
- `in_progress` — actively being worked on
- `in_review` — work complete, awaiting review
- `done` — completed
- `canceled` — will not be done

Priorities: `urgent`, `high`, `medium`, `low`, `none`.

## Tools

| Tool | Use |
|------|-----|
| `task_list` | List tasks in a project, filtered by status/search |
| `task_show` | Show a task's full details by key |
| `task_create` | Create a new task (needs a project id or prefix) |
| `task_update` | Update status/priority/title/description |
| `task_comment` | Add a progress comment |
| `task_board_move` | Move a task to a new status column |
| `task_delegate` | Delegate a task to a herdr agent (spawns a full pi session) |
| `task_project_list` | List available projects |
| `task_project_create` | Create a new project |

## Delegation

When the user asks to "delegate" a task (or says "have an agent do it",
"spin up an agent for it"), use `task_delegate`:

- Requires `herdr` to be available; the delegated agent runs in a new herdr
  tab as a full pi session with all extensions (task tools included).
- The task auto-advances to `in_progress` and gets a system comment.
- The delegated agent reports back via `task_comment` and finishes with
  `task_update --status in_review`.
- A task already delegated cannot be delegated again (error is explicit).
- If delegation fails, a system comment records the failure and the task
  state is unchanged.

## Guidelines

- **Prefer updates over chat**: when the user asks you to track work, write
  it to the task store rather than only acknowledging in conversation.
- **Comment before updating status**: a status change without an explanatory
  comment is hard to audit. Leave a short comment for `in_progress` starts and
  any `done`/`canceled` transitions.
- **Respect existing state**: read the task before mutating; never clobber a
  title or description the user wrote unless asked.
- **One project, one prefix**: `task_project_list` tells you which projects
  exist. Use the prefix the user references; fall back to the first project
  when ambiguous.
- **Subtasks**: `task_create` with `parentTaskId` creates a sub-task. Use it
  to break large tasks into verifiable chunks.
