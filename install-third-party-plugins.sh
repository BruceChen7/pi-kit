#!/bin/bash

# Install third-party Pi plugins from npm
# Usage: ./install-third-party-plugins.sh [--global | --local]
#
# Default: --global (install to ~/.pi/agent/third_extension_settings.json)
# --local: install to .pi/third_extension_settings.json (project scope)
#
# Third-party plugins installed by default:
#   - npm:@plannotator/pi-extension

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
            echo "  --global, -g   Install to global settings (default, ~/.pi/agent/third_extension_settings.json)"
            echo "  --local, -l    Install to project settings (.pi/third_extension_settings.json)"
            echo "  --help, -h     Show this help message"
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

echo "=========================================="
echo "  Pi Agent Third-Party Plugins Installer"
echo "=========================================="
echo ""
echo "Scope: $([ "$SCOPE" = "-l" ] && echo "Local (.pi/third_extension_settings.json)" || echo "Global (~/.pi/agent/third_extension_settings.json)")"
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
    "npm:@plannotator/pi-extension"
)

# Function to check if plugin is already in settings
is_installed() {
    local plugin="$1"
    local settings_file=""

    if [ "$SCOPE" = "-l" ]; then
        # Local scope
        settings_file="$SCRIPT_DIR/.pi/third_extension_settings.json"
    else
        # Global scope
        settings_file="$HOME/.pi/agent/third_extension_settings.json"
    fi

    if [ -f "$settings_file" ]; then
        # Extract base name: npm:pi-mermaid -> pi-mermaid, npm:@plannotator/pi-extension -> @plannotator/pi-extension
        local plugin_base
        plugin_base=$(echo "$plugin" | sed 's/^npm://')

        # Check if plugin is in packages array (supports versions like npm:pi-mermaid@0.3.0)
        grep -qE "\"npm:${plugin_base}(@[0-9.]+)?\"" "$settings_file" 2>/dev/null || \
        grep -qE "\"${plugin_base}(@[0-9.]+)?\"" "$settings_file" 2>/dev/null
    else
        return 1  # Settings file doesn't exist, not installed
    fi
}

# Install each plugin
for plugin in "${PLUGINS[@]}"; do
    echo -e "${BLUE}Checking:${NC} $plugin"

    if is_installed "$plugin"; then
        echo -e "  ${YELLOW}✓${NC} Already installed, skipping..."
    else
        echo -e "  Installing..."
        if pi install "$plugin" $SCOPE 2>&1; then
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
    if is_installed "$plugin"; then
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
