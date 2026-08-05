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

assert_present \
  "skills/migrate.sh" \
  'cleanup_removed_skills()' \
  "migrate uninstalls skills removed from skills.txt"

assert_present \
  "skills/migrate.sh" \
  'rm -rf "$repo_dir"' \
  "migrate removes git-skills repos no longer referenced"

assert_present \
  "skills/migrate.sh" \
  'no longer in skills.txt' \
  "migrate logs uninstalls of skills removed from skills.txt"

if [ "$failures" -gt 0 ]; then
  printf '\n%s verification checks failed.\n' "$failures" >&2
  exit 1
fi

printf '\nAll verification checks passed.\n'
