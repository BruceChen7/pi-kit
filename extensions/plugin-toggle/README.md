# plugin-toggle

`plugin-toggle` manages project-local Pi plugins from a shared plugin library.

Plugin sources are installed into:

```text
~/.agents/pi-plugins/<plugin-name>
```

A project enables a plugin by symlinking it into:

```text
.pi/extensions/<plugin-name> -> ~/.agents/pi-plugins/<plugin-name>
```

Disable removes the project symlink only; it does not delete the shared plugin source.

## Configuration model: one default + per-project differences

The library is the single common plugin list: **every library plugin is enabled
in every project by default**. The settings file only records deviations:

```jsonc
{
  "pluginToggle": {
    // Optional: override the hardcoded default-disabled list
    // (constants.ts DEFAULT_DISABLED_PLUGINS = copyx, pi-autoresearch).
    "defaultDisabledPlugins": ["copyx", "pi-autoresearch"],
    "byCwd": {
      "/path/to/project-a": {
        "enabledPlugins": ["copyx"]        // force-on override for a default-disabled plugin
      },
      "/path/to/project-b": {
        "disabledPlugins": ["qmd-search"]  // turned off relative to the default
      }
    }
  }
}
```

- Projects with no entry (or an empty one) get the full default: all library
  plugins, minus the default-disabled list.
- Effective state is computed, never stored:
  `effective = (library − defaultDisabled − entry.disabledPlugins) ∪ entry.enabledPlugins`.
- Toggling a plugin back to its default state removes the recorded difference
  (and deletes the entry when it becomes empty), so the settings file stays
  minimal. Bootstrap never writes settings — it only converges symlinks.

On every session start the plugin converges the project symlinks: missing
symlinks for effective-enabled plugins are linked, and symlinks pointing into
the library are removed for effective-disabled plugins. Non-symlink paths
(user plugins) are never touched. Plugins added to the library later are
auto-enabled on the next session start, unless they are default-disabled or
explicitly disabled in the project's `disabledPlugins`.

## Worktrees

A session inside a linked git worktree shares the main repo's configuration.
On session start the extension detects the worktree (via its `.git` file) and
links `<worktree>/.pi` to `<main-repo>/.pi`, so Pi loads the same project
extensions/skills/prompts/themes/settings as the root repo. Plugin settings
are keyed by the main repo root, so toggling a plugin in the worktree applies
to the root repo (and every other linked worktree) and vice versa; the root
repo's `.pi/extensions` is the single source of truth.

- The first session in a fresh worktree creates the link; run `/reload` once
  to load the shared project plugins.
- If the worktree already has its own real `.pi` directory (for example the
  branch tracks `.pi`), it is never overwritten and the worktree keeps its
  own per-worktree configuration.
- Sessions launched in a subdirectory of a worktree keep Pi's plain
  per-directory scoping (Pi reads `<cwd>/.pi`), unchanged from non-worktree
  projects.
- Non-git directories and regular repositories are unaffected.

## Install plugins from this repo

Use the repo installer from the repository root:

```bash
./install-plugins.sh
```

Default behavior installs this repo's plugins into the shared library:

```text
~/.agents/pi-plugins
```

It also bootstraps `plugin-toggle`, shared helpers, `auto-trust-work` and `cc-switch` globally so `/toggle-plugin` is available in Pi and machine-wide providers keep working in every project. `cc-switch` is global on purpose: it proxies a machine-wide service (`127.0.0.1:15721`) with a global model catalog, so per-project opt-in would only risk losing saved model selections in new projects. Other plugins are not globally autoloaded; enable them per project with:

```text
/toggle-plugin
```

Then reload Pi:

```text
/reload
```

### Install modes

```bash
./install-plugins.sh --library   # default: install to ~/.agents/pi-plugins and opt in with /toggle-plugin
./install-plugins.sh --project   # install directly to the current project's .pi/extensions
./install-plugins.sh --autoload  # legacy: install all plugins to ~/.pi/agent/extensions
```

Prefer `--library` for normal use so each project can choose which plugins to enable.

## Add a GitHub plugin

### Option 1: Manually clone into the shared plugin library

```bash
git clone https://github.com/owner/my-pi-plugin.git ~/.agents/pi-plugins/my-pi-plugin
```

Then enable it from Pi:

```text
/toggle-plugin
```

Select the plugin, then reload Pi:

```text
/reload
```

### Option 2: Add it to the default installer

Edit `install-third-party-plugins.sh` and add the plugin to `DEFAULT_PLUGINS`:

```bash
DEFAULT_PLUGINS=(
  "npm:@plannotator/pi-extension"
  "npm:pi-context"
  "https://github.com/davebcn87/pi-autoresearch@v1.0.1"
  "https://github.com/owner/my-pi-plugin@v1.2.3"
)
```

Install into the shared library:

```bash
./install-third-party-plugins.sh
```

Or install and enable defaults in the current project:

```bash
./install-third-party-plugins.sh --enable-defaults
```

## Supported GitHub source formats

```text
github:owner/repo
github:owner/repo@ref
https://github.com/owner/repo
https://github.com/owner/repo.git
https://github.com/owner/repo@ref
https://github.com/owner/repo.git@ref
```

`ref` can be a branch, tag, or commit.
