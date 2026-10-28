# Bash hook status

The bash-hook plugin overrides the `bash` tool and the user `!`/`!!` path so registered hooks can rewrite a command before it runs. It registers no hooks itself; `/bash-hook-status` is the readout of the shared hook registry: which hook ids are registered, the order they run in, the configured order setting, and the last run.

## Sub-features

- `registered`: lists the registered hook ids.
- `ordered`: lists every hook id in execution order, including hooks with no explicit order.
- `order-setting`: reports the configured `bashHooks.order`.
- `last-run`: reports the most recent bash rewrite pass. The registry records it even when no hook changed the command; `applied` lists only hooks that did.

## How to get to it (user POV)

- Type `/bash-hook-status` in any Pi session.
- Run a `bash` command or the `!`/`!!` shortcut; the rewrite path is what the hooks feed.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done.
- Read hook status:
  `node scripts/verify-plugin.mjs command --plugin bash-hook --command "/bash-hook-status" --expect "Bash hooks registered: none | ordered: none"`
  Observable: `PASS`, one notify whose full literal is `Bash hooks registered: none | ordered: none | order setting: … | last run: none`.

## Gotchas

- The helper loads only this plugin (`--no-extensions -e extensions/bash-hook`), and this plugin registers no hooks, so `registered`, `ordered`, and `last run` are deterministically `none` in a helper run. Only the `order setting` segment follows the machine. Assert the first two segments literally instead of loosening the expectation to the label.
- In a real session other extensions contribute ids (`env-guard` registers `git-diff`), so the real readout differs from the helper run by design.
- A non-`none` `last run` reads `<source> <command> -> <resolved> (applied: <ids>)`, with source `tool` or `user_bash`. `order setting` reads `bashHooks.order` from `third_extension_settings.json`; the project file wins over the global one.
- `last-run` has no helper recipe: it needs a real `bash` call, and command mode only sends `get_commands` and `prompt`, so a handled slash command runs no bash.
- `--expect` matches a substring anywhere in the notify, not a prefix.
- The overridden `bash` tool keeps the built-in name, so `tool --tool bash` cannot tell the override from the builtin. `extensions/shared/bash-hook.test.ts` owns the rewrite behavior.
