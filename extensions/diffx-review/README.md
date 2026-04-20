# diffx-review

A Pi extension that bridges Pi and diffx through a configured `diffx` command.

## Commands

- `/diffx-start-review [--no-open] [--host=<host>] [--port=<n>] [-- <git diff args>]`
- `/diffx-review-status`
- `/diffx-process-review [--resolve-after-reply]`
- `/diffx-stop-review`

When `/diffx-start-review` is run without explicit `git diff` args in interactive mode, it opens a compare menu with common presets:

- Working tree
- Staged
- Base branch vs HEAD
- Merge-base vs HEAD
- Single commit
- Two commits
- Custom git diff args

If interactive UI is unavailable, pass explicit diff args after `--` instead.

## Tools

- `diffx_list_comments`
- `diffx_reply_comment`
- `diffx_resolve_comment`
- `diffx_review_status`

## Configuration

Set in `~/.pi/agent/third_extension_settings.json` or `<repo>/.pi/third_extension_settings.json`.

Recommended minimal config (most users only need this):

```json
{
  "diffxReview": {
    "enabled": true,
    "diffxCommand": "diffx",
    "host": "127.0.0.1"
  }
}
```

Optional advanced overrides (only when needed):

```json
{
  "diffxReview": {
    "defaultPort": null,
    "reuseExistingSession": true,
    "healthcheckTimeoutMs": 1000,
    "startupTimeoutMs": 15000
  }
}
```

`diffxCommand` behavior:

- set it to a command string such as `"diffx"` or `"npx diffx-cli"` to launch that command directly
- if it is omitted, the extension defaults to `"diffx"`



## Usage context

Use `diffx-review` when you want Pi to work against a **specific git diff scope** instead of the whole repository.
A good default is: pick the smallest diff that matches your review goal.

Common goals:

- **Pre-commit self-check**: review only staged changes (`--cached`)
- **Branch/PR review**: review your branch delta against base (`main..HEAD`)
- **Clean PR-only review**: review only commits unique to your branch (`origin/main...HEAD`)
- **Ad-hoc investigation**: use interactive compare menu and pick custom diff args

## Examples

```bash
/diffx-start-review
```

- opens the compare menu in interactive mode (best for exploratory/manual choice)

```bash
/diffx-start-review -- --cached
```

- reviews staged changes only (typical before commit)

```bash
/diffx-start-review -- main..HEAD
```

- compares current branch vs `main` (typical for feature branch review)

```bash
/diffx-start-review -- origin/main...HEAD
```

- compares from merge-base with `origin/main` (typical for PR-equivalent diff)

## Common user workflow

1. **Start a review session** with the right diff scope:
   - interactive: `/diffx-start-review`
   - explicit args: `/diffx-start-review -- <git diff args>`
2. **Load comments into the agent** with `/diffx-process-review`.
3. **Let Pi process comments** via diffx tools (`list`, `reply`, `resolve`) while editing code.
4. **Check progress** any time with `/diffx-review-status`.
5. **Stop the session** with `/diffx-stop-review` when you are done with the review server.

## Notes

- by default the extension starts the configured `diffxCommand` (default: `diffx`)
- The diffx process is started with `cwd` set to the repo being reviewed
- session metadata is persisted in the repo so Pi can reconnect to a still-running diffx server after restart
- diffx comments remain subject to diffx's current in-memory storage behavior
