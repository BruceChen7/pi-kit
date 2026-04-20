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

if [ "$failures" -gt 0 ]; then
  printf '\n%s verification checks failed.\n' "$failures" >&2
  exit 1
fi

printf '\nAll verification checks passed.\n'
