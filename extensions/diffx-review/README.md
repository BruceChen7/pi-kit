# diffx-review

A Pi extension that bridges Pi and diffx, preferably via a direct `diffx` command and optionally via a local checkout fallback.

## Commands

- `/diffx-start-review [--no-open] [--host=<host>] [--port=<n>] [-- <git diff args>]`
- `/diffx-review-status`
- `/diffx-finish-review [--resolve-after-reply]`
- `/diffx-stop-review`

## Tools

- `diffx_list_comments`
- `diffx_reply_comment`
- `diffx_resolve_comment`
- `diffx_review_status`

## Configuration

Set in `~/.pi/agent/third_extension_settings.json` or `<repo>/.pi/third_extension_settings.json`:

```json
{
  "diffxReview": {
    "enabled": true,
    "diffxCommand": "diffx",
    "diffxPath": "~/work/diffx",
    "host": "127.0.0.1",
    "defaultPort": null,
    "autoOpen": true,
    "startMode": "dist",
    "reuseExistingSession": true,
    "healthcheckTimeoutMs": 1000,
    "startupTimeoutMs": 15000
  }
}
```

## Notes

- by default the extension first tries the configured `diffxCommand` (default: `diffx`)
- if the command is unavailable, it falls back to the built local CLI at `<diffxPath>/dist/cli.mjs`
- if local dist fallback is missing, the extension fails fast and asks you to build diffx first
- The diffx process is started with `cwd` set to the repo being reviewed
- diffx comments remain subject to diffx's current in-memory storage behavior
