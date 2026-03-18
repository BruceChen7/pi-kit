#!/bin/bash

# Skills Migration Script
# Usage:
#   ./migrate.sh import   - Clone skills and create symlinks in ~/.agents/skills
#   ./migrate.sh export   - Scan ~/.agents/skills and update skills/skills.txt
#
# Configuration:
#   skills.txt - List of skills with format:
#     skill-name|git-repo-url|repo-path(optional)
#   - repo-path is relative to the repo root (for monorepos)
#   - Leave repo-path empty for single-skill repos

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_FILE="$SCRIPT_DIR/skills.txt"
MACHINE_SKILLS_DIR="$HOME/.agents/skills"
GIT_CLONE_BASE_DIR="$HOME/.agents/git-skills"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

usage() {
    echo "Usage: $0 {import|export}"
    echo ""
    echo "Commands:"
    echo "  import   Clone skills (GitHub only) and create symlinks in ~/.agents/skills"
    echo "  export   Scan ~/.agents/skills for GitHub skills and update skills/skills.txt"
    echo ""
    echo "Configuration:"
    echo "  Edit skills.txt to manage skill list"
    echo "  Format: skill-name|git-repo-url|repo-path(optional)"
    exit 1
}

# Read skills from config file
read_skills() {
    if [ ! -f "$SKILLS_FILE" ]; then
        log_error "Skills file not found: $SKILLS_FILE"
        exit 1
    fi

    # Read non-empty, non-comment lines
    rg -v '^#' "$SKILLS_FILE" | rg -v '^$' | while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -n "$skill_name" ]; then
            echo "$skill_name|$repo_url|$repo_path"
        fi
    done
}

# Ensure git clone base directory exists
ensure_git_clone_dir() {
    mkdir -p "$GIT_CLONE_BASE_DIR"
}

# Trim leading/trailing slashes from repo path
sanitize_repo_path() {
    local path="$1"
    path="${path#/}"
    path="${path%/}"
    echo "$path"
}

# Only handle GitHub repos for import/export
is_github_repo() {
    local repo_url="$1"
    [[ "$repo_url" == *"github.com"* ]]
}

