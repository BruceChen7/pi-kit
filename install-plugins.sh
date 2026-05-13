#!/bin/bash

# Install pi-agent extensions as a shared plugin library.
# Usage: ./install-plugins.sh [--library | --project | --autoload]
#
# Default behavior matches extensions/plugin-toggle:
#   - local plugins are symlinked into ~/.agents/pi-plugins
#   - only plugin-toggle and shared helpers are bootstrapped globally
#   - projects opt into plugins by running /toggle-plugin
#
# Supported plugin source patterns:
#   extensions/foo/index.ts    -> creates foo/ symlink
#   extensions/foo/foo.ts      -> creates foo.ts symlink
#   extensions/foo.ts          -> creates foo.ts symlink

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
LIBRARY_DIR="$HOME/.agents/pi-plugins"
GLOBAL_EXTENSION_DIR="$HOME/.pi/agent/extensions"
SCOPE="library"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --library|--global|-g)
            SCOPE="library"
            shift
            ;;
        --project|-p)
            SCOPE="project"
            shift
            ;;
        --autoload)
            SCOPE="autoload"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--library | --project | --autoload]"
            echo ""
            echo "Options:"
            echo "  --library, -g    Install to ~/.agents/pi-plugins and bootstrap /toggle-plugin globally (default)"
            echo "  --project, -p    Install directly to .pi/extensions in the current project"
            echo "  --autoload       Legacy mode: install all extensions to ~/.pi/agent/extensions"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

case "$SCOPE" in
    project)
        TARGET_DIR="$PWD/.pi/extensions"
        SCOPE_LABEL="Project (.pi/extensions)"
        ;;
    autoload)
        TARGET_DIR="$GLOBAL_EXTENSION_DIR"
        SCOPE_LABEL="Global autoload (~/.pi/agent/extensions)"
        ;;
    *)
        TARGET_DIR="$LIBRARY_DIR"
        SCOPE_LABEL="Shared plugin library (~/.agents/pi-plugins; opt in with /toggle-plugin)"
        ;;
esac

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

newly_installed_items=()
overwritten_items=()
removed_items=()
migrated_items=()
manual_review_items=()
failed_items=()

mark_new_item() { newly_installed_items+=("$1"); }
mark_overwritten_item() { overwritten_items+=("$1"); }
mark_removed_item() { removed_items+=("$1"); }
mark_migrated_item() { migrated_items+=("$1"); }
mark_manual_review_item() { manual_review_items+=("$1"); }
mark_failed_item() { failed_items+=("$1"); }

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

install_symlink() {
    local source_path="$1"
    local source_name="$2"
    local target_dir="$3"
    local target_path="$target_dir/$source_name"
    local existed="false"

    mkdir -p "$target_dir"
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        existed="true"
        rm -rf "$target_path"
    fi

    if ln -s "$source_path" "$target_path"; then
        if [ "$existed" = "true" ]; then
            mark_overwritten_item "$source_name => $target_dir"
            echo -e "${GREEN}✓${NC} Overwritten: $source_name -> $target_path"
        else
            mark_new_item "$source_name => $target_dir"
            echo -e "${GREEN}✓${NC} Installed: $source_name -> $target_path"
        fi
        return 0
    fi

    mark_failed_item "$source_name => $target_dir"
    echo -e "${RED}✗${NC} Failed to install: $source_name"
    return 1
}

install_shared_symlink() {
    local target_dir="$1"
    local item_name="shared => $target_dir"

    if [ -d "$SHARED_SOURCE_DIR" ]; then
        install_symlink "$SHARED_SOURCE_DIR" "shared" "$target_dir" >/dev/null
        echo -e "${GREEN}✓${NC} Shared helpers: $target_dir/shared -> $SHARED_SOURCE_DIR"
    else
        mark_failed_item "$item_name"
        echo -e "${RED}✗${NC} Shared helpers missing: $SHARED_SOURCE_DIR"
    fi
}

install_plugin_dependencies() {
    local source_path="$1"
    local source_name="$2"

    if [ ! -d "$source_path" ] || [ ! -f "$source_path/package.json" ]; then
        return 0
    fi

    echo "Installing runtime dependencies for $source_name..."
    if (cd "$source_path" && npm install --omit=dev --ignore-scripts >/dev/null); then
        echo -e "${GREEN}✓${NC} Dependencies ready: $source_name"
        return 0
    fi

    mark_failed_item "$source_name dependencies"
    echo -e "${RED}✗${NC} Failed to install dependencies: $source_name"
    return 1
}

is_bootstrap_global_entry() {
    local name="$1"
    [ "$name" = "plugin-toggle" ] || [ "$name" = "shared" ]
}

is_plugin_like_entry() {
    local entry="$1"
    local name
    name="$(basename "$entry")"

    if [[ "$name" == .* ]] || [[ "$name" == *.log ]]; then
        return 1
    fi

    if [ -d "$entry" ] && [ -f "$entry/index.ts" ]; then
        return 0
    fi

    if [ -f "$entry" ] && [[ "$name" == *.ts ]] && [ "$name" != "index.ts" ]; then
        return 0
    fi

    return 1
}

