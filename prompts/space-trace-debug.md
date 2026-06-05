---
description: Debug Shopee Space trace data — fetch full event details with opencli, save large intermediate results to files
argument-hint: "[trace-id]"
---
Fetch and analyze a Shopee Space trace using `opencli space trace`. Always save large raw data to files instead of printing to the terminal.

## Quick reference

| Goal | Command |
|---|---|
| **Full raw data (preferred)** | `opencli space trace --trace-id <ID> --time-range <RANGE> --raw -f json > ~/.space/traces/<ID>-raw.json` |
| **Formatted overview** | `opencli space trace --trace-id <ID> --time-range <RANGE> --show-detail --max-event-length 500 -f json` |
| **Structured events** | `opencli space trace --trace-id <ID> --time-range <RANGE> --show-detail --max-event-length 0 -f json` |

> **`--time-range` 说明**：默认往回查 3 小时内的 trace。对于较早的 trace（如超过 3 小时），需要显式指定 `--time-range 6h` 或更大的值。建议：如果不确定 trace 时间，直接用 `--time-range 6h` 或 `--time-range 12h` 覆盖。

## Workflow

### 0. Scope — 先确认分析目标

**不要直接 fetch。先确认用户要关注什么维度：**

- **特定 operation**（如 `[*]get_post_products`、`bass.item.get_batch_item`）
- **特定 service**（如 `bass`、`voucher`、`recommend`）
- **特定关键字 field**（如 `voucher_id`、`promotion_id`、`ab.rsp`）
- **错误 spans**
- **性能热点**（慢于指定阈值）
- **完整分析**（默认仅输出 header-level 摘要，不自动展开细节提取）

根据用户的回答，选择对应的后续步骤路径，只跑相关的 jq / extract / analysis，**不要跑完整流程中的所有步骤**。

如果用户只给了 trace ID 没有说明意图，**先问清楚再动手**。

---

### 1. Preflight — verify flags before use

`opencli` CLI flags may differ from what you expect. Always confirm before constructing the command:

```bash
opencli space trace --help
```

Check that the flags you intend to use (`--raw`, `--show-detail`, `--max-event-length`, etc.) actually exist.

### 2. Fetch raw trace data (preferred path)

The V2 API response contains the most complete data. The CLI formatter may truncate large strings in formatted output even with `--max-event-length 0`. Use `--raw` to bypass formatter truncation entirely:

```bash
mkdir -p ~/.space/traces/
opencli space trace --trace-id <TRACE_ID> --time-range 6h --raw -f json \
  > ~/.space/traces/<TRACE_ID>-raw.json
```

- `--raw` returns the V2 API response as-is (top-level object with `spans[]` array)
- `--raw` requires `-f json`
- `--raw` ignores `--errors-only`, `--slow-threshold`, `--max-event-length`
- The V2 API has its own truncation limits (~14K–57K per event attribute), so large payloads may still contain `[cut N byte]` markers

**Caution:** `--max-event-length 0` does NOT fully prevent truncation. The CLI formatter has its own limit (~16KB per field). For unbounded data, use `--raw` or call the service directly.

### 3. Quick stats — get a bird's-eye view first

After fetching, always start with high-level stats before diving into details:

```bash
# Total spans
jq '.spans | length' ~/.space/traces/<TRACE_ID>-raw.json

# Unique services involved
jq '[.spans[].service] | unique | length' ~/.space/traces/<TRACE_ID>-raw.json

# Span count per service (sorted desc)
jq '[.spans[] | {service, operation}] | group_by(.service) | map({service: .[0].service, count: length}) | sort_by(-.count)' \
  ~/.space/traces/<TRACE_ID>-raw.json

# Error spans
jq '[.spans[] | select(.statusCode == "STATUS_CODE_ERROR")] | length' \
  ~/.space/traces/<TRACE_ID>-raw.json

# Call kind distribution
jq '[.spans[] | {kind}] | group_by(.kind) | map({kind: .[0].kind, count: length})' \
  ~/.space/traces/<TRACE_ID>-raw.json

# Redis vs RPC breakdown
jq '{
  total: .spans | length,
  redis: [.spans[] | select(.operation == "redis" or (.operation | startswith("redis ")) or (.operation | startswith("Hardy Cluster")))] | length,
  client_rpc: [.spans[] | select(.kind == "SPAN_KIND_CLIENT")] | length,
  server_rpc: [.spans[] | select(.kind == "SPAN_KIND_SERVER")] | length,
  local: [.spans[] | select(.kind == "SPAN_KIND_UNSPECIFIED")] | length
}' ~/.space/traces/<TRACE_ID>-raw.json
```

