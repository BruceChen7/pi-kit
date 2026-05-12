#!/bin/bash

# Install third-party Pi plugins into the shared plugin library.
#
# Plugins are installed under ~/.agents/pi-plugins/<plugin-name>. Project opt-in is
# handled by /toggle-plugin, which symlinks enabled plugins into .pi/extensions.
#
# Usage: ./install-third-party-plugins.sh [--install-only | --enable-defaults]
#
# Supported plugin sources:
#   - npm:@scope/package
#   - github:owner/repo
#   - github:owner/repo@ref
#   - https://github.com/owner/repo.git
#   - https://github.com/owner/repo.git@ref
#   - https://github.com/owner/repo@ref

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MODE="install-only"
LIBRARY_DIR="${PI_PLUGIN_LIBRARY_DIR:-$HOME/.agents/pi-plugins}"
MANIFEST_FILE="$LIBRARY_DIR/.manifest.json"

DEFAULT_PLUGINS=(
  "npm:@plannotator/pi-extension"
  "npm:pi-context"
  "https://github.com/davebcn87/pi-autoresearch"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-only)
      MODE="install-only"
      shift
      ;;
    --enable-defaults)
      MODE="enable-defaults"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--install-only | --enable-defaults]"
      echo ""
      echo "Options:"
      echo "  --install-only      Install plugins to ~/.agents/pi-plugins only (default)"
      echo "  --enable-defaults   Install plugins and symlink them into .pi/extensions"
      echo "  --help, -h          Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

plugin_kind() {
  local source="$1"
  if [[ "$source" == npm:* ]]; then
    printf 'npm\n'
  else
    printf 'github\n'
  fi
}

plugin_name() {
  local source="$1"
  if [[ "$source" == npm:* ]]; then
    source="${source#npm:}"
    source="${source#@}"
    printf '%s\n' "${source//\//-}"
    return
  fi

  source="${source#github:}"
  source="${source#git:github.com/}"
  source="${source#https://github.com/}"
  source="${source%@*}"
  source="${source%.git}"
  basename "$source"
}

github_clone_url() {
  local source="$1"
  source="${source#github:}"
  source="${source#git:github.com/}"
  source="${source#https://github.com/}"
  source="${source%@*}"
  source="${source%.git}"
  printf 'https://github.com/%s.git\n' "$source"
}

github_ref() {
  local source="$1"
  if [[ "$source" == *@* ]]; then
    printf '%s\n' "${source##*@}"
  fi
}

install_npm_plugin() {
  local source="$1"
  local target="$2"
  local package="${source#npm:}"
  local temp_dir
  temp_dir="$(mktemp -d)"

  npm pack "$package" --pack-destination "$temp_dir" >/dev/null
  local tarball
  tarball="$(find "$temp_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
  [ -n "$tarball" ] || { echo "npm pack produced no tarball for $source" >&2; return 1; }
  tar -xzf "$tarball" -C "$temp_dir"
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -R "$temp_dir/package" "$target"
  (cd "$target" && npm install --omit=dev --ignore-scripts >/dev/null)
  rm -rf "$temp_dir"
}

install_github_plugin() {
  local source="$1"
  local target="$2"
  local ref
  ref="$(github_ref "$source")"
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  if [ -n "$ref" ]; then
    git clone --depth 1 --branch "$ref" "$(github_clone_url "$source")" "$target" >/dev/null
  else
    git clone --depth 1 "$(github_clone_url "$source")" "$target" >/dev/null
  fi
}

write_manifest_entry() {
  local name="$1"
  local kind="$2"
  local source="$3"
  local target="$4"
  mkdir -p "$LIBRARY_DIR"
  node - "$MANIFEST_FILE" "$name" "$kind" "$source" "$target" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [, , manifestFile, name, kind, source, installedPath] = process.argv;
let manifest = { plugins: {} };
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
} catch {}
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) manifest = { plugins: {} };
if (!manifest.plugins || typeof manifest.plugins !== "object" || Array.isArray(manifest.plugins)) manifest.plugins = {};
manifest.plugins[name] = { kind, source, installedPath };
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
JS
}

enable_plugin() {
  local name="$1"
  local target="$2"
  local project_target=".pi/extensions/$name"
  mkdir -p .pi/extensions
  if [ -e "$project_target" ] || [ -L "$project_target" ]; then
    echo -e "  ${YELLOW}Skipping enable, path exists:${NC} $project_target"
    return
  fi
  ln -s "$target" "$project_target"
  echo -e "  ${GREEN}✓${NC} Enabled $name -> $target"
}

echo "=========================================="
echo "  Pi Third-Party Plugin Library Installer"
echo "=========================================="
echo "Library: $LIBRARY_DIR"
echo "Mode: $MODE"
echo ""

for source in "${DEFAULT_PLUGINS[@]}"; do
  kind="$(plugin_kind "$source")"
  name="$(plugin_name "$source")"
  target="$LIBRARY_DIR/$name"
  echo -e "${BLUE}Installing:${NC} $source as $name"
  if [ "$kind" = "npm" ]; then
    install_npm_plugin "$source" "$target"
  else
    install_github_plugin "$source" "$target"
  fi
  write_manifest_entry "$name" "$kind" "$source" "$target"
  echo -e "  ${GREEN}✓${NC} Installed to $target"
  if [ "$MODE" = "enable-defaults" ]; then
    enable_plugin "$name" "$target"
  fi
  echo ""
done

echo "Installation complete. Use /toggle-plugin to enable or disable plugins per project."
echo "Run pi /reload after changing enabled plugins."
