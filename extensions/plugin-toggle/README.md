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

Enable/disable state is tracked per project as three states — enabled,
disabled, or never seen. Disabling a plugin is persistent: once disabled,
session-start sync will never auto-enable it again in that project (re-enable
it any time with `/toggle-plugin`). Plugins that appear in the shared library
later are auto-enabled on the next session start, unless they are listed in
the global `pluginToggle.defaultDisabledPlugins` setting (defaults to
`copyx` and `pi-autoresearch`), which only acts as the initial default for
plugins a project has never seen.

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
