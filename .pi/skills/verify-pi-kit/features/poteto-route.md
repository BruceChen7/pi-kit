# Poteto route

Poteto route keeps the `/poteto` routing table as data (`skills/poteto-playbooks/routes.json`) and exposes it through the `route_task` tool, so a route decision turns into resolved skill paths, a playbook body, and gates instead of prose the model re-reads every session.

## Sub-features

- `route-task-tool`: registers `route_task`, which takes the route id the model judged and returns steps, absolute `SKILL.md` paths, playbook text, and gates.
- `route-status-command`: `/poteto-route status` reports one of `idle`, `armed, waiting for route_task`, `armed, routed=<id|?>`, plus the catalog route ids.
- `route-reset-command`: `/poteto-route reset` clears the session's route state and reopens the edit gate.
- `route-edit-gate`: after `/poteto` arms the session, `edit` and `write` are blocked until `route_task` is called. Any call opens the gate, including one that resolves no route.

## How to get to it (user POV)

- Type `/poteto <task>` in any Pi session. The expansion arms the gate; the model then calls `route_task`.
- Type `/poteto-route status` to read back whether the session is armed, routed, and which route ids the catalog holds.
- Type `/poteto-route reset` to drop that state and unblock `edit` / `write` without calling `route_task`.
- The model reaches `route_task` directly; it is also usable without `/poteto`, in which case nothing is gated.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, `pi` on `PATH`.

- Prove the extension loads:
  `node scripts/verify-plugin.mjs doctor --plugin poteto-route`
  Observable: `PASS`, no load errors.
- Prove the tool is in the active tool set:
  `node scripts/verify-plugin.mjs tool --plugin poteto-route --tool route_task`
  Observable: `PASS`, `route_task` present in `active-tools.json`.
- Prove the command is handled and the catalog resolves:
  `node scripts/verify-plugin.mjs command --plugin poteto-route --command "/poteto-route status" --expect "routes: research,bugfix,refactor,feature,perf,ship"`
  Observable: `PASS`, one notify containing `poteto-route: idle` and the route list.
- Prove reset is handled:
  `node scripts/verify-plugin.mjs command --plugin poteto-route --command "/poteto-route reset" --expect "poteto-route: reset"`
  Observable: `PASS`, one notify containing `poteto-route: reset`.

## Gotchas

- The `edit` / `write` gate covers the top-level tools only. `subagent` runs its own session with its own (`unarmed`) state, and MCP write tools are outside `MUTATING_TOOLS`; both write files while the gate is closed. That is deliberate scope, not an oversight, and it means the gate nudges the model rather than enforcing anything.
- The `edit` / `write` gate is not observable here: `tool_call` blocking produces a tool result for the model and no `notify`, and command mode does not run model tool calls. `npx vitest run extensions/poteto-route` owns `decideGate`.
- `route_task`'s returned payload is also vitest-owned. Tool mode only proves registration.
- Chatting with the model to confirm the whole chain is not deterministic; if you run it, keep the transcript and say so, otherwise write `Skipped:`.
- `/poteto` arrives through the `input` event, so the template must be installed (`make install-skills`) for the human path; the command recipe above works without it.
- `routes.json` is resolved once at extension load, from the process cwd: `<cwd>/.pi/skills`, `<cwd>/.agents/skills`, then `~/.agents/me-skills`. It is cached; only a failed load retries, and a session whose cwd differs from the process cwd keeps using the cached catalog. A cwd outside the repo without installed skills makes `status` report the missing roots instead of `routes:`.
