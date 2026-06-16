# Format & Lint: Generic / Unknown

Fallback for projects that don't match JS/TS, Go, Python, or Rust ecosystems.

## Detection

Try these approaches in order:

### 1. Makefile targets

```bash
make fmt    # format
make lint   # lint
make check  # combined format + lint
```

### 2. Editor / IDE config files

| Config file | Likely tool |
|---|---|
| `.editorconfig` | EditorConfig (basic formatting) |
| `.clang-format` | clang-format (C/C++, Objective-C, Java, etc.) |
| `.cmake-format` | cmake-format |
| `.pre-commit-config.yaml` | pre-commit (multi-tool orchestration) |

### 3. Ask the user

If no tooling is detected, ask the user whether they have any format/lint expectations
before committing.

## Execution

### Format (auto-fix mode)

- **Makefile** `fmt` target: `make fmt`
- **clang-format**: `clang-format -i --style=file <files>`
- **pre-commit**: `pre-commit run --all-files`
- **EditorConfig**: no auto-fix needed (editor handles it)

### Lint (check-only mode)

- **Makefile** `lint` target: `make lint`
- **pre-commit**: `pre-commit run --all-files`

## Result

If no tooling is found, skip — it is not a blocker.
