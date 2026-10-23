# pi-kit plugin verification map

This directory is the maintained source for verifying the user-facing behavior of pi-kit plugins. Read this index before driving a plugin, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the pi-kit repository root.
- `npm install` has run, so `@earendil-works/pi-coding-agent` resolves for the helper.
- `pi` is on `PATH` and its version matches the repo's peer dependency range.
- `.pi/verify-runs/` is writable. Evidence lands there.
- Never drive an instance this verification run did not start. The helper starts its own process every time.

## Driving conventions

- Treat every command as literal. Keep flags and quoted text unchanged.
- One run verifies one plugin.
- Start with `doctor`, then use `command` for slash commands or `tool` for registered tools.
- Keep `--expect` text to a stable fragment. Whole notification lines embed settings that change between machines.
- A command that writes user config does not belong in this map. The helper has no isolated `HOME`.

## Proof and skip reporting

- Passing proof is the `PASS` line plus the evidence directory path.
- Failing proof names the signal that failed: not registered, not `handled`, tool absent, or notify text mismatch.
- When an environmental prerequisite is unmet, report the unmet prerequisite. Do not verify through a different path and call it covered.
- Do not weaken an expectation to make a recipe pass. Fix the plugin or record the failure in the feature's `Gotchas`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.
1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-plugin` starts with `Preconditions:` and pairs each action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Plan Mode](./plan-mode.md) covers the act/plan switch and reading the current mode back.
- [Bash hook status](./bash-hook.md) covers the status readout for registered bash hooks.
- [Skill toggle](./skill-toggle.md) covers the enabled managed skills readout.
- [Subagent runs](./subagent.md) covers the empty run listing in a fresh session.
- [Confluence page tool](./confluence.md) covers registration of the `confluence_page` tool.