### 4. API inventory — list all unique API endpoints called

After stats, list the full set of unique API operations across services. This reveals the trace's scope before you drill in:

```bash
# All unique API endpoints (RPC + HTTP, excluding redis/infra)
jq '[.spans[]
  | select(.kind == "SPAN_KIND_CLIENT" or .kind == "SPAN_KIND_SERVER")
  | select(.operation | test("^(redis|Hardy Cluster)") | not)
  | {service, operation, kind}]
  | unique_by(.service + "@" + .operation)
  | sort_by(.service, .operation)' \
  ~/.space/traces/<TRACE_ID>-raw.json \
  > ~/.space/traces/<TRACE_ID>-api-inventory.json

# All unique operations (simple list, unsorted)
jq '[.spans[] | select(.kind == "SPAN_KIND_CLIENT" or .kind == "SPAN_KIND_SERVER") | .operation] | unique' \
  ~/.space/traces/<TRACE_ID>-raw.json

# Find the entry point (HTTP SERVER spans)
jq '.spans[] | select(.kind == "SPAN_KIND_SERVER" and (.operation | startswith("HTTP"))) | {service, operation, spanId}' \
  ~/.space/traces/<TRACE_ID>-raw.json
```

### 5. Call chain — reconstruct the invocation tree

Understand which service calls which by analyzing span kinds and parent/child relationships:

```bash
# List all CLIENT calls (caller initiating RPCs)
jq '[.spans[] | select(.kind == "SPAN_KIND_CLIENT") | {service, operation}] | unique_by(.service + "@" + .operation) | sort_by(.service, .operation)' \
  ~/.space/traces/<TRACE_ID>-raw.json

# List all SERVER handlers (callee receiving RPCs)
jq '[.spans[] | select(.kind == "SPAN_KIND_SERVER") | {service, operation}] | unique_by(.service + "@" + .operation) | sort_by(.service, .operation)' \
  ~/.space/traces/<TRACE_ID>-raw.json

# Show a specific operation and its parent to trace the chain
jq '.spans[] | select(.operation == "[*]get_post_products") | {spanId, parentSpanId: .parentSpanId, service, operation}' \
  ~/.space/traces/<TRACE_ID>-raw.json

# By convention, depth can be inferred from span_id prefix
# (first hex byte encodes call depth level)
jq '[.spans[] | select(.kind == "SPAN_KIND_CLIENT" or .kind == "SPAN_KIND_SERVER") | {depth: ((.spanId[:2] | "0x" + . | tonumber)), service, operation}] | sort_by(.depth)' \
  ~/.space/traces/<TRACE_ID>-raw.json
```

### 6. Extract specific span data to file

Once you know the field path, extract and save:

```bash
# Extract all spans that match an operation
jq '.spans[] | select(.operation == "[*]get_post_products")' \
  ~/.space/traces/<TRACE_ID>-raw.json \
  > ~/.space/traces/<TRACE_ID>-get_post_products.json

# Extract span events (attributes)
jq '.spans[] | select(.operation == "[*]get_post_products") | .events[]' \
  ~/.space/traces/<TRACE_ID>-raw.json \
  > ~/.space/traces/<TRACE_ID>-get_post_products-events.json
```

### 7. Use formatted output with structured events

If you don't need the full raw data and prefer structured JSON output, use the adapter's formatted mode. The `events_json` field provides parsed JSON objects (one level of unescaping done for you):

