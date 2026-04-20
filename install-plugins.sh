#!/bin/bash

# Install pi-agent extensions by creating symlinks to ~/.pi/agent/extensions/
# Usage: ./install-plugins.sh
#
# Supported patterns:
#   extensions/foo.ts          -> creates foo.ts symlink
#   extensions/bar/index.ts    -> creates bar/ symlink
#   extensions/baz/baz.ts      -> creates baz.ts symlink

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
TARGET_DIR="$HOME/.pi/agent/extensions"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Installation result tracking
newly_installed_items=()
overwritten_items=()
failed_items=()

mark_new_item() {
    newly_installed_items+=("$1")
}

mark_overwritten_item() {
    overwritten_items+=("$1")
}

mark_failed_item() {
    failed_items+=("$1")
}

print_summary_section() {
    local title="$1"
    shift

    echo "$title"
    if [ "$#" -eq 0 ]; then
        echo "  (none)"
        return
    fi

    for item in "$@"; do
        echo "  - $item"
    done
}

echo "=========================================="
echo "  Pi Agent Extensions Installer"
echo "=========================================="
echo ""

# Check if extensions directory exists
if [ ! -d "$EXTENSIONS_DIR" ]; then
    echo -e "${RED}Error: Extensions directory not found: $EXTENSIONS_DIR${NC}"
    exit 1
fi

# Create target directory if it doesn't exist
if [ ! -d "$TARGET_DIR" ]; then
    echo "Creating target directory: $TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

# Function to force-install symlink (overwrite when target already exists)
check_and_install() {
    local source_path="$1"
    local source_name="$2"
    local target_path="$TARGET_DIR/$source_name"
    local existed="false"

    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        existed="true"
        rm -rf "$target_path"
    fi

    if ln -s "$source_path" "$target_path"; then
        if [ "$existed" = "true" ]; then
            mark_overwritten_item "$source_name"
            echo -e "${GREEN}✓${NC} Overwritten: $source_name -> $target_path"
        else
            mark_new_item "$source_name"
            echo -e "${GREEN}✓${NC} Installed: $source_name -> $target_path"
        fi
        return 0
    fi

    mark_failed_item "$source_name"
    echo -e "${RED}✗${NC} Failed to install: $source_name"
    return 1
}

echo "Scanning extensions directory..."
echo ""

# Install shared utilities for symlinked extensions that use relative imports
# - File-based extensions: ~/.pi/agent/extensions/notify.ts -> ../shared/logger.ts => ~/.pi/agent/shared/logger.ts
# - Directory-based extensions: ~/.pi/agent/extensions/skill-toggle/index.ts -> ../shared/logger.ts => ~/.pi/agent/extensions/shared/logger.ts
install_shared_symlink() {
    local target_dir="$1"
    local item_name="shared => $target_dir"
    local existed="false"

    if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
        existed="true"
        rm -rf "$target_dir"
    fi

    if ln -s "$SHARED_SOURCE_DIR" "$target_dir"; then
        if [ "$existed" = "true" ]; then
            mark_overwritten_item "$item_name"
            echo -e "${GREEN}✓${NC} Overwritten shared symlink: $target_dir -> $SHARED_SOURCE_DIR"
        else
            mark_new_item "$item_name"
            echo -e "${GREEN}✓${NC} Installed shared symlink: $target_dir -> $SHARED_SOURCE_DIR"
        fi
    else
        mark_failed_item "$item_name"
        echo -e "${RED}✗${NC} Failed to install shared symlink: $target_dir"
    fi
}

SHARED_SOURCE_DIR="$EXTENSIONS_DIR/shared"
if [ -d "$SHARED_SOURCE_DIR" ]; then
    install_shared_symlink "$HOME/.pi/agent/shared"
    install_shared_symlink "$TARGET_DIR/shared"
fi

# Track installed items using a temp file
installed_file=$(mktemp)

# Helper function to check if already installed
is_installed() {
    grep -q "^$1$" "$installed_file" 2>/dev/null
}

mark_installed() {
    echo "$1" >> "$installed_file"
}

# First, process directories
for dir in "$EXTENSIONS_DIR"/*/; do
    if [ -d "$dir" ]; then
        dir_name=$(basename "$dir")

        # Skip hidden directories
        if [[ "$dir_name" == .* ]]; then
            continue
        fi

        # Priority 1: Check if directory has index.ts -> create dir symlink
        if [ -f "$dir/index.ts" ]; then
            if check_and_install "$dir" "$dir_name"; then
                mark_installed "$dir_name"
            fi
        # Priority 2: Check if directory has {name}.ts -> create .ts symlink
        elif [ -f "$dir${dir_name}.ts" ]; then
            if check_and_install "$dir${dir_name}.ts" "${dir_name}.ts"; then
                mark_installed "${dir_name}.ts"
            fi
        else
            echo -e "${YELLOW}!${NC} Skipped (no index.ts or ${dir_name}.ts): $dir_name"
        fi
    fi
done

# Then, process root-level .ts files
for ts_file in "$EXTENSIONS_DIR"/*.ts; do
    if [ -f "$ts_file" ]; then
        ts_name=$(basename "$ts_file")

        # Skip if already installed
        if is_installed "$ts_name"; then
            continue
        fi

        check_and_install "$ts_file" "$ts_name"
    fi
done

# Cleanup
rm -f "$installed_file"

echo ""
echo "=========================================="
echo "  Installation Complete"
echo "=========================================="
echo ""
echo "Extensions installed to: $TARGET_DIR"
echo ""
print_summary_section "Overwritten items:" "${overwritten_items[@]}"
echo ""
print_summary_section "Newly installed items:" "${newly_installed_items[@]}"

if [ "${#failed_items[@]}" -gt 0 ]; then
    echo ""
    print_summary_section "Failed items:" "${failed_items[@]}"
fi

echo ""
echo "To reload pi with new extensions, run:"
echo "  pi /reload"