# Resolve default branch
checkout_default_branch() {
    if git rev-parse --verify main >/dev/null 2>&1; then
        git checkout main 2>/dev/null || true
    elif git rev-parse --verify master >/dev/null 2>&1; then
        git checkout master 2>/dev/null || true
    else
        git checkout $(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@') 2>/dev/null || true
    fi
}

# Ensure repo is cloned (supports sparse checkout when repo_path is provided)
ensure_repo_cloned() {
    local repo_url="$1"
    local repo_path="$2"

    local repo_name
    repo_name=$(basename "$repo_url" .git)
    local clone_base="$GIT_CLONE_BASE_DIR/$repo_name"

    if [ -d "$clone_base/.git" ]; then
        log_info "Updating repo: $repo_name"
        (cd "$clone_base" && git fetch --all -q) || log_warn "Failed to fetch updates: $repo_name"
    else
        if [ -n "$repo_path" ]; then
            log_info "Cloning repo (sparse checkout): $repo_name"
            git clone --no-checkout "$repo_url" "$clone_base" 2>/dev/null || return 1
        else
            log_info "Cloning repo: $repo_name"
            git clone "$repo_url" "$clone_base" 2>/dev/null || return 1
        fi
    fi

    if [ -n "$repo_path" ]; then
        (cd "$clone_base" && git sparse-checkout init --cone 2>/dev/null || true)
        (cd "$clone_base" && git sparse-checkout set "$repo_path" 2>/dev/null || true)
        (cd "$clone_base" && checkout_default_branch)
    fi

    echo "$clone_base"
}

resolve_path() {
    local path="$1"
    if command -v realpath >/dev/null 2>&1; then
        realpath "$path"
    else
        python3 - "$path" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
    fi
}

relative_path() {
    python3 - "$1" "$2" <<'PY'
import os, sys
print(os.path.relpath(sys.argv[1], sys.argv[2]))
PY
}

# Import skills: git clone + symlink to machine directory
import_skills() {
    log_info "Importing skills to $MACHINE_SKILLS_DIR..."
    ensure_git_clone_dir
    mkdir -p "$MACHINE_SKILLS_DIR"

    local skipped=()

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        skill_symlink_path="$MACHINE_SKILLS_DIR/$skill_name"

        if [ -e "$skill_symlink_path" ] || [ -L "$skill_symlink_path" ]; then
            log_warn "Skipping existing skill: $skill_name"
            skipped+=("$skill_name")
            continue
        fi

        if [ -n "$repo_url" ]; then
            if ! is_github_repo "$repo_url"; then
                log_warn "Skipping non-GitHub repo: $skill_name"
                continue
            fi

            repo_path=$(sanitize_repo_path "$repo_path")
            clone_base=$(ensure_repo_cloned "$repo_url" "$repo_path") || {
                log_error "Failed to clone: $skill_name"
                continue
            }

            if [ -n "$repo_path" ]; then
                link_source="$clone_base/$repo_path"
            else
                link_source="$clone_base"
            fi

            if [ ! -d "$link_source" ]; then
                log_error "Skill path not found: $link_source"
                continue
            fi

            ln -s "$link_source" "$skill_symlink_path"
            log_info "Created symlink: $skill_name -> $link_source"
        else
            log_warn "No git repo specified for: $skill_name"
        fi
    done < <(read_skills)

    if [ "${#skipped[@]}" -gt 0 ]; then
        log_warn "Skipped existing skills: ${skipped[*]}"
    fi

    log_info "Import completed!"
}

# Export skills: scan machine directory and update skills.txt
export_skills() {
    log_info "Exporting skills from $MACHINE_SKILLS_DIR to $SKILLS_FILE..."

    if [ ! -d "$MACHINE_SKILLS_DIR" ]; then
        log_error "Machine skills directory not found: $MACHINE_SKILLS_DIR"
        exit 1
    fi

    local entries=()

    while IFS= read -r -d '' entry; do
        local skill_name
        local target_path
        local repo_root
        local repo_url
        local repo_path

        skill_name=$(basename "$entry")

        if [ "$skill_name" = "skills.txt" ] || [ "$skill_name" = "migrate.sh" ]; then
            continue
        fi

        if [ -L "$entry" ]; then
            target_path=$(resolve_path "$entry")
        else
            target_path="$entry"
        fi

        if [ ! -d "$target_path" ]; then
            log_warn "Skipping non-directory skill: $skill_name"
            continue
        fi

        repo_root=$(git -C "$target_path" rev-parse --show-toplevel 2>/dev/null) || {
            log_warn "Skipping non-git skill: $skill_name"
            continue
        }

        repo_url=$(git -C "$repo_root" remote get-url origin 2>/dev/null) || {
            log_warn "Skipping git repo without origin: $skill_name"
            continue
        }

        if ! is_github_repo "$repo_url"; then
            log_warn "Skipping non-GitHub repo: $skill_name"
            continue
        fi

        repo_path=""
        if [ "$(resolve_path "$repo_root")" != "$(resolve_path "$target_path")" ]; then
            repo_path=$(relative_path "$target_path" "$repo_root")
            repo_path=$(sanitize_repo_path "$repo_path")
        fi

        entries+=("$skill_name|$repo_url|$repo_path")
    done < <(find "$MACHINE_SKILLS_DIR" -mindepth 1 -maxdepth 1 -print0)

    {
        cat <<'EOF'
# Skills Configuration
# Format: skill-name|git-repo-url|repo-path(optional)
# - repo-path is relative to the repo root (for monorepos)
# - Leave repo-path empty for single-skill repos
#
# Example:
#   dispatching-parallel-agents|https://github.com/obra/superpowers.git|skills/dispatching-parallel-agents
#   x-tweet-fetcher|https://github.com/user/x-tweet-fetcher.git|
EOF
        for entry in "${entries[@]}"; do
            echo "$entry"
        done
    } > "$SKILLS_FILE"

    log_info "Export completed! Wrote ${#entries[@]} skills."
}

# Main
case "${1:-}" in
    import)
        import_skills
        ;;
    export)
        export_skills
        ;;
    *)
        usage
        ;;
esac
