# env-guard

Ensure the agent uses standard tools by overriding environment variables and normalizing git diff flags when sessions start or switch.

## Defaults

If no configuration is provided, env-guard applies the following defaults:

```json
{
  "GIT_EXTERNAL_DIFF": "",
  "GIT_DIFF": "",
  "GIT_PAGER": "cat",
  "PAGER": "cat",
  "LESS": "FRX"
}
```

## Git diff flags

env-guard rewrites `git diff` calls executed by the bash tool to ensure
`--no-pager --no-ext-diff` are always applied. Optional extra flags can be set
via `envGuard.gitDiffFlags` (string or string array).

## Configuration

Add overrides under the `envGuard` key in either project settings or global settings:

- `env`: environment variables to override
- `gitDiffFlags`: extra flags appended to `git diff` (string or string array)

- Project: `<project>/.pi/settings.json`
- Global: `~/.pi/agent/settings.json`

Project settings take precedence over global settings, and both override the defaults.

Example:

```json
{
  "envGuard": {
    "gitDiffFlags": ["--stat", "--color=never"],
    "env": {
      "GIT_EXTERNAL_DIFF": "",
      "GIT_PAGER": "cat",
      "PAGER": "cat",
      "FOO": "bar"
    }
  }
}
```
