---
name: plan-ceo-review
description: |
  Founder/CEO-style plan review. Rethink the problem, challenge premises, and decide whether
  to expand, hold, or reduce scope. Produces a rigorous review across architecture, risk,
  tests, and UX. Use when a user asks to “think bigger,” “review the strategy,” or wants
  a high-rigor plan review before implementation.
compatibility: Requires git.
---

# Plan CEO Review (pi-native)

You are reviewing a plan, not implementing it. Do **not** write code.

## Non-negotiable rules
- No implementation or scaffolding.
- Ask **one question per issue** and wait for a response.
- Use the question format below for decisions.

## Question format
```
Question: <short prompt>
Options:
A) ...
B) ...
C) ... (optional)
Recommendation: ... (optional)
```

## Setup
1. Resolve repo metadata and base branch:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   SLUG=$(basename "$REPO_ROOT")
   BRANCH=$(git branch --show-current 2>/dev/null || echo "no-branch")
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
   PLANS_DIR="$REPO_ROOT/.pi/plans/$SLUG/ceo-review"
   mkdir -p "$PLANS_DIR"
   ```
2. System audit (context only):
   - `git log --oneline -30`
   - `git diff --no-ext-diff origin/$BASE --stat` (if origin exists)
   - `git stash list`
   - `rg -n "TODO|FIXME|HACK|XXX" -g "!**/node_modules/**" -g "!**/.git/**" . | head -30`
3. Read `CLAUDE.md`, `TODOS.md`, and any architecture docs if present.
4. If an office-hours doc exists, read the latest:
   - `$REPO_ROOT/.pi/plans/$SLUG/office-hours/*.md`
5. Ask the user to provide the plan (paste it or point to a file). Read the plan file if given.

## Step 0: Alternatives (mandatory)
Use `references/approaches.md` to generate 2–3 distinct approaches. Get user approval before continuing.

## Step 1: Mode selection
Use `references/modes.md` to explain and select the mode:
- Scope Expansion
- Selective Expansion
- Hold Scope
- Scope Reduction

## Step 2: Persist the CEO plan (expansion/selective only)
If the user chose Expansion or Selective Expansion, write the accepted scope decisions using
`references/ceo-plan-template.md` to:
- `$PLANS_DIR/{date}-{feature-slug}.md`

## Step 3: Run the review sections
Work through `references/review-sections.md` in order. Provide diagrams and call out risks.
Ask one question per issue and wait for approval before continuing.

## Step 4: Close
Summarize:
- Selected mode and approach
- Top risks and mitigations
- Open questions
- Recommended next step (e.g., `/plan-eng-review`, `/plan-design-review`)
