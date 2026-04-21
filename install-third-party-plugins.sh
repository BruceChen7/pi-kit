#!/bin/bash

# Install third-party Pi plugins from npm or GitHub
# Usage: ./install-third-party-plugins.sh [--global | --local]
#
# Default: --global (install to ~/.pi/agent/settings.json)
# --local: install to .pi/settings.json (project scope)
#
# Supported plugin sources in PLUGINS:
#   - npm:@scope/package
#   - github:owner/repo
#   - github:owner/repo@ref
#   - https://github.com/owner/repo.git
#   - https://github.com/owner/repo.git@ref
#   - https://github.com/owner/repo@ref
#
# Third-party plugins installed by default:
#   - npm:@plannotator/pi-extension

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/install-third-party-plugins-lib.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default scope is global (empty = global, -l = local)
SCOPE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --global)
            SCOPE=""  # Default is global, no flag needed
            shift
            ;;
        --local|-l)
            SCOPE="-l"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--global | --local]"
            echo ""
            echo "Options:"
            echo "  --global, -g   Install to global settings (default, ~/.pi/agent/settings.json)"
            echo "  --local, -l    Install to project settings (.pi/settings.json)"
            echo "  --help, -h     Show this help message"
            echo ""
            echo "Supported plugin source formats:"
            echo "  - npm:@scope/package"
            echo "  - github:owner/repo"
            echo "  - github:owner/repo@ref"
            echo "  - https://github.com/owner/repo.git"
            echo "  - https://github.com/owner/repo.git@ref"
            echo "  - https://github.com/owner/repo@ref"
            echo ""
            echo "Plugins to be installed:"
            echo "  - npm:@plannotator/pi-extension"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

SETTINGS_FILE="$(get_settings_file "$SCOPE" "$SCRIPT_DIR")"

echo "=========================================="
echo "  Pi Agent Third-Party Plugins Installer"
echo "=========================================="
echo ""
echo "Scope: $([ "$SCOPE" = "-l" ] && echo "Local (.pi/settings.json)" || echo "Global (~/.pi/agent/settings.json)")"
echo "Settings file: $SETTINGS_FILE"
echo ""

# Check if pi is installed
if ! command -v pi &> /dev/null; then
    echo -e "${RED}Error: pi command not found${NC}"
    echo "Please install pi first: npm install -g @mariozechner/pi-coding-agent"
    exit 1
fi

# Third-party plugins to install
PLUGINS=(
    # "npm:pi-mermaid"
    # "npm:pi-cursor-agent"
    # "npm:pi-subagents"
    # "github:owner/repo"
    # "github:owner/repo@v1.2.3"
    # "https://github.com/owner/repo.git"
    # "https://github.com/owner/repo@v1.2.3"
    "npm:@plannotator/pi-extension"
)

# Install each plugin
for plugin in "${PLUGINS[@]}"; do
    normalized_plugin="$(normalize_plugin_source "$plugin")"
    echo -e "${BLUE}Checking:${NC} $plugin"

    if is_installed "$plugin" "$SETTINGS_FILE"; then
        echo -e "  ${YELLOW}✓${NC} Already installed, skipping..."
    else
        echo -e "  Installing as: $normalized_plugin"
        if pi install "$normalized_plugin" $SCOPE 2>&1; then
            echo -e "  ${GREEN}✓${NC} Installed successfully"
        else
            echo -e "  ${RED}✗${NC} Failed to install"
        fi
    fi
    echo ""
done

echo "=========================================="
echo "  Installation Complete"
echo "=========================================="
echo ""
echo "Installed plugins:"
for plugin in "${PLUGINS[@]}"; do
    if is_installed "$plugin" "$SETTINGS_FILE"; then
        echo -e "  ${GREEN}✓${NC} $plugin"
    else
        echo -e "  ${RED}✗${NC} $plugin"
    fi
done
echo ""
echo "To verify, run:"
echo "  pi list"
echo ""
echo "To reload pi with new plugins, run:"
echo "  pi /reload"