```bash
opencli space trace --trace-id <TRACE_ID> --show-detail --max-event-length 0 -f json \
  > ~/.space/traces/<TRACE_ID>-formatted.json
```

Then access structured data directly:

```bash
# Find a span and inspect its structured events
cat ~/.space/traces/<TRACE_ID>-formatted.json \
  | jq '.[] | select(.operation == "[*]get_post_products") | .events_json["resp.data"]' \
  > ~/.space/traces/<TRACE_ID>-get_post_products-resp.json

# Find a span by depth (deepest = most authoritative)
cat ~/.space/traces/<TRACE_ID>-formatted.json \
  | jq '[.[] | select(.operation == "[*]get_post_products")] | max_by(.depth) | .events_json["resp.data"]' \
  > ~/.space/traces/<TRACE_ID>-get_post_products-resp.json
```

| Piece | Purpose |
|---|---|
| `events_json["resp.data"]` | structured JSON (parsed, no unescaping needed) |
| `max_by(.depth)` | picks the deepest (most authoritative) span |
| `> file` | save to file (never print large payloads to terminal) |

### 8. Field name mapping awareness

The field name in the response may differ from the concept name you're thinking of. When in doubt, use the structure discovery step (step 2) instead of hardcoding field paths.

Common mappings for Shopee Video trace debugging:

| Concept | Actual field path | Description |
|---|---|---|
| voucher ID | `final_price_voucher_ids[].promotion_id` | not `voucher_id` |
| voucher code | `final_price_voucher_ids[].voucher_code` | string alias |
| A/B experiment name | `ab.rsp.hit_exp_names[]` | in `events_json` |
| A/B experiment group | `ab.rsp.hit_group_names[]` | in `events_json` |
| A/B layer key | `ab.rsp.hit_layer_keys[]` | in `events_json` |
| response data | `resp.data` | main payload (often triple-escaped JSON) |
| request data | `req.data` | request payload |

**If you're looking for a field and don't know its exact path:**

```bash
# Search all leaf paths for a keyword
jq 'paths(scalars)' ~/.space/traces/<TRACE_ID>-raw.json | grep -i '<keyword>' | sort -u
```

## Key gotchas

- **`--env` does not exist** — The `space trace` adapter has no `--env` flag. Do not use `--env live`.
- **`--time-range` defaults to 3h** — If the trace started more than 3 hours ago, the API returns empty. Specify `--time-range 6h` or longer.
- **`--max-event-length 0` is insufficient** — The CLI formatter truncates at ~16KB regardless. Use `--raw -f json` for complete data.
- **The V2 API itself truncates** — Even with `--raw`, the API may truncate values at 14K–57K with `[cut N byte]` markers.
- **Field paths differ between raw and formatted** — Raw: `.spans[].events[].attributes[].value.stringValue`. Formatted: `.[].events_json["resp.data"]`.
- **Output structure differs by mode** — `--raw` returns a single object with `{traceId, spans[], ...}`. Non-raw returns an **array** of formatted row objects (one per span). jq queries differ accordingly.
- **Same data appears at multiple depths** — Response data propagates through BFF → retrieve → core spans. Use `max_by(.depth)` to find the authoritative source.
- **Deeply nested JSON** — `resp.data` values are often JSON strings containing JSON strings (triple escaping). `events_json` handles one level of parsing for you.

## File naming convention

```
~/.space/traces/<trace-id>-<span-id-prefix>-<operation-slug>-<attr-key>.json
```

Examples (using first 10 chars of trace ID as prefix):
```
~/.space/traces/b11ba3af53-0700004e125f-get_post_products-resp.json
~/.space/traces/b11ba3af53-080000582ee8d313-abtest-GetExpGroups-ab.rsp.json
```

> The trace ID prefix (e.g. `b11ba3af53`) is the first 10 characters of the full 32-char trace ID. Use the full trace ID if you want exact file naming.

Trace ID: ${1:-}
