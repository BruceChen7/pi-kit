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

## Install plugins from this repo

Use the repo installer from the repository root:

```bash
./install-plugins.sh
```

Default behavior installs this repo's plugins into the shared library:

```text
~/.agents/pi-plugins
```

It also bootstraps only `plugin-toggle` and shared helpers globally so `/toggle-plugin` is available in Pi. Other plugins are not globally autoloaded; enable them per project with:

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
