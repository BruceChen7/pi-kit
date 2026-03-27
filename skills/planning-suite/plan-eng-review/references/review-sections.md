# Review Sections

## 1) Architecture review
Evaluate:
- Component boundaries and dependency graph (ASCII diagram if non-trivial).
- Data flows: happy, nil, empty, error paths.
- Coupling changes and scaling risks.
- Security boundaries and permissions.
- Rollback posture.
- Distribution pipeline if new artifact type.

Ask one question per issue. If none, state “Architecture review: no issues found.”

## 2) Code quality review
Evaluate:
- Module fit and naming clarity.
- DRY violations.
- Error handling patterns and missing edge cases.
- Over/under-engineering against the stated goals.
- Stale diagrams in touched files.

Ask one question per issue. If none, state “Code quality review: no issues found.”

## 3) Test review
Follow `references/test-review.md` to build the coverage diagram, mark gaps, and add tests.

## 4) Performance review
Evaluate:
- N+1 queries and DB access.
- Memory usage and payload size.
- Caching opportunities.
- Slow paths and p99 risks.

Ask one question per issue. If none, state “Performance review: no issues found.”

---

## Required outputs (end of review)
Include these sections:
- **What already exists**
- **NOT in scope**
- **Failure modes** (per new codepath: failure, test coverage, error handling, user impact)
- **Worktree parallelization** (or “Sequential implementation, no parallelization opportunity.”)

### Worktree parallelization format
If there are at least two independent workstreams, provide:
```
| Step | Modules touched | Depends on |
|------|------------------|------------|
| 1    | ...              | ...        |
```
Otherwise state: “Sequential implementation, no parallelization opportunity.”
