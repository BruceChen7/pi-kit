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

   Use Node.js or Python to fetch the raw API data and save specific event attributes (e.g., `resp.data`) to a file under `~/.space/traces/`. Name the file descriptively, e.g.:

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

## Example: extracting resp.data to file via Node.js

```js
const token = "your-token-here";

fetch("https://log.shopee.io/openapi/v1/trace/search/trace/detail", {
  method: "POST",
  headers: { "x-openapi-key": token, "Content-Type": "application/json" },
  body: JSON.stringify({ trace_id: "<TRACE_ID>" }),
})
.then(r => r.json())
.then(d => {
  const fs = require("fs");
  for (const s of d.spans || []) {
    if (s.operation === "[*]get_post_products") {
      for (const e of s.events || []) {
        for (const a of e.attributes || []) {
          if (a.key === "resp.data") {
            const raw = a.value.stringValue;
            fs.writeFileSync(path, raw, "utf-8");
            console.log("Saved:", path);
          }
        }
      }
    }
  }
})
```

Trace ID: ${1:-}
Environment: ${2:-live}
