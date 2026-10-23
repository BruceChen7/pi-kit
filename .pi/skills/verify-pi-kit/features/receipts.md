# Receipts

The receipts extension records every test run it sees and blocks a `git commit` or `gh pr create` whose message claims a test count that no recorded run produced.

## Sub-features

- `receipts-record`: a bash command matching a known runner (`vitest`, `jest`, `npm test`, `make test`, `pytest`, ...) whose output carries `N passed` writes a receipt into `<git common dir>/pi-receipts.json`.
- `receipts-gate`: `git commit` / `gh pr create` whose message makes an explicit count claim (`Tests: N`, `N tests passed`, `N passed`) is blocked unless N matches a recorded run.
- `receipts-escape`: `PI_RECEIPT_GATE=off` lets the same command through.

## How to get to it (user POV)

- Nobody calls it directly. It fires on `bash` tool results and on publish commands.
- Inspect the store with `cat "$(git rev-parse --git-common-dir)/pi-receipts.json"`.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done.

- Prove the extension loads:
  `node scripts/verify-plugin.mjs doctor --plugin receipts`

The recording and gating halves need real bash calls, so drive them inside a session rather than through the helper:

- `npx vitest run extensions/receipts/parse.test.ts`, then
- `git commit --dry-run -m 'test: probe' -m 'Tests: 999'` → blocked, reason quotes the recorded number, then
- `git commit --dry-run -m 'test: probe' -m 'Tests: 11'` → allowed.

## Gotchas

- `--dry-run` makes the gate observable without creating a commit. Use it whenever you are proving the block.
- Only explicit count shapes are treated as claims. "adds a test" is prose and passes.
- The store lives in the git directory, so it never shows up in `git status` and does not survive a fresh clone.
- `go test` prints no counts; those runs are not recorded, so a claim after only `go test` is blocked.
- `git commit -F file` and `gh pr create --body-file` are not inspected; the message is unreadable without opening the file.
