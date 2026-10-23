# Loop

`/loop` is bounded continuation. It runs a goal for at most `--max-turns` turns, runs a stop predicate after each turn, and stops on the first passing predicate, an exhausted budget, an operator stop, or an abort.

## Sub-features

- `loop-run`: `/loop run [--max-turns n] [--until "cmd"] [--until-timeout s] [--allow-dirty] <goal>` stores a running state and sends turn 1.
- `loop-status`: reports state, goal, predicate, budget and the last predicate exit code.
- `loop-stop`: writes a stopped state; any in-flight turn stops at the next boundary.
- `loop-resume`: restarts a stopped state with an optional new budget.
- `loop-gate`: refuses to start in a workspace with uncommitted changes unless `--allow-dirty`.

## How to get to it (user POV)

- `/loop run --max-turns 6 --until "npm test" "fix the parser edge cases"`
- `/loop status`, `/loop stop`, `/loop resume --max-turns 10`

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, clean workspace.

- Prove the extension loads:
  `node scripts/verify-plugin.mjs doctor --plugin loop`
- Read the empty state:
  `node scripts/verify-plugin.mjs command --plugin loop --command "/loop status" --expect "no run in this session"`
- Prove an unusable argument list is reported, not swallowed:
  `node scripts/verify-plugin.mjs command --plugin loop --command "/loop run --nope goal" --expect "Unknown option"`

## Gotchas

- `/loop run` refuses a dirty workspace. Every helper run starts clean, so the refusal needs `--allow-dirty` or a commit to reproduce.
- A real multi-turn run costs model calls. `npx vitest run extensions/loop` covers the state machine and the settle hook without a model.
- The continuation uses `agent_before_settle` with `continue: true`, not `sendUserMessage`. Two loops can stack if you add a second starter.
- The predicate runs with `shell: true` in the session cwd. A predicate that hangs is cut at `--until-timeout` (default 60s) and ends the loop as `failed` / `predicate-timeout`.
