#!/bin/bash

# Skills Migration Script
# Usage:
#   ./migrate.sh import   - Install GitHub + local repo skills into ~/.agents/skills
#   ./migrate.sh update   - Update GitHub skill repos in ~/.agents/git-skills
#   ./migrate.sh export   - Scan ~/.agents/skills and update skills/skills.txt
#
# Configuration:
#   skills.txt - List of skills with format:
#     skill-name|git-repo-url|repo-path(optional)
#     skill-name|local|repo-path
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
    echo "Usage: $0 {import|export|update}"
    echo ""
    echo "Commands:"
    echo "  import   Install GitHub + local repo skills into ~/.agents/skills"
    echo "  update   Update GitHub skill repos in ~/.agents/git-skills"
    echo "  export   Scan ~/.agents/skills and update skills/skills.txt"
    echo ""
    echo "Configuration:"
    echo "  Edit skills.txt to manage skill list"
    echo "  Format:"
    echo "    skill-name|git-repo-url|repo-path(optional)"
    echo "    skill-name|local|repo-path"
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

# Bash 3.2 compatibility: associative arrays are not supported.
array_contains() {
    local needle="$1"
    shift
    local item
    for item in "$@"; do
        if [ "$item" = "$needle" ]; then
            return 0
        fi
    done
    return 1
}

# Only handle GitHub repos for import/export
is_github_repo() {
    local repo_url="$1"
    [[ "$repo_url" == *"github.com"* ]]
}

