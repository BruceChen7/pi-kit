#!/bin/bash
# Install pi-kit opencli adapters into ~/.opencli/clis/.
#
# Usage: ./install-opencli-adapters.sh
#
# This script creates symlinks from ~/.opencli/clis/<site>/<cmd>.js
# to the adapter source files in pi-kit/opencli/clis/<site>/<cmd>.js
# so that opencli can discover and load them.
#
# Prerequisites:
#   - opencli must be installed globally (npm install -g @jackwener/opencli)
#   - @jackwener/opencli must be resolvable from pi-kit (it's a devDependency)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/opencli/clis"
TARGET_BASE="$HOME/.opencli/clis"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

newly_installed=()
overwritten=()
failed=()

install_adapter_symlink() {
    local source_file="$1"
    local site_name="$2"
    local cmd_name="$3"
    local target_dir="$TARGET_BASE/$site_name"
    local target_file="$target_dir/$cmd_name"

    mkdir -p "$target_dir"

    local existed="false"
    if [ -e "$target_file" ] || [ -L "$target_file" ]; then
        existed="true"
        rm -f "$target_file"
    fi

    if ln -s "$source_file" "$target_file"; then
        if [ "$existed" = "true" ]; then
            overwritten+=("$site_name/$cmd_name")
            echo -e "${GREEN}✓${NC} Updated: $site_name/$cmd_name"
        else
            newly_installed+=("$site_name/$cmd_name")
            echo -e "${GREEN}✓${NC} Installed: $site_name/$cmd_name"
        fi
        return 0
    fi

    failed+=("$site_name/$cmd_name")
    echo -e "${RED}✗${NC} Failed: $site_name/$cmd_name"
    return 1
}

echo "=========================================="
echo "  OpenCLI Adapters Installer"
echo "=========================================="
echo ""

if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}Error: Adapter source directory not found: $SOURCE_DIR${NC}"
    exit 1
fi

# Verify @jackwener/opencli is resolvable
if ! node -e "require.resolve('@jackwener/opencli/registry')" 2>/dev/null && \
   ! node -e "import('@jackwener/opencli/registry')" 2>/dev/null; then
    echo -e "${YELLOW}Warning: @jackwener/opencli not resolvable from pi-kit.${NC}"
    echo "  Run: cd \"$SCRIPT_DIR\" && pnpm add -D @jackwener/opencli"
    echo ""
fi

# Walk through all site directories in opencli/clis/
for site_dir in "$SOURCE_DIR"/*/; do
    if [ ! -d "$site_dir" ]; then
        continue
    fi

    site_name="$(basename "$site_dir")"

    for adapter_file in "$site_dir"*.js; do
        if [ ! -f "$adapter_file" ]; then
            continue
        fi

        cmd_name="$(basename "$adapter_file")"
        install_adapter_symlink "$adapter_file" "$site_name" "$cmd_name"
    done
done

echo ""
echo "=========================================="
echo "  Summary"
echo "=========================================="
echo ""

if [ "${#newly_installed[@]}" -gt 0 ]; then
    echo "Newly installed:"
    for item in "${newly_installed[@]}"; do
        echo "  • $item"
    done
    echo ""
fi

if [ "${#overwritten[@]}" -gt 0 ]; then
    echo "Updated:"
    for item in "${overwritten[@]}"; do
        echo "  • $item"
    done
    echo ""
fi

if [ "${#failed[@]}" -gt 0 ]; then
    echo -e "${RED}Failed:${NC}"
    for item in "${failed[@]}"; do
        echo "  • $item"
    done
    echo ""
fi

echo "Target directory: $TARGET_BASE"
echo ""
echo "Adapters previously in pi-kit (deploy, cancel) have been migrated to personal-agent-staff."
echo ""
echo "To verify: opencli browser verify space/user-token"
