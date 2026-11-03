# Plan Mode

Plan Mode is the act/plan workflow switch. The user reaches it from a slash command and can read back the current mode and the plan artifact format.

## Sub-features

- `plan-mode-status`: reports the current mode plus plan artifact format and target path.
- `plan-mode-switch`: switches between `act` and `plan` in the running session.
- `plan-mode-todo-tools`: registers `act_mode_todo` and `plan_mode_todo` so each phase has its own TODO tool.

## How to get to it (user POV)

- Type `/plan-mode status` in any Pi session. Bare `/plan-mode` with no argument is the same readout.
- Type `/plan-mode plan` or `/plan-mode act` to switch, or press `alt+0` to toggle.
- Start Pi with `pi --plan-mode` to begin the session in plan mode.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done.
- Read the current mode:
  `node scripts/verify-plugin.mjs command --plugin plan-mode --command "/plan-mode status" --expect "Plan Mode: Act"`
  Observable: `PASS`, one notify containing `Plan Mode: Act`.
- Prove a switch takes effect in the same process:
  `node scripts/verify-plugin.mjs command --plugin plan-mode --command "/plan-mode plan" --command "/plan-mode status" --expect "Plan Mode: Plan"`
  Observable: both commands `handled`, notify reads `Plan Mode: Plan`.
- Prove `act` is handled and the mode reads back as `Act`:
  `node scripts/verify-plugin.mjs command --plugin plan-mode --command "/plan-mode act" --command "/plan-mode status" --expect "Plan Mode: Act"`
  Observable: both commands `handled`, notify reads `Plan Mode: Act`. A fresh process already starts in `Act`, so this proves the command is handled, not that it changed anything; the recipe above proves the switch direction.
- Prove the act-phase TODO tool is registered:
  `node scripts/verify-plugin.mjs tool --plugin plan-mode --tool act_mode_todo`
  Observable: `PASS`, `act_mode_todo` present in `active-tools.json`.
- Prove the plan-phase TODO tool is registered too:
  `node scripts/verify-plugin.mjs tool --plugin plan-mode --tool plan_mode_todo`
  Observable: `PASS`, `plan_mode_todo` present in `active-tools.json`.

## Gotchas

- `/plan-mode plan` and `/plan-mode act` do not notify on their own. Read the mode back with a following `/plan-mode status`, or the run finds no notify and fails.
- Expect the `Plan Mode:` prefix, not the whole line. The line embeds `planArtifactFormat`, `formatSource`, and the plan target path, which change with settings.
- The mode lives in the session, and a session with no snapshot restores the configured default (`planMode.defaultMode`, default `act`), not a hardcoded `act`. The helper passes no `--plan-mode` flag, and this repo sets no `planMode` key, so a fresh run starts in `Act`. A machine whose settings set `planMode.defaultMode: "plan"` must expect `Plan Mode: Plan` first.
- Expectations apply to the whole run, not per command. To assert different text per step, run the steps separately.
- Run the helper from a session in `act`. Plan mode blocks `bash` for the agent, so every `node scripts/verify-plugin.mjs …` call fails before it spawns anything. The `pi` process the helper starts restores its own default, so the caller's mode does not leak in.
- The TODO reminder added in `todo-reminder.ts` has no recipe here by design: it appends a transient `<system-reminder>` to a model request and emits no `notify`, so the helper cannot observe it. `npx vitest run extensions/plan-mode` owns that behavior.
- The two TODO tools are both registered, but a live session activates only the current phase's tool. `tool --tool plan_mode_todo` passes because the helper's SDK path never emits `session_start`, so `applyMode` never prunes the tool list; a helper that binds extensions would report only `act_mode_todo`.
- The plan-mode status line and TODO widget are not observable here: the helper counts `notify` records only. `npx vitest run extensions/plan-mode` owns the widget/status contract.
