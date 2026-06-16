# Format & Lint: Go

## Detection

Based on the presence of `go.mod` in the project root.

| Tool | Config file | Install check |
|---|---|---|
| **gofmt** (formatter, built-in) | — | `which gofmt` (ships with Go) |
| **go vet** (linter, built-in) | — | `which go` |
| **golangci-lint** (linter, optional) | `.golangci.yml` / `.golangci.yaml` | `which golangci-lint` |

## Execution

### Format (auto-fix mode)

```bash
gofmt -w .
```

If the project uses a different module path layout, narrow the scope:
```bash
gofmt -w ./<package-dir>
```

### Lint (check-only mode)

**Primary** (if `.golangci.yml` exists):
```bash
golangci-lint run
```

**Fallback** (always available):
```bash
go vet ./...
```

## ⚠️ Known caveats

- `gofmt -w` does not report errors for unparseable files — it silently skips them.
  Always run `go vet` or `golanci-lint` after formatting to catch syntax issues.
- If `golangci-lint` is not installed but a `.golangci.yml` exists, suggest the user install it
  (`go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`).
