# Format & Lint: Rust

## Detection

Based on `Cargo.toml` in the project root.

| Tool | Config file | Install check |
|---|---|---|
| **rustfmt** (formatter) | `rustfmt.toml` / `.rustfmt.toml` | `which rustfmt` (ships with rustup) |
| **clippy** (linter) | `clippy.toml` / `.clippy.toml` | `which cargo-clippy` (ships with rustup) |

Both tools ship with the Rust toolchain. If missing, suggest `rustup component add rustfmt clippy`.

## Execution

### Format (auto-fix mode)

```bash
cargo fmt
```

To check formatting without modifying (informational):
```bash
cargo fmt --check
```

### Lint (check-only mode)

```bash
cargo clippy -- -D warnings
```

## ⚠️ Known caveats

- `cargo clippy -- -D warnings` treats all clippy warnings as errors. If the project uses
  `#![allow(...)]` attributes or a clippy config file, this may produce excessive failures.
  In that case, drop `-- -D warnings` and review the output manually.
- Nightly-only clippy lints may fire if the toolchain is pinned to stable. Use the project's
  `rust-toolchain.toml` to determine the correct channel.
