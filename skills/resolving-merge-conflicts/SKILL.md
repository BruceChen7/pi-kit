---
name: resolving-merge-conflicts
description: Use when you need to resolve an in-progress git merge/rebase conflict.
---

# Resolving Merge Conflicts

Work through an in-progress git merge or rebase conflict, hunk by hunk, and finish the operation — resolved, checked, and committed.

Default to Chinese unless the user explicitly asks for another language.

Resolve by **intent**, not by text. Before touching a hunk, trace each side back to its **primary source** — the commit message, the PR, the original issue — to understand why the change was made, then preserve both intents where they're compatible. Do not invent new behaviour to paper over a clash, and never reach for `--abort`: the merge always gets finished.

## Steps

1. **See the current state** of the merge/rebase. Check git history and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made and what the original intent was. Read commit messages, check PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. **Discover and run the project's automated checks** — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.

## Pi integration

- Use `.pi/contexts/**/CONTEXT.md` for domain glossary lookups when understanding merge conflict context.
- Record significant merge resolutions (trade-offs, intent clashes) in `.pi/contexts/**/adr/` if the resolution has durable architectural implications.

## Attribution

Adapted from the `resolving-merge-conflicts` skill in https://github.com/mattpocock/skills (v1.0.0+) under the MIT License.
