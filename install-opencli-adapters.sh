#!/bin/bash
# Install pi-kit opencli adapters and site memory into ~/.opencli/.
#
# Usage: ./install-opencli-adapters.sh
#
# This script creates symlinks from:
#   ~/.opencli/clis/<site>/<cmd>.js         →  pi-kit/opencli/clis/<site>/<cmd>.js
#   ~/.opencli/sites/<site>/<file>          →  pi-kit/opencli/sites/<site>/<file>
# so that opencli can discover and load them.
#
# Prerequisites:
#   - opencli must be installed globally (npm install -g @jackwener/opencli)
#   - @jackwener/opencli must be resolvable from pi-kit (it's a devDependency)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIS_SOURCE_DIR="$SCRIPT_DIR/opencli/clis"
SITES_SOURCE_DIR="$SCRIPT_DIR/opencli/sites"
CLIS_TARGET_BASE="$HOME/.opencli/clis"
SITES_TARGET_BASE="$HOME/.opencli/sites"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

newly_installed=()
overwritten=()
failed=()

install_symlink() {
    local source_file="$1"
    local target_file="$2"
    local label="$3"
    local target_dir

    target_dir="$(dirname "$target_file")"
    mkdir -p "$target_dir"

    local existed="false"
    if [ -e "$target_file" ] || [ -L "$target_file" ]; then
        existed="true"
        rm -f "$target_file"
    fi

    if ln -s "$source_file" "$target_file"; then
        if [ "$existed" = "true" ]; then
            overwritten+=("$label")
            echo -e "${GREEN}✓${NC} Updated: $label"
        else
            newly_installed+=("$label")
            echo -e "${GREEN}✓${NC} Installed: $label"
        fi
        return 0
    fi

    failed+=("$label")
    echo -e "${RED}✗${NC} Failed: $label"
    return 1
}

echo "=========================================="
echo "  OpenCLI Adapters & Site Memory Installer"
echo "=========================================="
echo ""

# Verify @jackwener/opencli is resolvable
if ! node -e "require.resolve('@jackwener/opencli/registry')" 2>/dev/null && \
   ! node -e "import('@jackwener/opencli/registry')" 2>/dev/null; then
    echo -e "${YELLOW}Warning: @jackwener/opencli not resolvable from pi-kit.${NC}"
    echo "  Run: cd \"$SCRIPT_DIR\" && pnpm add -D @jackwener/opencli"
    echo ""
fi

# ── Part 1: Adapter symlinks ──────────────────────────────────
echo "--- Adapters ---"

if [ -d "$CLIS_SOURCE_DIR" ]; then
    for site_dir in "$CLIS_SOURCE_DIR"/*/; do
        if [ ! -d "$site_dir" ]; then
            continue
        fi

        site_name="$(basename "$site_dir")"

        for adapter_file in "$site_dir"*.js; do
            if [ ! -f "$adapter_file" ]; then
                continue
            fi

            cmd_name="$(basename "$adapter_file")"
            target_file="$CLIS_TARGET_BASE/$site_name/$cmd_name"
            install_symlink "$adapter_file" "$target_file" "$site_name/$cmd_name"
        done
    done
else
    echo -e "${YELLOW}  (no opencli/clis/ directory)${NC}"
fi

# ── Part 2: Site memory symlinks ───────────────────────────────
echo ""
echo "--- Site Memory ---"

if [ -d "$SITES_SOURCE_DIR" ]; then
    # Walk through opencli/sites/<site>/ and symlink all files/dirs recursively
    # Use process substitution so shell arrays are preserved in the parent shell
    while read -r source_file; do
        relative_path="${source_file#$SITES_SOURCE_DIR/}"
        site_name="$(echo "$relative_path" | cut -d/ -f1)"
        file_subpath="$(echo "$relative_path" | cut -d/ -f2-)"
        target_file="$SITES_TARGET_BASE/$relative_path"
        label="$site_name/…/$file_subpath"

        install_symlink "$source_file" "$target_file" "$label"
    done < <(find "$SITES_SOURCE_DIR" -type f)
else
    echo -e "${YELLOW}  (no opencli/sites/ directory)${NC}"
fi

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

echo ""
echo "To verify:"
echo "  opencli browser verify space/user-token"
echo "  opencli browser verify leetcode/problems --seed-args '[\"--limit\",\"3\"]'"
echo "  opencli leetcode problems --limit 5"
