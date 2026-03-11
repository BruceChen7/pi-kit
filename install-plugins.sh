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

# Function to check if target exists and prompt for overwrite
check_and_install() {
    local source_path="$1"
    local source_name="$2"
    local target_path="$TARGET_DIR/$source_name"

    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        echo ""
        echo -e "${YELLOW}Warning: $source_name already exists in target directory${NC}"
        echo "  Source: $source_path"
        echo "  Target: $target_path"
        read -p "  Overwrite? (y/n): " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "  Skipped: $source_name"
            return 1
        fi
        # Remove existing symlink/file
        rm -rf "$target_path"
    fi

    # Create symlink
    if ln -s "$source_path" "$target_path"; then
        echo -e "${GREEN}✓${NC} Installed: $source_name -> $target_path"
        return 0
    else
        echo -e "${RED}✗${NC} Failed to install: $source_name"
        return 1
    fi
}

echo "Scanning extensions directory..."
echo ""

# Install shared utilities for symlinked .ts extensions that use relative imports
# Example: ~/.pi/agent/extensions/notify.ts -> ../shared/logger.js => ~/.pi/agent/shared/logger.js
SHARED_SOURCE_DIR="$EXTENSIONS_DIR/shared"
SHARED_TARGET_DIR="$HOME/.pi/agent/shared"
if [ -d "$SHARED_SOURCE_DIR" ]; then
    if [ -e "$SHARED_TARGET_DIR" ] || [ -L "$SHARED_TARGET_DIR" ]; then
        if [ -L "$SHARED_TARGET_DIR" ]; then
            current_target=$(readlink "$SHARED_TARGET_DIR")
            if [ "$current_target" != "$SHARED_SOURCE_DIR" ]; then
                rm -rf "$SHARED_TARGET_DIR"
                ln -s "$SHARED_SOURCE_DIR" "$SHARED_TARGET_DIR"
                echo -e "${GREEN}✓${NC} Updated shared symlink: $SHARED_TARGET_DIR -> $SHARED_SOURCE_DIR"
            fi
        else
            echo -e "${YELLOW}!${NC} Shared target exists and is not a symlink: $SHARED_TARGET_DIR"
            echo -e "${YELLOW}!${NC} Please remove it manually to enable shared utility imports"
        fi
    else
        if ln -s "$SHARED_SOURCE_DIR" "$SHARED_TARGET_DIR"; then
            echo -e "${GREEN}✓${NC} Installed shared symlink: $SHARED_TARGET_DIR -> $SHARED_SOURCE_DIR"
        else
            echo -e "${RED}✗${NC} Failed to install shared symlink: $SHARED_TARGET_DIR"
        fi
    fi
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
            check_and_install "$dir" "$dir_name"
            mark_installed "$dir_name"
        # Priority 2: Check if directory has {name}.ts -> create .ts symlink
        elif [ -f "$dir${dir_name}.ts" ]; then
            check_and_install "$dir${dir_name}.ts" "${dir_name}.ts"
            mark_installed "${dir_name}.ts"
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
echo "To verify, run:"
echo "  ls -la $TARGET_DIR"
echo ""
echo "To reload pi with new extensions, run:"
echo "  pi /reload"