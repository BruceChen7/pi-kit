# Format & Lint Quality Gate

Reference for detecting and running project-level formatting and linting tools before commit.

This file is a **router**: it detects the project language/ecosystem and points you to the
appropriate sub-file. Each sub-file covers tool detection, format execution, lint execution,
and known caveats for that ecosystem.

## Detection: identify project ecosystem

Check the project root for these files **in parallel** (no priority order). The first match
determines the primary ecosystem:

| Root file detected | Ecosystem | Route to |
|---|---|---|
| `package.json` | JS / TypeScript | [`./format-lint-js-ts.md`](./format-lint-js-ts.md) |
| `go.mod` | Go | [`./format-lint-go.md`](./format-lint-go.md) |
| `pyproject.toml` or `setup.py` or `setup.cfg` or `requirements.txt` | Python | [`./format-lint-python.md`](./format-lint-python.md) |
| `Cargo.toml` | Rust | [`./format-lint-rust.md`](./format-lint-rust.md) |
| `Makefile` (with `fmt` or `lint` targets) or none of the above | Generic / unknown | [`./format-lint-generic.md`](./format-lint-generic.md) |

If multiple ecosystem markers exist (e.g., `package.json` + `go.mod` in a monorepo), read
the relevant sub-files for **all** detected ecosystems and run each.

## Pass/Fail determination (shared across all ecosystems)

| Condition | Result |
|---|---|
| Tool not found / not configured | Skip — not a blocker |
| Format runs with warnings | Pass (warnings are advisory) |
| Format fails with errors | Block — report what couldn't be auto-fixed |
| Lint exits 0 | Pass |
| Lint exits non-zero | Block — show lint output to user |

## Auto-staging after format (shared across all ecosystems)

After formatting runs successfully, stage any resulting changes:

```bash
git diff --quiet || git add -A
```

This ensures formatting-only changes are included in the commit.
