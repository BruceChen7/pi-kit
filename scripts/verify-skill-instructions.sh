#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

failures=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

assert_absent() {
  local file=$1
  local pattern=$2
  local label=$3
  local content

  content=$(<"$file")

  if [[ "$content" == *"$pattern"* ]]; then
    fail "$label"
  else
    pass "$label"
  fi
}

assert_present() {
  local file=$1
  local pattern=$2
  local label=$3
  local content

  content=$(<"$file")

  if [[ "$content" == *"$pattern"* ]]; then
    pass "$label"
  else
    fail "$label"
  fi
}

assert_present \
  "skills/migrate.sh" \
  'ME_SKILLS_DIR="$HOME/.agents/me-skills"' \
  "migrate imports local skills into me-skills"

assert_present \
  "skills/migrate.sh" \
  'GIT_CLONE_BASE_DIR="$HOME/.agents/git-skills"' \
  "migrate keeps GitHub skills in git-skills"

assert_absent \
  "skills/migrate.sh" \
  "~/.agents/skills" \
  "migrate no longer references legacy machine skills directory"

assert_absent \
  "skills/migrate.sh" \
  "MACHINE_SKILLS_DIR" \
  "migrate no longer uses legacy machine skills variable"

assert_present \
  "skills/migrate.sh" \
  'ln -s "$local_skill_dir" "$skill_symlink_path"' \
  "migrate symlinks local skills into me-skills"

assert_absent \
  "skills/migrate.sh" \
  'ln -s "$skill_source" "$skill_symlink_path"' \
  "migrate does not symlink GitHub skills into me-skills"

assert_present \
  "skills/migrate.sh" \
  'find "$GIT_CLONE_BASE_DIR" \( -name .git -o -name node_modules \) -prune -o -name SKILL.md -print0' \
  "migrate export prunes git metadata and dependencies"

assert_absent \
  "skills/planning-suite/plan-ceo-review/SKILL.md" \
  "git for-each-ref --format='%(refname:short)' refs/remotes/origin/HEAD" \
  "plan-ceo-review avoids brittle origin/HEAD parsing"

assert_absent \
  "skills/planning-suite/pre-landing-review/SKILL.md" \
  "git for-each-ref --format='%(refname:short)' refs/remotes/origin/HEAD" \
  "pre-landing-review avoids brittle origin/HEAD parsing"

assert_present \
  "skills/planning-suite/plan-ceo-review/SKILL.md" \
  "git symbolic-ref --quiet --short refs/remotes/origin/HEAD" \
  "plan-ceo-review uses symbolic-ref base detection"

assert_present \
  "skills/planning-suite/pre-landing-review/SKILL.md" \
  "git symbolic-ref --quiet --short refs/remotes/origin/HEAD" \
  "pre-landing-review uses symbolic-ref base detection"

assert_absent \
  "skills/planning-suite/office-hours/SKILL.md" \
  $'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)\nrg -n -i "<k1>|<k2>|<k3>" "$REPO_ROOT/.pi/plans" 2>/dev/null' \
  "office-hours keyword search does not rely on cross-call shell state"

assert_absent \
  "skills/planning-suite/plan-eng-review/SKILL.md" \
  $'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)\n   SLUG=$(basename "$REPO_ROOT")\n   ls -t "$REPO_ROOT/.pi/plans/$SLUG/office-hours"/*.md 2>/dev/null | head -1' \
  "plan-eng-review office-hours lookup does not rely on cross-call shell state"

assert_present \
  "skills/planning-suite/office-hours/SKILL.md" \
  'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd); rg -n -i "<k1>|<k2>|<k3>" "$REPO_ROOT/.pi/plans" 2>/dev/null' \
  "office-hours keyword search recomputes state inline"

assert_present \
  "skills/planning-suite/plan-eng-review/SKILL.md" \
  'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd); SLUG=$(basename "$REPO_ROOT"); ls -t "$REPO_ROOT/.pi/plans/$SLUG/office-hours"/*.md 2>/dev/null | head -1' \
  "plan-eng-review office-hours lookup recomputes state inline"

assert_absent \
  "skills/brainstorming/scripts/start-server.sh" \
  ".superpowers/brainstorm/" \
  "brainstorming start-server avoids storing sessions at repo root"

assert_absent \
  "skills/brainstorming/visual-companion.md" \
  ".superpowers/brainstorm/" \
  "brainstorming visual companion docs avoid repo-root .superpowers storage"

assert_present \
  "skills/brainstorming/scripts/start-server.sh" \
  'SCREEN_DIR="${PROJECT_DIR}/.pi/brainstorm/${SESSION_ID}"' \
  "brainstorming start-server stores sessions under .pi"

assert_present \
  "skills/brainstorming/visual-companion.md" \
  '`.pi/brainstorm/`' \
  "brainstorming visual companion docs point to .pi storage"

if [ "$failures" -gt 0 ]; then
  printf '\n%s verification checks failed.\n' "$failures" >&2
  exit 1
fi

printf '\nAll verification checks passed.\n'
