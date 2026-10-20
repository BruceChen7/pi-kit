#!/bin/bash

# Install the external CLIs that the extensions in extensions/ depend on.
#
# Each CLI is skipped when already on PATH; use --force to reinstall, or
# --update to upgrade everything to the latest release.
#
# Usage: ./install-extension-clis.sh [--force|--update]
#
# Covered CLIs (and the extensions that use them):
#   codex       extensions/codex-web-search, codex-plan-limits, cc-switch (brew cask)
#   qmd         extensions/qmd-search (npm)
#   plannotator extensions/plannotator-auto
#   gh          extensions/librarian, extensions/review
#   glab        extensions/librarian
#   tmux        extensions/cr-diffview, extensions/notify
#

set -euo pipefail

source "$(dirname "$0")/scripts/install-plannotator-cli.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FORCE=0
# 1 = upgrade mode: never skip an installed CLI, always fetch the latest release.
UPDATE=0

# npm registry pinned to the public registry on purpose: a NODE_OPTIONS security
# hook rewrites `npm install` to an internal mirror that lags behind upstream.
# An explicit --registry flag outranks the npm_config_registry env var the hook
# injects, so every npm invocation below passes it explicitly.
NPM_REGISTRY="${PI_NPM_REGISTRY:-https://registry.npmjs.org/}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --update)
      FORCE=1
      UPDATE=1
      shift
      ;;
    --help|-h)
      sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      echo "Usage: $0 [--force|--update]" >&2
      exit 1
      ;;
  esac
done

already_installed() {
  local bin="$1"
  [ "$FORCE" = 1 ] && return 1
  command -v "$bin" >/dev/null 2>&1
}

# Which Homebrew list owns "$1": prints "formula" / "cask", returns 1 when
# Homebrew is missing or does not manage it. Needed because some CLIs here
# (codex) may be installed as a cask rather than through npm; `npm install -g`
# then fails with EEXIST on Homebrew's symlink.
#
# The list is captured with $(...) before matching on purpose: piping brew into
# `grep -q` under `set -o pipefail` returns 141 (grep exits early -> SIGPIPE
# kills brew), which silently reads as "not owned by brew".
brew_owner() {
  local bin="$1"
  local kind
  local list
  command -v brew >/dev/null 2>&1 || return 1
  for kind in formula cask; do
    list="$(brew list --"$kind" 2>/dev/null)" || continue
    if grep -qx -- "$bin" <<<"$list"; then
      echo "$kind"
      return 0
    fi
  done
  return 1
}

upgrade_with_brew() {
  local bin="$1"
  local kind="$2"
  echo -e "${BLUE}Updating:${NC} $bin (brew $kind)"
  if [ "$kind" = cask ]; then
    brew upgrade --cask "$bin" || brew install --cask "$bin"
  else
    brew upgrade "$bin" || brew install "$bin"
  fi
}

npm_cli() {
  local bin="$1"
  local pkg="$2"
  if [ "$UPDATE" = 1 ]; then
    echo -e "${BLUE}Updating:${NC} $bin ($pkg@latest)"
    npm install -g "$pkg@latest" --registry="$NPM_REGISTRY"
    return
  fi
  if already_installed "$bin"; then
    echo -e "  ${GREEN}✓${NC} $bin already installed: $(command -v "$bin")"
    return
  fi
  echo -e "${BLUE}Installing:${NC} $bin ($pkg)"
  npm install -g "$pkg" --registry="$NPM_REGISTRY"
}

# system_cli <bin> <url> [formula|cask]
#
# The optional third argument is the Homebrew kind used when the CLI is not
# installed yet (codex ships as a cask, so `brew install --cask` is required).
# codex lives here rather than under the npm CLIs on purpose: it is installed
# as a brew cask, and `npm install -g @openai/codex` would fail with EEXIST on
# Homebrew's symlink. Do not put it back in the npm section.
system_cli() {
  local bin="$1"
  local url="$2"
  local kind_hint="${3:-formula}"
  local kind
  if kind="$(brew_owner "$bin")"; then
    :
  else
    kind="$kind_hint"
  fi
  if [ "$UPDATE" = 1 ]; then
    if command -v brew >/dev/null 2>&1; then
      upgrade_with_brew "$bin" "$kind"
    elif [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
      echo -e "${BLUE}Updating:${NC} $bin (apt)"
      sudo apt-get install -y "$bin"
    else
      echo -e "${YELLOW}Cannot update $bin automatically; do it manually:${NC} $url"
      # Surface as a failure: `make update-clis` must not look green while a
      # requested CLI stayed on its old version.
      return 1
    fi
    return
  fi
  if already_installed "$bin"; then
    echo -e "  ${GREEN}✓${NC} $bin already installed: $(command -v "$bin")"
    return
  fi
  if command -v brew >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} $bin (brew $kind)"
    if [ "$kind" = cask ]; then
      brew install --cask "$bin"
    else
      brew install "$bin"
    fi
  elif [ "$(uname -s)" = "Linux" ] && [ "$bin" = "tmux" ] && command -v apt-get >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} $bin (apt)"
    sudo apt-get install -y "$bin"
  else
    echo -e "${YELLOW}Install $bin manually:${NC} $url"
  fi
}

install_plannotator() {
  local installed="$PLANNOTATOR_CLI_INSTALL_DIR/plannotator"
  if [ "$UPDATE" != 1 ] && { already_installed plannotator || { [ "$FORCE" != 1 ] && [ -x "$installed" ]; }; }; then
    echo -e "  ${GREEN}✓${NC} plannotator already installed: $installed"
    return
  fi
  install_plannotator_cli
}

FAILED=()

# Run one CLI step without aborting the whole run: a single broken CLI (network
# hiccup, npm/brew conflict) must not leave the remaining CLIs un-updated.
run_step() {
  local name="$1"
  shift
  if "$@"; then
    return 0
  fi
  FAILED+=("$name")
  echo -e "  ${YELLOW}!${NC} $name failed; continuing with the rest" >&2
}

echo "=========================================="
echo "  Pi Extension CLI Installer"
echo "=========================================="
echo ""

echo "npm-installed CLIs:"
run_step qmd npm_cli qmd @tobilu/qmd
echo ""

echo "plannotator (GitHub release):"
run_step plannotator install_plannotator
echo ""

echo "system CLIs:"
run_step codex system_cli codex "https://github.com/openai/codex" cask
run_step gh system_cli gh "https://cli.github.com/"
run_step glab system_cli glab "https://gitlab.com/gitlab-org/cli#installation"
run_step tmux system_cli tmux "https://github.com/tmux/tmux/wiki/Installing"
echo ""

if [ "$UPDATE" = 1 ]; then
  echo "Done. Restart any running CLI processes, then run pi /reload so extensions pick up the upgraded CLIs."
else
  echo "Done. Run pi /reload so extensions pick up the new CLIs."
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo -e "${RED}Failed:${NC} ${FAILED[*]}" >&2
  exit 1
fi
