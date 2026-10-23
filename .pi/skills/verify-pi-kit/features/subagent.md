# Subagent runs

The subagent plugin runs child agents and exposes them through `/agents`. The listing covers active runs in the current session; a fresh process has none and says so.

## Sub-features

- `list-runs`: reports the active (queued or running) subagent runs in the current session.

## How to get to it (user POV)

- Type `/agents` in any Pi session.
- In a host without custom panels (including rpc) the command notifies a flat list instead of opening the overlay; opening and steering a run needs a panel host.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done. Run state is memory-only, so any new process starts empty; emptiness does not depend on `--no-session`.

- Read the run listing:
  `node scripts/verify-plugin.mjs command --plugin subagent --command "/agents" --expect "no subagent runs in this session"`
  Observable: `PASS`, one notify reading `no subagent runs in this session`.

## Gotchas

- Do not drive this in a session that already started subagents. The helper always starts fresh, which is why the empty-state text is the expected value.
- Only non-terminal runs are listed. With finished runs but none active, the notify becomes `no active subagent runs (N finished)`, a different literal that will not match this expectation.
- Starting a real subagent run costs a model call and is non-deterministic. This feature covers the listing, not the run, and the overlay/steer path is not covered here either.
