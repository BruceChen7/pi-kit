#!/bin/bash

# Install the plannotator CLI from GitHub releases.
#
# Sourced by install-third-party-plugins.sh and install-extension-clis.sh, and
# runnable standalone. Exposes:
#   PLANNOTATOR_CLI_INSTALL_DIR   install dir (default ~/.local/bin)
#   PLANNOTATOR_REPO              GitHub repo (default backnotprop/plannotator)
#   plannotator_platform()        print "os-arch" or fail for unsupported systems
#   sha256_file()                 print the sha256 of a file
#   install_plannotator_cli()     download, verify checksum, install

PLANNOTATOR_CLI_INSTALL_DIR="${PLANNOTATOR_CLI_INSTALL_DIR:-$HOME/.local/bin}"
PLANNOTATOR_REPO="${PLANNOTATOR_REPO:-backnotprop/plannotator}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

plannotator_platform() {
  local os
  local arch

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "Unsupported OS for plannotator CLI install: $(uname -s)" >&2; return 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported architecture for plannotator CLI install: $(uname -m)" >&2; return 1 ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

sha256_file() {
  local file_path="$1"

  if [ "$(uname -s)" = "Darwin" ]; then
    shasum -a 256 "$file_path" | cut -d' ' -f1
    return
  fi

  sha256sum "$file_path" | cut -d' ' -f1
}

install_plannotator_cli() {
  local platform
  local binary_name
  local binary_url
  local checksum_url
  local tmp_file
  local expected_checksum
  local actual_checksum

  platform="$(plannotator_platform)"
  binary_name="plannotator-${platform}"

  echo -e "${BLUE}Installing:${NC} plannotator CLI"
  binary_url="https://github.com/${PLANNOTATOR_REPO}/releases/latest/download/${binary_name}"
  checksum_url="${binary_url}.sha256"

  mkdir -p "$PLANNOTATOR_CLI_INSTALL_DIR"
  tmp_file="$(mktemp)"
  curl -fsSL -o "$tmp_file" "$binary_url"
  expected_checksum="$(curl -fsSL "$checksum_url" | cut -d' ' -f1)"
  actual_checksum="$(sha256_file "$tmp_file")"

  if [ "$actual_checksum" != "$expected_checksum" ]; then
    echo "Checksum verification failed for plannotator CLI latest release" >&2
    rm -f "$tmp_file"
    return 1
  fi

  rm -f "$PLANNOTATOR_CLI_INSTALL_DIR/plannotator" "$PLANNOTATOR_CLI_INSTALL_DIR/plannotator.exe" 2>/dev/null || true
  mv "$tmp_file" "$PLANNOTATOR_CLI_INSTALL_DIR/plannotator"
  chmod +x "$PLANNOTATOR_CLI_INSTALL_DIR/plannotator"
  echo -e "  ${GREEN}✓${NC} Installed plannotator to $PLANNOTATOR_CLI_INSTALL_DIR/plannotator"
  echo ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  install_plannotator_cli
fi