# Resolve default branch
checkout_default_branch() {
    if git rev-parse --verify main >/dev/null 2>&1; then
        git checkout main >/dev/null 2>&1 || true
    elif git rev-parse --verify master >/dev/null 2>&1; then
        git checkout master >/dev/null 2>&1 || true
    else
        git checkout $(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@') >/dev/null 2>&1 || true
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
        log_info "Updating repo: $repo_name" >&2
        (cd "$clone_base" && git fetch --all -q >/dev/null 2>&1) || log_warn "Failed to fetch updates: $repo_name" >&2
    else
        if [ -n "$repo_path" ]; then
            log_info "Cloning repo (sparse checkout): $repo_name" >&2
            git clone --no-checkout "$repo_url" "$clone_base" >/dev/null 2>&1 || return 1
        else
            log_info "Cloning repo: $repo_name" >&2
            git clone "$repo_url" "$clone_base" >/dev/null 2>&1 || return 1
        fi
    fi

    if [ -n "$repo_path" ]; then
        (cd "$clone_base" && git sparse-checkout init --cone >/dev/null 2>&1 || true)
        (cd "$clone_base" && git sparse-checkout set "$repo_path" >/dev/null 2>&1 || true)
        (cd "$clone_base" && checkout_default_branch)
    else
        if [ "$(cd "$clone_base" && git config --bool core.sparseCheckout 2>/dev/null)" = "true" ]; then
            (cd "$clone_base" && git sparse-checkout disable >/dev/null 2>&1 || true)
            (cd "$clone_base" && checkout_default_branch)
        fi
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

extract_skill_name() {
    local skill_dir="$1"
    local skill_file="$skill_dir/SKILL.md"

    if [ ! -f "$skill_file" ]; then
        return 1
    fi

    local name
    name=$(awk '
        BEGIN { in_frontmatter = 0 }
        /^---[[:space:]]*$/ {
            if (in_frontmatter == 0) { in_frontmatter = 1; next }
            else { exit }
        }
        in_frontmatter == 1 && $0 ~ /^[[:space:]]*name:[[:space:]]*/ {
            sub(/^[[:space:]]*name:[[:space:]]*/, "", $0)
            sub(/[[:space:]]*$/, "", $0)
            print $0
            exit
        }
    ' "$skill_file" | tr -d '\r')

    if [ -n "$name" ]; then
        echo "$name"
        return 0
    fi

    return 1
}

is_path_within_root() {
    local path="$1"
    local root="$2"

    case "$path" in
        "$root"|"$root"/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Import skills: git clone + symlink to machine directory
import_skills() {
    log_info "Importing skills to $MACHINE_SKILLS_DIR..."
    ensure_git_clone_dir
    mkdir -p "$MACHINE_SKILLS_DIR"

    local skipped=()
    local local_repo_root
    local_repo_root=$(resolve_path "$SCRIPT_DIR/..")

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        repo_path=$(sanitize_repo_path "$repo_path")

        if [ "$repo_url" = "local" ] || { [ -z "$repo_url" ] && [ -n "$repo_path" ]; }; then
            if [ -z "$repo_path" ]; then
                log_warn "Skipping local skill with empty path: $skill_name"
                continue
            fi

            local local_skill_dir="$local_repo_root/$repo_path"
            if [ ! -d "$local_skill_dir" ]; then
                log_error "Local skill path not found: $local_skill_dir"
                continue
            fi

            local resolved_name
            if ! resolved_name=$(extract_skill_name "$local_skill_dir"); then
                resolved_name=$(basename "$local_skill_dir")
                log_warn "Missing SKILL.md name for local skill: $local_skill_dir (using $resolved_name)"
            fi

            if [ "$skill_name" != "$resolved_name" ]; then
                log_warn "Local skill name mismatch ($skill_name vs $resolved_name), using $resolved_name"
            fi

            local skill_symlink_path="$MACHINE_SKILLS_DIR/$resolved_name"
            if [ -e "$skill_symlink_path" ] || [ -L "$skill_symlink_path" ]; then
                log_warn "Skipping existing skill: $resolved_name"
                skipped+=("$resolved_name")
                continue
            fi

            ln -s "$local_skill_dir" "$skill_symlink_path"
            log_info "Created symlink: $resolved_name -> $local_skill_dir"
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

# Update skills: pull latest changes for cloned repos
update_skills() {
    log_info "Updating GitHub skill repos in $GIT_CLONE_BASE_DIR..."
    ensure_git_clone_dir

    local updated_repos=()
    local missing=()

    while IFS='|' read -r skill_name repo_url repo_path; do
        if [ -z "$skill_name" ]; then
            continue
        fi

        if [ "$repo_url" = "local" ] || { [ -z "$repo_url" ] && [ -n "$repo_path" ]; }; then
            continue
        fi

        if [ -z "$repo_url" ]; then
            log_warn "No git repo specified for: $skill_name"
            continue
        fi

        if ! is_github_repo "$repo_url"; then
            log_warn "Skipping non-GitHub repo: $skill_name"
            continue
        fi

        local repo_name
        repo_name=$(basename "$repo_url" .git)

        if array_contains "$repo_name" "${updated_repos[@]}"; then
            continue
        fi
        updated_repos+=("$repo_name")

        local clone_base="$GIT_CLONE_BASE_DIR/$repo_name"
        if [ ! -d "$clone_base/.git" ]; then
            log_warn "Repo not found in git-skills (run import first): $repo_name"
            missing+=("$repo_name")
            continue
        fi

        if (cd "$clone_base" && git fetch --all -q); then
            if (cd "$clone_base" && git pull --ff-only -q); then
                log_info "Updated repo: $repo_name"
            else
                log_warn "Failed to pull updates: $repo_name"
            fi
        else
            log_warn "Failed to fetch updates: $repo_name"
        fi
    done < <(read_skills)

    if [ "${#missing[@]}" -gt 0 ]; then
        log_warn "Missing repos (run import first): ${missing[*]}"
    fi

    log_info "Update completed!"
}

# Export skills: scan machine directory and update skills.txt
export_skills() {
    log_info "Exporting skills from $MACHINE_SKILLS_DIR to $SKILLS_FILE..."

    if [ ! -d "$MACHINE_SKILLS_DIR" ]; then
        log_error "Machine skills directory not found: $MACHINE_SKILLS_DIR"
        exit 1
    fi

    local entries=()
    local local_repo_root
    local_repo_root=$(resolve_path "$SCRIPT_DIR/..")

    while IFS= read -r -d '' entry; do
        local skill_name
        local target_path
        local git_repo_root
        local repo_url
        local repo_path
        local resolved_target

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

        resolved_target=$(resolve_path "$target_path")

        if is_path_within_root "$resolved_target" "$local_repo_root"; then
            local local_name
            if ! local_name=$(extract_skill_name "$resolved_target"); then
                local_name=$(basename "$resolved_target")
                log_warn "Missing SKILL.md name for local skill: $resolved_target (using $local_name)"
            fi

            repo_path=$(relative_path "$resolved_target" "$local_repo_root")
            repo_path=$(sanitize_repo_path "$repo_path")
            entries+=("$local_name|local|$repo_path")
            continue
        fi

        git_repo_root=$(git -C "$resolved_target" rev-parse --show-toplevel 2>/dev/null) || {
            log_warn "Skipping non-git skill: $skill_name"
            continue
        }

        repo_url=$(git -C "$git_repo_root" remote get-url origin 2>/dev/null) || {
            log_warn "Skipping git repo without origin: $skill_name"
            continue
        }

        if ! is_github_repo "$repo_url"; then
            log_warn "Skipping non-GitHub repo: $skill_name"
            continue
        fi

        repo_path=""
        if [ "$(resolve_path "$git_repo_root")" != "$resolved_target" ]; then
            repo_path=$(relative_path "$resolved_target" "$git_repo_root")
            repo_path=$(sanitize_repo_path "$repo_path")
        fi

        entries+=("$skill_name|$repo_url|$repo_path")
    done < <(find "$MACHINE_SKILLS_DIR" -mindepth 1 -maxdepth 1 -print0)

    {
        cat <<'EOF'
# Skills Configuration
# Format: skill-name|git-repo-url|repo-path(optional)
#   - repo-path is relative to the repo root (for monorepos)
#   - Leave repo-path empty for single-skill repos
#   - Local skills use: skill-name|local|repo-path (repo-path relative to this repo root)
#
# Example:
#   dispatching-parallel-agents|https://github.com/obra/superpowers.git|skills/dispatching-parallel-agents
#   pre-landing-review|local|skills/planning-suite/pre-landing-review
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
    update)
        update_skills
        ;;
    export)
        export_skills
        ;;
    *)
        usage
        ;;
esac
