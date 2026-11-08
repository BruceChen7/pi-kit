#!/bin/bash

# Install pi-agent extensions as a shared plugin library.
# Usage: ./install-plugins.sh [--library | --project | --autoload]
#
# Default behavior installs local plugins into a shared library and autoloads
# them globally:
#   - local plugins are symlinked into ~/.agents/pi-plugins
#   - every valid library plugin is linked into ~/.pi/agent/extensions
#   - shared helpers, auto-trust-work and cc-switch are bootstrapped globally
#   - use --project to install only for the current project
#
# Because library plugins are global, every repo (including a brand-new one)
# loads them without project-level .pi/extensions symlinks.
#
# Supported plugin source patterns:
#   extensions/foo/index.ts    -> creates foo/ symlink
#   extensions/foo/foo.ts      -> creates foo.ts symlink (only when foo.ts is
#                                 the sole source file; sibling modules are
#                                 unreachable through a file symlink)
#   extensions/foo.ts          -> creates foo.ts symlink
#
# A plugin that switches between those shapes (gaining or losing an index.ts)
# leaves the symlink of the abandoned shape behind, and pi loads *both* shapes
# as separate extensions — the extension then runs twice per event (visible as
# duplicated notifications). Every install therefore prunes the other shape's
# symlink when it really points at the plugin being installed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable for tests (see scripts/install-plugins.test.ts).
EXTENSIONS_DIR="${PI_KIT_EXTENSIONS_DIR:-$SCRIPT_DIR/extensions}"
LIBRARY_DIR="$HOME/.agents/pi-plugins"
GLOBAL_EXTENSION_DIR="$HOME/.pi/agent/extensions"
SCOPE="library"

# A NODE_OPTIONS hook rewrites `npm install` to a lagging internal mirror; an
# explicit --registry outranks the injected npm_config_registry.
NPM_REGISTRY="${PI_NPM_REGISTRY:-https://registry.npmjs.org/}"

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
            echo "  --library, -g    Install to ~/.agents/pi-plugins and autoload globally (default)"
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
        SCOPE_LABEL="Shared plugin library (~/.agents/pi-plugins; autoloaded globally)"
        ;;
esac

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

newly_installed_items=()
overwritten_items=()
removed_items=()
failed_items=()

mark_new_item() { newly_installed_items+=("$1"); }
mark_overwritten_item() { overwritten_items+=("$1"); }
mark_removed_item() { removed_items+=("$1"); }
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

# Prune the abandoned shape's symlink, but only when it resolves to this source.
remove_stale_shape_symlink() {
    local expected_path="$1"
    local stale_path="$2"

    [ -L "$stale_path" ] || return 0

    local expected_real_path
    local stale_real_path
    expected_real_path="$(realpath "$expected_path" 2>/dev/null || true)"
    stale_real_path="$(realpath "$stale_path" 2>/dev/null || true)"
    if [ -z "$expected_real_path" ] || [ "$expected_real_path" != "$stale_real_path" ]; then
        return 0
    fi

    rm -f "$stale_path"
    mark_removed_item "$(basename "$stale_path") => $(dirname "$stale_path")"
    echo -e "${YELLOW}−${NC} Removed abandoned symlink: $(basename "$stale_path") => $(dirname "$stale_path")"
}

# Drop symlinks whose plugin no longer exists in the source tree. The install
# loop only walks existing `extensions/*/` entries, so a plugin removed from the
# repo leaves a dangling link behind that nothing would ever revisit. Only links
# pointing into a plugin source are touched; a broken link to anywhere else is
# left alone.
prune_broken_plugin_symlinks() {
    local target_dir="$1"

    [ -d "$target_dir" ] || return 0

    local link link_target resolved
    for link in "$target_dir"/*; do
        [ -L "$link" ] || continue
        [ -e "$link" ] && continue

        link_target="$(readlink "$link")"
        resolved="$(cd "$(dirname "$link")" 2>/dev/null && realpath "$link_target" 2>/dev/null || true)"
        case "$link_target $resolved" in
            "$EXTENSIONS_DIR"/*|"$LIBRARY_DIR"/*|*" $EXTENSIONS_DIR"/*|*" $LIBRARY_DIR"/*)
                rm -f "$link"
                mark_removed_item "$(basename "$link") => $target_dir"
                echo -e "${YELLOW}−${NC} Removed broken symlink: $(basename "$link") => $link_target"
                ;;
        esac
    done
}

# plugin-toggle was removed from the repo. Drop its old global bootstrap symlink
# so pi no longer tries to load a missing extension on every start.
prune_legacy_plugin_toggle_symlink() {
    local link="$GLOBAL_EXTENSION_DIR/plugin-toggle"

    [ -L "$link" ] || return 0

    local target
    target="$(readlink "$link")"
    case "$target" in
        */extensions/plugin-toggle)
            rm -f "$link"
            mark_removed_item "plugin-toggle => $GLOBAL_EXTENSION_DIR"
            echo -e "${YELLOW}−${NC} Removed legacy plugin-toggle symlink: $target"
            ;;
    esac
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

    if [ "${PI_KIT_SKIP_PLUGIN_DEP_INSTALL:-}" = "1" ]; then
        echo "Skipping runtime dependencies for $source_name."
        return 0
    fi

    echo "Installing runtime dependencies for $source_name..."
    if (cd "$source_path" && npm install --omit=dev --ignore-scripts --registry="$NPM_REGISTRY" >/dev/null); then
        echo -e "${GREEN}✓${NC} Dependencies ready: $source_name"
        return 0
    fi

    mark_failed_item "$source_name dependencies"
    echo -e "${RED}✗${NC} Failed to install dependencies: $source_name"
    return 1
}

