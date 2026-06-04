# Format & Lint Quality Gate

Reference for detecting and running project-level formatting and linting tools before commit.

## Detection (try in order)

### 1. Check package.json scripts

Read `package.json` and look for known script keys:

| Key pattern | Likely tool |
|---|---|
| `format`, `fmt` | Prettier, Biome, gofmt |
| `lint`, `lint:check` | ESLint, Biome, golangci-lint |
| `check` | Biome check, combined lint |
| `biome:*` | Biome |
| `eslint` | ESLint |
| `prettier:*` | Prettier |

If found, use the exact script command: `npm run <script>`.

### 2. Check config files on disk

Look for these files in the project root:

- `biome.json` / `biome.jsonc` — Biome (formatter + linter)
- `.eslintrc.js` / `.eslintrc.json` / `.eslintrc.yaml` / `eslint.config.js` — ESLint
- `.prettierrc` / `.prettierrc.json` / `.prettierrc.js` / `.prettierrc.yaml` — Prettier
- `.golangci.yml` / `.golangci.yaml` — golangci-lint
- `go.mod` — Go project (gofmt / go vet)
- `.rustfmt.toml` / `Cargo.toml` — Rust (rustfmt / clippy)

### 3. Fallback: npx-based detection

If neither scripts nor config files give a clear answer, probe with:

```bash
npx --yes biome --version 2>/dev/null
npx eslint --version 2>/dev/null
npx prettier --version 2>/dev/null
```

Prefer tool order: Biome → ESLint + Prettier → golangci-lint → language-native tools.

## Execution

### Format (auto-fix mode)

Run the formatter in write mode so changes are applied automatically:

- **Biome**: `npx biome format --write .`
- **Prettier**: `npx prettier --write .`
- **Go**: `gofmt -w .`
- **Rust**: `cargo fmt`
- **package.json script**: `npm run format`

### Lint (check-only mode)

Run the linter in check mode. Do NOT auto-fix lint issues — they need human review:

- **Biome**: `npx biome lint .`
- **ESLint**: `npx eslint .`
- **golangci-lint**: `golangci-lint run`
- **Go vet**: `go vet ./...`
- **Clippy**: `cargo clippy`
- **package.json script**: `npm run lint`

> **Note**: Some tools (e.g., Biome `check`) bundle format and lint together. When available, prefer separate format + lint commands for clearer failure reporting.

## ⚠️ Known caveats

### Biome + Svelte: `noUnusedVariables` 误报

Biome 的 Svelte 支持只解析 `<script>` 块，**无法看到 template（HTML）中引用的变量**。因此 `lint/correctness/noUnusedVariables` 会对 `.svelte` 文件大量误报。

**对策**：在项目 `biome.json` 的 Svelte override 中关闭此规则：
```json
{
  "includes": ["*.svelte"],
  "linter": {
    "rules": {
      "correctness": {
        "noUnusedVariables": "off"
      }
    }
  }
}
```

如果项目还未配置，手动跳过 `.svelte` 文件的 `noUnusedVariables` 检查，不要信任 Biome 对此规则的 Svelte 报告。

## Pass/Fail determination

| Condition | Result |
|---|---|
| Tool not found / not configured | Skip — not a blocker |
| Format runs with warnings | Pass (warnings are advisory) |
| Format fails with errors | Block — report what couldn't be auto-fixed |
| Lint exits 0 | Pass |
| Lint exits non-zero | Block — show lint output to user |

## Auto-staging after format

After formatting runs successfully, stage any resulting changes:

```bash
git diff --quiet || git add -A
```

This ensures formatting-only changes are included in the commit.