resolve_symlink_target() {
    local symlink_path="$1"
    local link_target
    link_target="$(readlink "$symlink_path")"

    if [[ "$link_target" = /* ]]; then
        echo "$link_target"
        return 0
    fi

    echo "$(cd "$(dirname "$symlink_path")" && pwd)/$link_target"
}

migrate_old_global_autoload() {
    [ -d "$GLOBAL_EXTENSION_DIR" ] || return 0

    local entry=""
    for entry in "$GLOBAL_EXTENSION_DIR"/*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        local name
        name="$(basename "$entry")"
        if is_bootstrap_global_entry "$name"; then
            continue
        fi

        if [ -L "$entry" ]; then
            if ! is_plugin_like_entry "$entry"; then
                continue
            fi

            local target_path="$LIBRARY_DIR/$name"
            if [ -e "$target_path" ] || [ -L "$target_path" ]; then
                local entry_real_path
                local target_real_path
                entry_real_path="$(realpath "$entry" 2>/dev/null || true)"
                target_real_path="$(realpath "$target_path" 2>/dev/null || true)"
                if [ -z "$entry_real_path" ] || [ "$entry_real_path" != "$target_real_path" ]; then
                    mark_manual_review_item "$name"
                    echo -e "${YELLOW}!${NC} Global plugin name conflict needs manual review: $name"
                    continue
                fi
            else
                mkdir -p "$LIBRARY_DIR"
                local link_target
                link_target="$(resolve_symlink_target "$entry")"
                if ln -s "$link_target" "$target_path"; then
                    mark_migrated_item "$name => $LIBRARY_DIR"
                    echo -e "${GREEN}✓${NC} Migrated old global autoload symlink: $name"
                else
                    mark_failed_item "$name => $LIBRARY_DIR"
                    echo -e "${RED}✗${NC} Failed to migrate old global autoload symlink: $name"
                    continue
                fi
            fi

            rm -rf "$entry"
            mark_removed_item "$name"
            echo -e "${YELLOW}−${NC} Removed old global autoload symlink: $name"
            continue
        fi

        if is_plugin_like_entry "$entry"; then
            mark_manual_review_item "$name"
            echo -e "${YELLOW}!${NC} Real global plugin needs manual review: $name"
        fi
    done
}

install_plugin_sources() {
    local target_dir="$1"
    local installed_file
    installed_file="$(mktemp)"

    is_installed() { grep -q "^$1$" "$installed_file" 2>/dev/null; }
    mark_installed() { echo "$1" >> "$installed_file"; }

    for dir in "$EXTENSIONS_DIR"/*/; do
        if [ -d "$dir" ]; then
            dir_name=$(basename "$dir")
            if [[ "$dir_name" == .* ]] || [ "$dir_name" = "shared" ]; then
                continue
            fi

            if [ -f "$dir/index.ts" ]; then
                install_plugin_dependencies "$dir" "$dir_name"
                if install_symlink "$dir" "$dir_name" "$target_dir"; then
                    mark_installed "$dir_name"
                fi
            elif [ -f "$dir${dir_name}.ts" ]; then
                if install_symlink "$dir${dir_name}.ts" "${dir_name}.ts" "$target_dir"; then
                    mark_installed "${dir_name}.ts"
                fi
            else
                echo -e "${YELLOW}!${NC} Skipped (no index.ts or ${dir_name}.ts): $dir_name"
            fi
        fi
    done

    for ts_file in "$EXTENSIONS_DIR"/*.ts; do
        if [ -f "$ts_file" ]; then
            ts_name=$(basename "$ts_file")
            if is_installed "$ts_name"; then
                continue
            fi
            install_symlink "$ts_file" "$ts_name" "$target_dir"
        fi
    done

    rm -f "$installed_file"
}

echo "=========================================="
echo "  Pi Agent Extensions Installer"
echo "=========================================="
echo ""
echo "Scope: $SCOPE_LABEL"
echo "Target: $TARGET_DIR"
echo ""

if [ ! -d "$EXTENSIONS_DIR" ]; then
    echo -e "${RED}Error: Extensions directory not found: $EXTENSIONS_DIR${NC}"
    exit 1
fi

SHARED_SOURCE_DIR="$EXTENSIONS_DIR/shared"

echo "Scanning extensions directory..."
echo ""

if [ "$SCOPE" = "library" ]; then
    install_plugin_sources "$LIBRARY_DIR"
    echo ""
    echo "Bootstrapping plugin-toggle globally..."
    install_symlink "$EXTENSIONS_DIR/plugin-toggle" "plugin-toggle" "$GLOBAL_EXTENSION_DIR"
    install_shared_symlink "$HOME/.pi/agent"
    install_shared_symlink "$GLOBAL_EXTENSION_DIR"
    migrate_old_global_autoload
elif [ "$SCOPE" = "project" ]; then
    install_plugin_sources "$TARGET_DIR"
    install_shared_symlink "$PWD/.pi"
    install_shared_symlink "$TARGET_DIR"
else
    install_plugin_sources "$TARGET_DIR"
    install_shared_symlink "$HOME/.pi/agent"
    install_shared_symlink "$TARGET_DIR"
fi

echo ""
echo "=========================================="
echo "  Installation Complete"
echo "=========================================="
echo ""
echo "Extensions installed to: $TARGET_DIR"
case "$SCOPE" in
    library)
        echo "Note: local plugins are shared from ~/.agents/pi-plugins. Run /toggle-plugin in a project to enable them."
        ;;
    project)
        echo "Note: project extensions load only when pi runs in this project."
        ;;
    autoload)
        echo "Note: global autoload extensions load in every project. Prefer --library for plugin-toggle-managed installs."
        ;;
esac
echo ""
print_summary_section "Overwritten items:" "${overwritten_items[@]}"
echo ""
print_summary_section "Newly installed items:" "${newly_installed_items[@]}"
echo ""
print_summary_section "Migrated old global autoload symlinks:" "${migrated_items[@]}"
echo ""
print_summary_section "Removed old global autoload symlinks:" "${removed_items[@]}"
echo ""
print_summary_section "Real global plugins needing manual review:" "${manual_review_items[@]}"

if [ "${#failed_items[@]}" -gt 0 ]; then
    echo ""
    print_summary_section "Failed items:" "${failed_items[@]}"
fi

echo ""
echo "To reload pi with new extensions, run:"
echo "  pi /reload"
