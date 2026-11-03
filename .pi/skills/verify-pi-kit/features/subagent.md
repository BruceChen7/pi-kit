# Subagent runs

The subagent plugin runs child agents and exposes them through `/agents`. The listing covers active runs in the current session; a fresh process has none and says so.

## Sub-features

- `list-runs`: reports the active (queued or running) subagent runs in the current session.
- `tool-registration`: registers the `subagent` tool with actions `run`, `list`, `status`, `stop`, `doctor`, and `wait`.

## How to get to it (user POV)

- Type `/agents` in any Pi session.
- In a host without custom panels the command notifies a flat list instead of opening the overlay. Only the TUI, or `PI_KIT_UI_HOST` pointing at a panel host, reaches the overlay: this plugin resolves the host from `mode`, `hasUI`, and `PI_KIT_UI_HOST` only, without the pi-web marker, so pi-web (which reports `mode: rpc`) also gets the flat list.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, `pi` on `PATH` (command mode spawns it). Run state is memory-only, so any new process starts empty; emptiness does not depend on `--no-session`.
- Read the run listing:
  `node scripts/verify-plugin.mjs command --plugin subagent --command "/agents" --expect "no subagent runs in this session"`
  Observable: `PASS`, a notify containing `no subagent runs in this session`. The helper matches a substring across all notifies; it does not assert a count.
- Prove the tool is registered:
  `node scripts/verify-plugin.mjs tool --plugin subagent --tool subagent`
  Observable: `PASS`, `subagent` present in `active-tools.json`.

## Gotchas

- Do not drive this in a session that already started subagents. The helper always starts fresh, which is why the empty-state text is the expected value.
- Only non-terminal runs are listed. With finished runs but none active, the notify becomes `no active subagent runs (N finished)`, a different literal that will not match this expectation.
- Starting a real subagent run costs a model call and is non-deterministic. This feature covers the listing and the tool registration, not the run, and the overlay/steer path is not covered here either.
- The helper observes `notify` records only. The run widget (`Subagents · N running, M queued · +K more`) and the footer status (several runs: `subagent N running, M queued`; one run: `subagent <agent> <elapsed>`) are not covered here; `npx vitest run extensions/subagent` owns them.
- The `subagent` tool's `list` action returns `no active subagent runs` as a tool result, not a notify, so it can never enter an `--expect` check. That string is also a substring of the `/agents` finished-run notify `no active subagent runs (N finished)`; asserting the short form in command mode is therefore the weaker check, and it silently passes on the finished-run path. Assert the long form.
