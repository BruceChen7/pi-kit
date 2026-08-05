#!/usr/bin/env bash
# Regression test for migrate.sh uninstall logic:
# skills removed or commented out in skills.txt are uninstalled by `import`,
# while artifacts never declared in skills.txt are kept with a warning.
#
# Fully offline: uses file:// repos whose URLs contain "github.com" so the
# script's is_github_repo() check passes without any network access.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
MIGRATE="$ROOT_DIR/skills/migrate.sh"

T=$(mktemp -d /tmp/migrate-uninstall-test.XXXXXX)
trap 'rm -rf "$T"' EXIT

HOME_DIR="$T/home"
KIT_DIR="$T/kit"
mkdir -p "$HOME_DIR" "$KIT_DIR/skills" "$KIT_DIR/repos/github.com" "$T/outside" "$KIT_DIR/.pi/skills"

cp "$MIGRATE" "$KIT_DIR/skills/migrate.sh"

# fake local skill dirs
for s in fake-a fake-b; do
  mkdir -p "$KIT_DIR/skills/$s"
  printf -- '---\nname: %s\ndescription: test\n---\n' "$s" > "$KIT_DIR/skills/$s/SKILL.md"
done

# local git repos with "github.com" in the file:// URL
mk_repo() {
  local d="$KIT_DIR/repos/github.com/$1.git"
  mkdir -p "$d/skills/$1"
  printf -- '---\nname: %s\ndescription: test\n---\n' "$1" > "$d/skills/$1/SKILL.md"
  git -C "$d" init -q
  git -C "$d" config user.email test@test
  git -C "$d" config user.name test
  git -C "$d" add -A
  git -C "$d" commit -qm init
}
mk_repo fake-g
mk_repo fake-h
mk_repo manual

# skills.txt: active fake-a + fake-g; commented fake-b + fake-h; manual never declared
cat > "$KIT_DIR/skills/skills.txt" <<EOF
# Skills Configuration
# Format: skill-name|git-repo-url|repo-path(optional)
fake-a|local|skills/fake-a
# fake-b|local|skills/fake-b
fake-g|file://$KIT_DIR/repos/github.com/fake-g.git|skills/fake-g
# fake-h|file://$KIT_DIR/repos/github.com/fake-h.git|skills/fake-h
EOF

export HOME="$HOME_DIR"
export SKIP_SKILL_DEP_INSTALL=1

# --- pre-populate "previously installed" state ---
git clone -q "file://$KIT_DIR/repos/github.com/fake-g.git" "$HOME_DIR/.agents/git-skills/fake-g"
git clone -q "file://$KIT_DIR/repos/github.com/fake-h.git" "$HOME_DIR/.agents/git-skills/fake-h"
git clone -q "file://$KIT_DIR/repos/github.com/manual.git" "$HOME_DIR/.agents/git-skills/manual"
mkdir -p "$HOME_DIR/.agents/me-skills"
ln -s "$KIT_DIR/skills/fake-a" "$HOME_DIR/.agents/me-skills/fake-a"
ln -s "$KIT_DIR/skills/fake-b" "$HOME_DIR/.agents/me-skills/fake-b"
ln -s "$T/outside/personal-skill" "$HOME_DIR/.agents/me-skills/personal"
ln -s "$KIT_DIR/skills/ghost" "$HOME_DIR/.agents/me-skills/ghost"
ln -s "$KIT_DIR/skills/fake-b" "$KIT_DIR/.pi/skills/fake-b"
ln -s "$HOME_DIR/.agents/git-skills/fake-h/skills/fake-h" "$KIT_DIR/.pi/skills/fake-h"

failures=0
check() {
  local desc="$1"
  shift
  if "$@"; then
    printf 'PASS: %s\n' "$desc"
  else
    printf 'FAIL: %s\n' "$desc" >&2
    failures=$((failures + 1))
  fi
}

echo "=== run 1: import with fake-b/fake-h commented out ==="
bash "$KIT_DIR/skills/migrate.sh" import > "$T/run1.log" 2>&1
cat "$T/run1.log"

check "fake-g repo kept (active)"         [ -d "$HOME_DIR/.agents/git-skills/fake-g/.git" ]
check "fake-h repo removed (commented)"   [ ! -e "$HOME_DIR/.agents/git-skills/fake-h" ]
check "manual repo kept (never declared)" [ -d "$HOME_DIR/.agents/git-skills/manual/.git" ]
check "me fake-a kept (active)"           [ -L "$HOME_DIR/.agents/me-skills/fake-a" ]
check "me fake-b removed (commented)"     [ ! -e "$HOME_DIR/.agents/me-skills/fake-b" ]
check "me personal kept (not declared)"   [ -L "$HOME_DIR/.agents/me-skills/personal" ]
check "me ghost kept (not declared)"      [ -L "$HOME_DIR/.agents/me-skills/ghost" ]
check ".pi fake-h broken link removed"    [ ! -e "$KIT_DIR/.pi/skills/fake-h" ]
check ".pi fake-b kept (target exists)"   [ -L "$KIT_DIR/.pi/skills/fake-b" ]

grep -q "Uninstalled skill repo: fake-h" "$T/run1.log" && echo "PASS: log fake-h uninstall"
grep -q "Uninstalled local skill: fake-b" "$T/run1.log" && echo "PASS: log fake-b uninstall"
grep -q "Keeping git-skills repo manual" "$T/run1.log" && echo "PASS: warn manual kept"
grep -q "Keeping me-skills link ghost" "$T/run1.log" && echo "PASS: warn ghost kept"

echo "=== run 2: comment out everything active ==="
sed -i '' 's/^fake-a|/# fake-a|/; s/^fake-g|/# fake-g|/' "$KIT_DIR/skills/skills.txt"
bash "$KIT_DIR/skills/migrate.sh" import > "$T/run2.log" 2>&1

check "run2: fake-g repo removed" [ ! -e "$HOME_DIR/.agents/git-skills/fake-g" ]
check "run2: me fake-a removed"   [ ! -e "$HOME_DIR/.agents/me-skills/fake-a" ]

echo "=== run 3: re-add fake-a, import reinstalls it ==="
sed -i '' 's/^# fake-a|/fake-a|/' "$KIT_DIR/skills/skills.txt"
bash "$KIT_DIR/skills/migrate.sh" import > "$T/run3.log" 2>&1

check "run3: me fake-a reinstalled" [ -L "$HOME_DIR/.agents/me-skills/fake-a" ]

if [ "$failures" -gt 0 ]; then
  printf '\n%s uninstall test(s) failed.\n' "$failures" >&2
  exit 1
fi

printf '\nAll migrate uninstall tests passed.\n'
