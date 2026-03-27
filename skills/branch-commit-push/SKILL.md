---
name: branch-commit-push
description: |
  Create a new branch (especially when on master/main), stage changes, commit with Conventional
  Commits, and push to origin. Use whenever the user asks to commit and push, checkout a new
  branch then commit/push, or similar git workflow requests — especially if they are on the
  base branch (master/main) or mention committing from master.
compatibility: Requires git.
---

# Branch Commit Push (pi-native)

You are executing a git workflow for branching, committing, and pushing.

## Non-negotiable rules
- Use `git diff --no-ext-diff` for diffs.
- If the working tree is clean, stop and report.
- If on the base branch (master/main), create a new branch before committing/pushing.
- Ask before including untracked files.
- Commit messages must follow Conventional Commits.
- Do not write a result file; respond with a Markdown summary in-chat.

## Step 0: Repo context
1. Determine repo root and current branch; detect base branch (origin/HEAD, main/master fallback).
2. Read `AGENTS.md` and `TODOS.md` if present for repo-specific instructions.

## Step 1: Inspect changes
- `git status --short`
- `git diff --no-ext-diff`
- Identify untracked files. Ask the user whether to include them.

## Step 2: Branch handling
- If on base branch, create a new branch first.
  - If the user gave a branch name, use it.
  - Otherwise propose a descriptive branch name based on the diff and confirm.
  - `git checkout -b <branch>`.

## Step 3: Quality checks (if applicable)
- If repo instructions or `package.json` include format/lint scripts, run them when code files changed.
- If checks fail, report the failure and ask whether to continue.

## Step 4: Commit
- Stage changes (`git add -A` unless the user requests a narrower scope).
- Draft a Conventional Commits message (confirm if not provided).
- `git commit -m "<message>"`.

## Step 5: Push
- `git push -u origin <branch>`.

## Output format
Provide a Markdown summary:

```
# Branch/Commit/Push Result
- Branch: <name>
- Commit: <hash> <message>
- Push: <remote>/<branch> (success)
- Untracked files: <included/excluded>
- Notes: <format/lint results or next steps>
```
