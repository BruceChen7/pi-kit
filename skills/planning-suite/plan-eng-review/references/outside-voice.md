# Outside Voice (optional)

If `codex` CLI is available, offer an independent plan challenge.

## Check availability
```bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
```

## If available
Ask the user whether to run an outside review. If yes:
```bash
codex exec "Review the plan below. Find logical gaps, feasibility risks, missing dependencies, or simpler alternatives. Be direct and terse.\n\nPLAN:\n<plan content>" -s read-only
```
Present the full output verbatim under:
```
CODEX SAYS (outside voice):
<verbatim output>
```

If codex is unavailable or errors, skip this step with a short note.
