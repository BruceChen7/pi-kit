---
description: Debug Shopee Space trace data — fetch full event details with opencli, save large intermediate results to files
argument-hint: "[trace-id] [--env test|live]"
---
Fetch and analyze a Shopee Space trace using `opencli space trace`. Always save large raw data to files instead of printing to the terminal.

## Workflow

1. **Fetch trace with full detail**

   **Always close truncation first.** Use `--max-event-length 0` on every call—event payloads can be 28K+ chars and you won't know until you see them.

   ```bash
   opencli space trace --trace-id <TRACE_ID> --env live --show-detail --max-event-length 0 -f json
   ```

   - `--max-event-length 0` — **required**, disables truncation
   - `--show-detail` — include span event attributes (req/resp payloads)
   - `-f json` — machine-readable output for further processing
   - If `opencli` complains about token, pass `--token <TOKEN>` explicitly

2. **Save raw event data to file**

   When you find a span of interest (e.g., `[*]get_post_products`), extract its event attributes from the raw API response and save to a file:

   ```bash
   mkdir -p ~/.space/traces/
   ```

   Pipe the `opencli space trace` JSON output through `jq` (see example below) to extract specific event attributes (e.g., `resp.data`) to a file under `~/.space/traces/`. Name the file descriptively, e.g.:

   - `~/.space/traces/<trace-id>-<span-operation>-resp.json`
   - `~/.space/traces/<trace-id>-<span-operation>-req.json`

3. **Work with the file**

   - Read the file with `read` to inspect its content
   - If the file is still too large, use `jq` or a script to extract specific fields
   - Tell the user the file path after saving

## Key gotchas

- The raw event attribute value lives at `a.value.stringValue` in the API response — NOT at `a.value` directly
- Large payloads may be split across multiple attributes with keys like `resp.Data.1`, `resp.Data.2`, … The `--show-detail` flag in the CLI now auto-merges these, but when fetching raw data via API, you must concatenate them manually
- If you print a large JSON string (>2000 chars) to the terminal, it will be truncated. Always save to file first

## File naming convention

```
~/.space/traces/<trace-id>-<span-id>-<operation-slug>-<attr-key>.json
```

Example:
```
~/.space/traces/b11ba3af53-0700004e125f-get_post_products-resp.json
```

## Example: extracting event attribute to file via opencli + jq

You already fetched the full trace with `opencli space trace --show-detail`. Pipe its JSON output through `jq` to extract the desired attribute without writing a separate script:

```bash
opencli space trace --trace-id <TRACE_ID> --env live --show-detail --max-event-length 0 -f json \
  | jq '.spans[] | select(.operation == "[*]get_post_products") | .events[].attributes[] | select(.key == "resp.data") | .value.stringValue' \
  > ~/.space/traces/<trace-id>-get_post_products-resp.json
```

If the attribute value is a JSON string itself (common for `resp.data`/`req.data`), remove the outer quotes and parse it:

```bash
opencli space trace --trace-id <TRACE_ID> --env live --show-detail --max-event-length 0 -f json \
  | jq -r '.spans[] | select(.operation == "[*]get_post_products") | .events[].attributes[] | select(.key == "resp.data") | .value.stringValue' \
  | jq '.' \
  > ~/.space/traces/<trace-id>-get_post_products-resp.json
```

| Piece | Purpose |
|---|---|
| `-r` | raw output — strips surrounding JSON quotes |
| `jq '.'` | re-parse the string as JSON and pretty-print |
| `> file` | save to file (never print large payloads to terminal) |

Need a different attribute? Just change `.key == "resp.data"` to the field you want (e.g., `req.data`, `error.message`, `db.statement`).

Trace ID: ${1:-}
Environment: ${2:-live}
