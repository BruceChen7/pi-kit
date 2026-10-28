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
- **Proof.** Read `<runDir>/launch.json`, `<runDir>/doctor.json` and `<runDir>/commands.json`. `launch.json` records the port, pid, agent directory and plugin list; `doctor.json` records the plugin list, the loaded command paths and the verdict; `commands.json` is pi's unmodified command table.
- **Stop.** Run `node scripts/verify-pi-web.mjs stop --run-dir <runDir>`. Exit code `0` and JSON naming the pid and port. The run's instance must not outlive the feature; the evidence in `<runDir>` survives.

## Gotchas

- `PI_CODING_AGENT_DIR` isolates the agent directory, not the skills directory. `~/.agents/skills` still loads, so `get_commands` returns 25+ commands that this run did not install. Only `sourceInfo.path` under `<agentDir>/extensions/` counts.
- A plugin that throws while loading registers nothing and does not fail `serve`; `doctor` is what catches it.
- `doctor` exits `2`, not `1`, when the run itself is unusable: an unknown flag, a busy port, a missing extension directory, a missing `launch.json`, or pi-web not answering within 60 s (`--timeout-ms` overrides that). Exit `1` is reserved for a verdict failure.
- `loaded` entries are `{name, plugin, path}`. `doctor.json` also carries `otherCommandCount`, the commands this run did not install; it is nonzero because `~/.agents/skills` still loads.
- A plugin that loads but registers no slash command cannot appear in `loaded`, so it is reported as `plugin not loaded: <name>`. Pick a plugin with a command, or read `commands.json` directly.
- `doctor` creates a session with `ensure_session`, which resolves to a default model even though the agent directory has no model config (observed `anthropic/claude-opus-4-8`). Model availability is irrelevant for load verification.
- `serve` refuses a busy port instead of taking it over. Never free the port by killing whatever holds it; pick another port.
