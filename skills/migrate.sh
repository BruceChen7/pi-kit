#!/bin/bash

# Skills Migration Script
# Usage:
#   ./migrate.sh import   - Clone skills and create symlinks in project
#   ./migrate.sh export   - Clone skills to ~/.agents/skills/
#   ./migrate.sh sync     - Sync skills from machine to project (backup)
#
# Configuration:
#   skills.txt - List of skills with format:
#     skill-name|git-repo-url|repo-path(optional)
#   - repo-path is relative to the repo root (for monorepos)
#   - Leave repo-path empty for single-skill repos

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_FILE="$SCRIPT_DIR/skills.txt"
PROJECT_SKILLS_DIR="$SCRIPT_DIR"
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
    echo "Usage: $0 {import|export|sync}"
    echo ""
    echo "Commands:"
    echo "  import   Clone skills (GitHub only) and create symlinks in project directory"
    echo "  export   Clone skills (GitHub only) to ~/.agents/skills/"
    echo "  sync     Sync skills from machine directory to project directory"
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

# Import skills: git clone + symlink to project
import_skills() {
    log_info "Importing skills to project directory..."
    ensure_git_clone_dir

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        skill_symlink_path="$PROJECT_SKILLS_DIR/$skill_name"

        # Check if symlink already exists
        if [ -L "$skill_symlink_path" ]; then
            log_warn "Symlink already exists: $skill_name"
            continue
        fi

        # Check if directory already exists (non-symlink)
        if [ -d "$skill_symlink_path" ]; then
            log_warn "Directory already exists (not symlink): $skill_name"
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

    log_info "Import completed!"
}

# Export skills: git clone to machine directory
export_skills() {
    log_info "Exporting skills to $MACHINE_SKILLS_DIR..."

    # Create machine skills directory if not exists
    mkdir -p "$MACHINE_SKILLS_DIR"

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        machine_skill_path="$MACHINE_SKILLS_DIR/$skill_name"

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
                source_path="$clone_base/$repo_path"
            else
                source_path="$clone_base"
            fi

            if [ ! -d "$source_path" ]; then
                log_error "Skill path not found: $source_path"
                continue
            fi

            rm -rf "$machine_skill_path"
            cp -r "$source_path" "$machine_skill_path"
            rm -rf "$machine_skill_path/.git" 2>/dev/null || true

            log_info "Exported skill: $skill_name"
        else
            log_warn "No git repo specified for: $skill_name"
        fi
    done < <(read_skills)

    log_info "Export completed!"
}

# Sync skills from machine to project (backup)
sync_skills() {
    log_info "Syncing skills from machine to project directory..."

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        machine_skill_path="$MACHINE_SKILLS_DIR/$skill_name"
        project_skill_path="$PROJECT_SKILLS_DIR/$skill_name"

        if [ ! -d "$machine_skill_path" ]; then
            log_warn "Skill not found in machine directory: $skill_name"
            continue
        fi

        # Remove existing symlink/directory and copy fresh
        rm -rf "$project_skill_path"
        cp -r "$machine_skill_path" "$project_skill_path"

        log_info "Synced skill: $skill_name"
    done < <(read_skills)

    log_info "Sync completed!"
}

# Main
case "${1:-}" in
    import)
        import_skills
        ;;
    export)
        export_skills
        ;;
    sync)
        sync_skills
        ;;
    *)
        usage
        ;;
esac
