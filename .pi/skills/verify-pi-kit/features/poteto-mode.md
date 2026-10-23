# Poteto mode

Poteto mode is a persistent per-session switch. Once on, every model run carries the routing table, the evidence contract, and the nine role names in its system prompt. Turning it off replaces that block with one line saying the earlier reminders no longer apply.

## Sub-features

- `poteto-mode-on`: enables the mode for this branch and injects the guidance on every run.
- `poteto-mode-off`: disables it and injects the off notice instead of the guidance.
- `poteto-mode-status`: reports on/off, whether the branch opted in, and either the injected line count or `无` when off.
- `poteto-mode-preview`: prints the exact injected text.
- `poteto-mode-default`: `potetoMode.defaultEnabled` in `third_extension_settings.json`, global or project, makes a fresh session start enabled. An explicit `/poteto-mode on|off` record in the branch still wins.
- `poteto-roles`: nine subagent profiles (`code`, `bug-fix`, `perf`, `hillclimb`, `judgment`, `strongest`, `review`, `prose`, `verification`) become selectable through `subagent`'s `agent` parameter.

## How to get to it (user POV)

- `/poteto-mode on`, `/poteto-mode off`, `/poteto-mode status`, `/poteto-mode preview`.
- `subagent` with `agent: "review"` and a diff path, or any other role name.
- `./scripts/install-agents.sh` links `agents/*.md` into `~/.pi/agent/agents/`; `--check` reports drift.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, `./scripts/install-agents.sh` run.

- Prove the extension loads:
  `node scripts/verify-plugin.mjs doctor --plugin poteto-mode`
  Observable: `PASS doctor`.
- Read the state back after an explicit switch (independent of settings defaults):
  `node scripts/verify-plugin.mjs command --plugin poteto-mode --command "/poteto-mode off" --command "/poteto-mode status" --expect "poteto mode off | 注入"`
  Observable: both commands `handled`, `notifies: 2`, and one status notify reading `poteto mode off | 注入 无`.
- Prove the guidance reaches the real provider request (one tiny model call):
  `node scripts/verify-injection.mjs --control`
  Observable: `PASS 注入到达真实请求` and `PASS 不装本扩展时同样的 needle 不出现`. The probe dumps `before_provider_request`; `verify-plugin` cannot see this because its command mode never calls a model.
- Prove the configured default, with no `--poteto-mode` flag involved:
  `node scripts/verify-injection.mjs --use-config --control`
  Observable: the first line names `settings 默认值`. Prerequisite: `potetoMode.defaultEnabled` is true in `third_extension_settings.json`, global or project.
- Prove a switch takes effect in the same process:
  `node scripts/verify-plugin.mjs command --plugin poteto-mode --command "/poteto-mode on" --command "/poteto-mode status" --expect "poteto mode on | 注入"`
  Observable: `notifies: 2`, and the status notify carries the `| 注入 N 行` segment that only the status readout emits.
- Prove the injected text is reachable for review, and that the playbook path is absolute:
  `node scripts/verify-plugin.mjs command --plugin poteto-mode --command "/poteto-mode preview" --expect "/skills/poteto-playbooks/playbooks/<name>.md" --reject "{{PLAYBOOKS}}"`
  Observable: one notify carrying the whole rendered `guidance.md`, with no unexpanded token.

## Gotchas

- `on` and `off` own their notify text; `status` is what you read back. The same-process pairing is the only way to prove the switch, and the expectation must include the `" | 注入"` segment: `--expect "poteto mode on"` alone passes on the `on` notify by itself and proves nothing about the readback.
- Expectations apply to the whole run. `preview` notifies the entire rendered `guidance.md` (49 lines, 34 non-empty today), so keep `--expect` to a short stable fragment and do not assert the line count in `status` either.
- Per-run injection is not observable through `notify`. The helper proves the command path; `extensions/poteto-mode/index.test.ts` owns "every run gets the block" because it calls the `before_agent_start` handler directly.
- The mode is stored in the session branch (`poteto.mode.v1`), so a fresh process has no record. It does not follow that a fresh run reads as off: with no record the state resolves to `potetoMode.defaultEnabled`, so a machine that sets it true starts at `poteto mode on | 注入 N 行` with no `本分支未设置`. Assert the post-switch readback instead of the default.
- `make install-agents AGENTS_MODE=--check` fails on a stale link, but ignores unrelated profiles the user keeps in the same directory.
- `/poteto-mode` and the `/poteto` prompt template are different entry points. The template expands a one-shot nine-section prompt; the command changes session state.
- Poteto itself never calls `setStatus`. It broadcasts on `pi-kit:plan-mode:badge` and plan-mode renders the badge, so the helper sees no `notify` about it. `extensions/plan-mode/badge.test.ts` owns the rendering contract (widget in TUI, status line in pi-web); drive plan-mode separately if you need to see it.
- Without plan-mode installed the badge has nowhere to land, because `EventBus.emit` returns `void`. `/poteto-mode status` stays the authoritative readout in that case.
