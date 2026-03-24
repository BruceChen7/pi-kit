---
name: pre-landing-review
description: |
  Pre-landing PR review. Analyzes the diff against the base branch for SQL safety, LLM trust
  boundary violations, conditional side effects, enum completeness, and other structural risks.
  Use when asked to review a PR, check a diff, or before merging changes.
compatibility: Requires git.
---

# Pre-Landing Review (pi-native)

You are reviewing code changes, not shipping them. Apply fixes when safe, and ask when judgement is required.

## Core rules
- Read the **full diff** before commenting.
- Use `git diff --no-ext-diff` (avoid external diff tooling).
- Auto-fix mechanical issues; ask for judgment on risky ones.
- Do not commit, push, or open a PR.

## Step 0: Detect base branch
```bash
BASE=$(git for-each-ref --format='%(refname:short)' refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')
if [ -z "$BASE" ]; then
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    BASE=main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    BASE=master
  else
    BASE=main
  fi
fi
```

Print the detected base branch and use it in all subsequent commands.

## Step 1: Check branch
1. `git branch --show-current`
2. If on base branch, stop: **“Nothing to review — you’re on the base branch or have no changes against it.”**
3. `git fetch origin <base> --quiet && git diff --no-ext-diff origin/<base> --stat` — if empty, stop with the same message.

## Step 1.5: Scope drift detection
1. Read `TODOS.md` if present.
2. Read PR description if the user provides it (paste or file), and commit messages (`git log origin/<base>..HEAD --oneline`).
3. Compare stated intent vs files changed (`git diff --no-ext-diff origin/<base> --stat`).
4. Output:
```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent: <1-line summary>
Delivered: <1-line summary>
```

## Step 2: Read the checklist
Read `references/checklist.md`. If missing, stop and report the error.

## Step 3: Get the diff
```
git fetch origin <base> --quiet
git diff --no-ext-diff origin/<base>
```

## Step 4: Two-pass review
Apply the checklist in two passes (CRITICAL then INFORMATIONAL).
For enum/value completeness, read related files outside the diff.

## Step 4.5: Design review (conditional)
Detect frontend scope by file patterns:
```
FILES=$(git diff --name-only origin/<base>)
# Frontend if any file matches: *.ts, *.tsx, *.jsx, *.vue, *.svelte, *.css, *.scss, *.sass, *.less, *.html
```
If frontend files are touched:
1. Read `DESIGN.md` or `design-system.md` if present.
2. Read `references/design-checklist.md`.
3. Read each changed frontend file (full file, not diff hunks).
4. Apply the design checklist and merge findings with the main review.

## Step 5: Fix-first review
Classify findings as AUTO-FIX or NEEDS INPUT using the checklist’s heuristic.
- Auto-fix all AUTO-FIX items.
- Batch-ask about NEEDS INPUT items with A/B options and a recommendation.

## Step 5.5: TODOS cross-reference
If `TODOS.md` exists, note any TODOs closed or newly created by this diff.

## Step 5.6: Documentation staleness
Check root `.md` docs (README, ARCHITECTURE, CONTRIBUTING, CLAUDE, etc.).
If code changed but docs didn’t, flag as informational: “Consider running /document-release.”

## Step 5.7: Optional second opinion (if Codex CLI exists)
If `which codex` is available, ask whether to run:
- `codex review --base <base>`
- or an adversarial challenge

## Output requirements
Use the output format from `references/checklist.md`.
