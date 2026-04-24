#!/bin/bash

# Install third-party Pi plugins with the intended scope split.
#
# Default layout:
#   - global settings (~/.pi/agent/settings.json): common third-party plugins
#   - project settings (.pi/settings.json): pi-autoresearch, shared with this project
#
# Usage: ./install-third-party-plugins.sh [--mixed | --global | --project]
#
# Supported plugin sources:
#   - npm:@scope/package
#   - github:owner/repo
#   - github:owner/repo@ref
#   - https://github.com/owner/repo.git
#   - https://github.com/owner/repo.git@ref
#   - https://github.com/owner/repo@ref

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/install-third-party-plugins-lib.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MODE="mixed"
MODE_LABEL="Mixed (common plugins global; pi-autoresearch project-local)"

while [[ $# -gt 0 ]]; do
    case $1 in
        --mixed)
            MODE="mixed"
            MODE_LABEL="Mixed (common plugins global; pi-autoresearch project-local)"
            shift
            ;;
        --global|-g)
            MODE="global"
            MODE_LABEL="Global only (~/.pi/agent/settings.json)"
            shift
            ;;
        --project|-p|--local|-l)
            MODE="project"
            MODE_LABEL="Project only (.pi/settings.json in current project)"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--mixed | --global | --project]"
            echo ""
            echo "Options:"
            echo "  --mixed        Common plugins global, pi-autoresearch project-local (default)"
            echo "  --global, -g   Install all third-party plugins to global settings"
            echo "  --project, -p  Install all third-party plugins to project settings"
            echo "  --local, -l    Alias for --project"
            echo "  --help, -h     Show this help message"
            echo ""
            echo "Default mixed plugins:"
            echo "  Global:  npm:@plannotator/pi-extension, npm:pi-context"
            echo "  Project: https://github.com/davebcn87/pi-autoresearch@v1.0.1"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

if ! command -v pi &> /dev/null; then
    echo -e "${RED}Error: pi command not found${NC}"
    echo "Please install pi first: npm install -g @mariozechner/pi-coding-agent"
    exit 1
fi

GLOBAL_PLUGINS=(
    "npm:@plannotator/pi-extension"
    "npm:pi-context"
)

PROJECT_PLUGINS=(
    "https://github.com/davebcn87/pi-autoresearch@v1.0.1"
)

ALL_PLUGINS=("${GLOBAL_PLUGINS[@]}" "${PROJECT_PLUGINS[@]}")

remove_plugins_from_scope() {
    local scope_flag="$1"
    local settings_base_dir="$2"
    local label="$3"
    shift 3
    local plugins=("$@")
    local settings_file
    settings_file="$(get_settings_file "$scope_flag" "$settings_base_dir")"

    [ "${#plugins[@]}" -gt 0 ] || return

    echo "${label}: $settings_file"
    for plugin in "${plugins[@]}"; do
        if is_installed "$plugin" "$settings_file"; then
            echo -e "  ${YELLOW}Removing from this scope:${NC} $plugin"
            if pi remove "$plugin" $scope_flag 2>&1; then
                echo -e "    ${GREEN}✓${NC} Removed successfully"
            else
                echo -e "    ${RED}✗${NC} Failed to remove"
            fi
        fi
    done
    echo ""
}

install_plugins_for_scope() {
    local scope_flag="$1"
    local settings_base_dir="$2"
    local label="$3"
    shift 3
    local plugins=("$@")
    local settings_file
    settings_file="$(get_settings_file "$scope_flag" "$settings_base_dir")"

    echo "${label}: $settings_file"
    if [ "${#plugins[@]}" -eq 0 ]; then
        echo "  (none)"
        echo ""
        return
    fi

    for plugin in "${plugins[@]}"; do
        normalized_plugin="$(normalize_plugin_source "$plugin")"
        echo -e "  ${BLUE}Checking:${NC} $plugin"

        if is_installed "$plugin" "$settings_file"; then
            echo -e "    ${YELLOW}✓${NC} Already installed, skipping..."
        else
            echo -e "    Installing as: $normalized_plugin"
            if pi install "$normalized_plugin" $scope_flag 2>&1; then
                echo -e "    ${GREEN}✓${NC} Installed successfully"
            else
                echo -e "    ${RED}✗${NC} Failed to install"
            fi
        fi
        echo ""
    done
}

print_installed_summary() {
    local scope_flag="$1"
    local settings_base_dir="$2"
    local label="$3"
    shift 3
    local plugins=("$@")
    local settings_file
    settings_file="$(get_settings_file "$scope_flag" "$settings_base_dir")"

    echo "$label ($settings_file):"
    if [ "${#plugins[@]}" -eq 0 ]; then
        echo "  (none)"
        return
    fi

    for plugin in "${plugins[@]}"; do
        if is_installed "$plugin" "$settings_file"; then
            echo -e "  ${GREEN}✓${NC} $plugin"
        else
            echo -e "  ${RED}✗${NC} $plugin"
        fi
    done
}

case "$MODE" in
    global)
        GLOBAL_SCOPE_PLUGINS=("${ALL_PLUGINS[@]}")
        PROJECT_SCOPE_PLUGINS=()
        ;;
    project)
        GLOBAL_SCOPE_PLUGINS=()
        PROJECT_SCOPE_PLUGINS=("${ALL_PLUGINS[@]}")
        ;;
    *)
        GLOBAL_SCOPE_PLUGINS=("${GLOBAL_PLUGINS[@]}")
        PROJECT_SCOPE_PLUGINS=("${PROJECT_PLUGINS[@]}")
        ;;
esac

echo "=========================================="
echo "  Pi Agent Third-Party Plugins Installer"
echo "=========================================="
echo ""
echo "Mode: $MODE_LABEL"
echo ""

install_plugins_for_scope "" "$SCRIPT_DIR" "Global settings" "${GLOBAL_SCOPE_PLUGINS[@]}"
install_plugins_for_scope "-l" "$PWD" "Project settings" "${PROJECT_SCOPE_PLUGINS[@]}"

if [ "$MODE" = "mixed" ]; then
    remove_plugins_from_scope "" "$SCRIPT_DIR" "Removing project-scoped plugins from global settings" "${PROJECT_PLUGINS[@]}"
fi

echo "=========================================="
echo "  Installation Complete"
echo "=========================================="
echo ""
echo "Installed plugins:"
print_installed_summary "" "$SCRIPT_DIR" "Global" "${GLOBAL_SCOPE_PLUGINS[@]}"
print_installed_summary "-l" "$PWD" "Project" "${PROJECT_SCOPE_PLUGINS[@]}"
echo ""
echo "To verify, run:"
echo "  pi list"
echo ""
echo "To reload pi with new plugins, run:"
echo "  pi /reload"
