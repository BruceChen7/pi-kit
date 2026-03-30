---
name: plan-eng-review
description: |
  Engineering-manager style plan review. Locks architecture, data flow, edge cases,
  tests, performance, and rollout risks before implementation. Use when the user has
  a plan or design doc and wants a rigorous engineering review before coding.
compatibility: Requires git. Uses GitHub CLI (gh) if available for base-branch detection.
---

# Plan Engineering Review (pi-native)

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
1. Resolve repo metadata:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   SLUG=$(basename "$REPO_ROOT")
   BRANCH=$(git branch --show-current 2>/dev/null || echo "no-branch")
   PLANS_DIR="$REPO_ROOT/.pi/plans/$SLUG/plan-eng-review"
   mkdir -p "$PLANS_DIR"
   ```
2. Read `AGENTS.md` and `TODOS.md` if they exist.
3. Find the latest office-hours design doc (if any):
   ```bash
   ls -t "$REPO_ROOT/.pi/plans/$SLUG/office-hours"/*.md 2>/dev/null | head -1
   ```
   If found, read it and use it as plan context.
4. Ask the user to provide the plan (paste it or point to a file). Read the file if given.

## If no design doc exists
Offer the user a quick `/office-hours` run before the review.
- If they choose yes, read `../office-hours/SKILL.md` and run it inline.
- Then resume this review.

## Step 0: Scope challenge
Follow `references/scope-challenge.md` and resolve scope, reuse, and completeness before moving on.

## Review sections
Work through the sections in order:
1. Architecture review
2. Code quality review
3. Test review (coverage diagram + gaps)
4. Performance review

The section instructions live in:
- `references/review-sections.md`
- `references/test-review.md`

Ask one question per issue. If a section has no issues, say so and move on.

## TODOS.md updates
For each new TODO you want to propose, follow `references/todos-format.md` and ask the
user whether to add it. One TODO per question.

## Optional outside voice
If `codex` CLI exists, offer an independent plan challenge using `references/outside-voice.md`.

## Outputs
Always include these sections in your final response:
- **What already exists** (reused code/flows)
- **NOT in scope** (explicitly deferred items)
- **Failure modes** (one realistic failure per new codepath, with coverage status)
- **Worktree parallelization** (if any)

## Test plan artifact
After the test review, write a test plan file:
- Path: `$PLANS_DIR/{user}-{branch}-test-plan-{datetime}.md`
- Template: `references/test-plan-template.md`
