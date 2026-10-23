# Extension load

A pi-kit plugin loaded by pi-web's own pi runtime is reachable as a slash command in the browser session, with its source path pointing at the isolated agent directory this run created.

## Sub-features

- `load-serve` starts a pi-web instance whose agent directory contains only the plugins under test.
- `load-registered` reports the plugin's commands from `get_commands` with a `sourceInfo.path` inside that agent directory.
- `load-missing` fails the verdict when a named plugin produced no command.

## How to get to it (user POV)

- Open pi-web, pick the project, type `/` in the composer: the plugin's commands appear in the command list.
- Run the command itself; every other recipe in this map depends on it being registered.

## Driving it with verify-pi-web

Preconditions:

- Run from the pi-kit repository root.
- Port 30242 is free (`lsof -nP -iTCP:30242 -sTCP:LISTEN` prints nothing).
- `pi-web` is on `PATH`.

- **Launch.** Run `node scripts/verify-pi-web.mjs serve --plugin plan-mode --plugin skill-toggle --port 30242`. Exit code `0` and JSON containing `runDir`, `pid`, `baseUrl`, `agentDir`. `ls <agentDir>/extensions` shows `plan-mode`, `shared`, `skill-toggle`.
- **Doctor.** Run `node scripts/verify-pi-web.mjs doctor --run-dir <runDir> --plugin plan-mode --expect-command plan-mode`. Exit code `0`, `ok: true`, and a `loaded` entry naming `plan-mode` with `path: <agentDir>/extensions/plan-mode/index.ts`.
- **Negative check.** Run `node scripts/verify-pi-web.mjs doctor --run-dir <runDir> --plugin btw`. Exit code `1` and `reasons: ["plugin not loaded: btw"]`. A doctor that passes for a plugin this run never loaded proves nothing.
- **Proof.** Read `<runDir>/doctor.json` and `<runDir>/commands.json`. `doctor.json` records the plugin list, the loaded command paths and the verdict; `commands.json` is pi's unmodified command table.

## Gotchas

- `PI_CODING_AGENT_DIR` isolates the agent directory, not the skills directory. `~/.agents/skills` still loads, so `get_commands` returns 25+ commands that this run did not install. Only `sourceInfo.path` under `<agentDir>/extensions/` counts.
- A plugin that throws while loading registers nothing and does not fail `serve`; `doctor` is what catches it.
- `doctor` creates a session with `ensure_session`, which resolves to a default model even though the agent directory has no model config (observed `anthropic/claude-opus-4-8`). Model availability is irrelevant for load verification.
- `serve` refuses a busy port instead of taking it over. Never free the port by killing whatever holds it; pick another port.
