# Format & Lint: JS / TypeScript

## Detection (try in order)

### 1. Check package.json scripts

Read `package.json` and look for known script keys:

| Key pattern | Likely tool |
|---|---|
| `format`, `fmt` | Prettier, Biome |
| `lint`, `lint:check` | ESLint, Biome |
| `check` | Biome check, combined lint |
| `biome:*` | Biome |
| `eslint` | ESLint |
| `prettier:*` | Prettier |

If found, use the exact script command — prefer the project's package manager
(`npm run`, `yarn`, `pnpm`) over `npx`.

### 2. Check config files on disk

Look for these files in the project root:

- `biome.json` / `biome.jsonc` — Biome (formatter + linter)
- `.eslintrc.js` / `.eslintrc.json` / `.eslintrc.yaml` / `eslint.config.js` — ESLint
- `.prettierrc` / `.prettierrc.json` / `.prettierrc.js` / `.prettierrc.yaml` — Prettier

### 3. Fallback: npx-based detection

If neither scripts nor config files give a clear answer, probe with:

```bash
npx --yes biome --version 2>/dev/null
npx eslint --version 2>/dev/null
npx prettier --version 2>/dev/null
```

Prefer tool order: Biome → ESLint + Prettier.

## Execution

### Format (auto-fix mode)

- **Biome**: `npx biome format --write .`
- **Prettier**: `npx prettier --write .`
- **package.json script**: `npm run format` (or `yarn format` / `pnpm format`)

### Lint (check-only mode)

- **Biome**: `npx biome lint .`
- **ESLint**: `npx eslint .`
- **package.json script**: `npm run lint` (or `yarn lint` / `pnpm lint`)

> **Note**: Some tools (e.g., Biome `check`) bundle format and lint together. When available,
> prefer separate format + lint commands for clearer failure reporting.

## ⚠️ Known caveats

### Biome + Svelte: `noUnusedVariables` false positives

Biome's Svelte support only parses the `<script>` block — it **cannot see variables referenced
in the template (HTML)**. This causes `lint/correctness/noUnusedVariables` to fire on nearly
every `.svelte` file.

**Mitigation**: Disable the rule under a Svelte override in `biome.json`:
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

If the project doesn't have this override yet, manually skip `noUnusedVariables` reports for
`.svelte` files — do not trust Biome's output on this rule for Svelte.