is_bootstrap_global_entry() {
    local name="$1"
    [ "$name" = "shared" ] || [ "$name" = "auto-trust-work" ] || [ "$name" = "cc-switch" ]
}

# Installed in the library but not autoloaded globally by default. This keeps
# the old plugin-toggle default-disabled behavior without the toggle UI; link
# one manually if you want it everywhere.
is_default_disabled_library_plugin() {
    case "$1" in
        pi-autoresearch) return 0 ;;
    esac
    return 1
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

    # Packages declare their entry points in package.json instead of an
    # index.ts at the root (e.g. ~/.agents/pi-plugins/pi-context).
    if [ -d "$entry" ] && [ -f "$entry/package.json" ]; then
        if node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(p.pi && Array.isArray(p.pi.extensions) ? 0 : 1)' "$entry/package.json" 2>/dev/null; then
            return 0
        fi
    fi

    if [ -f "$entry" ] && [[ "$name" == *.ts ]] && [ "$name" != "index.ts" ]; then
        return 0
    fi

    return 1
}

# The shared library is autoloaded: every valid library plugin is linked into
# the global extension directory. A brand-new repo therefore loads the same
# plugins without any project-level .pi/extensions symlinks.
link_library_plugins_globally() {
    [ -d "$LIBRARY_DIR" ] || return 0

    local entry name
    for entry in "$LIBRARY_DIR"/*; do
        [ -e "$entry" ] || continue
        name="$(basename "$entry")"
        if is_bootstrap_global_entry "$name"; then
            continue
        fi
        if is_default_disabled_library_plugin "$name"; then
            continue
        fi
        if is_plugin_like_entry "$entry"; then
            install_symlink "$entry" "$name" "$GLOBAL_EXTENSION_DIR"
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
                # Grew an index.ts entry: drop the abandoned foo.ts symlink.
                remove_stale_shape_symlink "${dir}${dir_name}.ts" "$target_dir/${dir_name}.ts"
                if install_symlink "$dir" "$dir_name" "$target_dir"; then
                    mark_installed "$dir_name"
                fi
            elif [ -f "$dir${dir_name}.ts" ]; then
                # A single-file symlink only exposes ${dir_name}.ts. Sibling
                # modules (e.g. review-config.ts) would be unreachable at
                # runtime: pi loads extensions via their configured path and
                # resolves relative imports against that path's directory, so
                # the sibling must live next to the symlink. Multi-file
                # extensions must use an index.ts entry (-> directory symlink).
                local sibling_source
                sibling_source="$(find "$dir" -maxdepth 1 -name '*.ts' \
                    ! -name "${dir_name}.ts" ! -name '*.test.ts' ! -name '*.spec.ts' \
                    -print -quit)"
                if [ -n "$sibling_source" ]; then
                    echo -e "${YELLOW}!${NC} $dir_name has sibling .ts files not reachable through the ${dir_name}.ts symlink (pi resolves relative imports against the symlink's directory). Add an index.ts entry so it installs as a directory."
                fi
                remove_stale_shape_symlink "$dir" "$target_dir/$dir_name"
                if install_symlink "$dir${dir_name}.ts" "${dir_name}.ts" "$target_dir"; then
                    mark_installed "${dir_name}.ts"
                fi
            elif is_plugin_like_entry "$dir"; then
                # Package-style plugin: entry points come from package.json
                # (pi.extensions), so the whole directory is the unit.
                install_plugin_dependencies "$dir" "$dir_name"
                remove_stale_shape_symlink "${dir}${dir_name}.ts" "$target_dir/${dir_name}.ts"
                if install_symlink "$dir" "$dir_name" "$target_dir"; then
                    mark_installed "$dir_name"
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
    prune_broken_plugin_symlinks "$LIBRARY_DIR"
    echo ""
    echo "Bootstrapping global extensions..."
    prune_legacy_plugin_toggle_symlink
    install_symlink "$EXTENSIONS_DIR/auto-trust-work" "auto-trust-work" "$GLOBAL_EXTENSION_DIR"
    # cc-switch is a pure global resource (localhost proxy + global model
    # catalog) with no per-project state. Loading it globally keeps its
    # provider — and any saved model pointing at it — resolvable in every
    # project, including first-time projects.
    install_symlink "$EXTENSIONS_DIR/cc-switch" "cc-switch" "$GLOBAL_EXTENSION_DIR"
    install_shared_symlink "$HOME/.pi/agent"
    install_shared_symlink "$GLOBAL_EXTENSION_DIR"
    prune_broken_plugin_symlinks "$GLOBAL_EXTENSION_DIR"
    link_library_plugins_globally
elif [ "$SCOPE" = "project" ]; then
    install_plugin_sources "$TARGET_DIR"
    prune_broken_plugin_symlinks "$TARGET_DIR"
    install_shared_symlink "$PWD/.pi"
    install_shared_symlink "$TARGET_DIR"
else
    install_plugin_sources "$TARGET_DIR"
    prune_broken_plugin_symlinks "$TARGET_DIR"
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
        echo "Note: library plugins are autoloaded from ~/.pi/agent/extensions, so every repo loads them."
        ;;
    project)
        echo "Note: project extensions load only when pi runs in this project."
        ;;
    autoload)
        echo "Note: global autoload extensions load in every project."
        ;;
esac
echo ""
print_summary_section "Overwritten items:" "${overwritten_items[@]}"
echo ""
print_summary_section "Newly installed items:" "${newly_installed_items[@]}"
echo ""
print_summary_section "Removed old global autoload symlinks:" "${removed_items[@]}"

if [ "${#failed_items[@]}" -gt 0 ]; then
    echo ""
    print_summary_section "Failed items:" "${failed_items[@]}"
fi

echo ""
echo "To reload pi with new extensions, run:"
echo "  pi /reload"
