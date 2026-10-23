# Git Read

`git_read` is a read-only git tool for agents that must not have a shell. It accepts only `git diff`, `git show` and `git log` with whitelisted options, defaults `diff` and `log` to `main...HEAD`, and falls back to `HEAD` when that range does not exist.

## Sub-features

- `git-read-accept`: `git diff --stat main...HEAD`, `git log --oneline -n 20`, `git show HEAD` run and return stdout.
- `git-read-refuse`: every other subcommand, global option, `--output`, `-c`, `--ext-diff`, and any shell composition is refused with a reason.
- `git-read-default-range`: with no revision, `diff`/`log` get `main...HEAD`; a repo without that range retries with `HEAD`.

## How to get to it (user POV)

- `subagent` with `agent: "review"` and a task asking for the diff.
- In a session that has the tool active, call `git_read` with `{ command }`.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done.

- Prove the tool is registered:
  `node scripts/verify-plugin.mjs tool --plugin git-read --tool git_read`
  Observable: `PASS`, `git_read` in `active-tools.json`.

## Gotchas

- `verify-plugin` only proves registration. The accept/refuse matrix lives in `npx vitest run extensions/git-read`, which uses a temp repo for the accept cases.
- `git diff` with no revision in a fresh repo has no `main`; the tool retries with `HEAD` so the reviewer sees working-tree changes instead of "ambiguous argument".
- The tool is granted through `agents/review.md` `tools:`. Adding it to a profile that has `bash` gains nothing.
