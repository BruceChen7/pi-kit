# Format & Lint: Go

## Detection

Based on the presence of `go.mod` in the project root.

| Tool | Config file | Install check |
|---|---|---|
| **gofmt** (formatter, built-in) | — | `which gofmt` (ships with Go) |
| **go vet** (linter, built-in) | — | `which go` |

## Execution

### Format (auto-fix mode)

Format all Go source files except protobuf-generated `.pb.go` files:

```bash
fd -e go -E '*.pb.go' -X gofmt -w {}
```

If the project uses a different module path layout, narrow the scope:
```bash
fd -e go -E '*.pb.go' . '<package-dir>' -X gofmt -w {}
```

### Lint (check-only mode)

```bash
go vet ./...
```

## ⚠️ Known caveats

- `fd | gofmt -w` skips `.pb.go` files (protobuf generated code) — these should not be manually formatted.
- `gofmt -w` does not report errors for unparseable files — it silently skips them.
  Always run `go vet` after formatting to catch syntax issues.
