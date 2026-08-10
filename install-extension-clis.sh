#!/bin/bash

# Install the external CLIs that the extensions in extensions/ depend on.
#
# Each CLI is skipped when already on PATH; use --force to reinstall.
#
# Usage: ./install-extension-clis.sh [--force]
#
# Covered CLIs (and the extensions that use them):
#   codex       extensions/codex-web-search, codex-plan-limits, cc-switch
#   qmd         extensions/qmd-search
#   calldiff    extensions/plannotator-auto (callflowContext; has npx fallback)
#   plannotator extensions/plannotator-auto
#   cs          extensions/cs-search
#   gh          extensions/librarian, extensions/review
#   glab        extensions/librarian
#   tmux        extensions/cr-diffview, extensions/notify

set -euo pipefail

source "$(dirname "$0")/scripts/install-plannotator-cli.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --help|-h)
      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      echo "Usage: $0 [--force]" >&2
      exit 1
      ;;
  esac
done

already_installed() {
  local bin="$1"
  [ "$FORCE" = 1 ] && return 1
  command -v "$bin" >/dev/null 2>&1
}

npm_cli() {
  local bin="$1"
  local pkg="$2"
  if already_installed "$bin"; then
    echo -e "  ${GREEN}✓${NC} $bin already installed: $(command -v "$bin")"
    return
  fi
  echo -e "${BLUE}Installing:${NC} $bin ($pkg)"
  npm install -g "$pkg"
}

system_cli() {
  local bin="$1"
  local url="$2"
  if already_installed "$bin"; then
    echo -e "  ${GREEN}✓${NC} $bin already installed: $(command -v "$bin")"
    return
  fi
  if command -v brew >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} $bin (brew)"
    brew install "$bin"
  elif [ "$(uname -s)" = "Linux" ] && [ "$bin" = "tmux" ] && command -v apt-get >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} $bin (apt)"
    sudo apt-get install -y "$bin"
  else
    echo -e "${YELLOW}Install $bin manually:${NC} $url"
  fi
}

install_plannotator() {
  local installed="$PLANNOTATOR_CLI_INSTALL_DIR/plannotator"
  if already_installed plannotator || { [ "$FORCE" != 1 ] && [ -x "$installed" ]; }; then
    echo -e "  ${GREEN}✓${NC} plannotator already installed: $installed"
    return
  fi
  install_plannotator_cli
}

install_cs() {
  if already_installed cs; then
    echo -e "  ${GREEN}✓${NC} cs already installed: $(command -v cs)"
    return
  fi
  if command -v go >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} cs (go install)"
    go install github.com/boyter/cs/v3@latest
  elif command -v brew >/dev/null 2>&1; then
    echo -e "${BLUE}Installing:${NC} cs (brew)"
    brew install boyter/cs/cs
  else
    echo -e "${YELLOW}Install cs manually:${NC} go install github.com/boyter/cs/v3@latest"
  fi
}

echo "=========================================="
echo "  Pi Extension CLI Installer"
echo "=========================================="
echo ""

echo "npm-installed CLIs:"
npm_cli codex @openai/codex
npm_cli qmd @tobilu/qmd
npm_cli calldiff calldiff
echo ""

echo "plannotator (GitHub release):"
install_plannotator
echo ""

echo "cs (code search):"
install_cs
echo ""

echo "system CLIs:"
system_cli gh "https://cli.github.com/"
system_cli glab "https://gitlab.com/gitlab-org/cli#installation"
system_cli tmux "https://github.com/tmux/tmux/wiki/Installing"
echo ""

echo "Done. Run pi /reload so extensions pick up the new CLIs."
