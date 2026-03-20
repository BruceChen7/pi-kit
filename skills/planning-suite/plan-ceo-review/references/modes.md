# Review Modes

Explain the four modes and ask the user to pick one.

## Completeness is cheap (principle)
When AI makes implementation fast, the last 10% is usually worth doing. Prefer full coverage
when the extra effort is small and reduces risk.

## Modes
1. **Scope Expansion** — dream big. Propose ambitious improvements and let the user opt in.
2. **Selective Expansion** — keep baseline scope but surface optional upgrades for cherry-pick.
3. **Hold Scope** — no expansion; make the plan bulletproof.
4. **Scope Reduction** — cut to the minimum that ships value.

## Default guidance (if user asks)
- Greenfield feature → Expansion
- Iteration on existing system → Selective Expansion
- Bugfix/hotfix/refactor → Hold Scope
- Plan touches >15 files → suggest Reduction unless user pushes back

Ask the user to choose, then confirm which approach (from the Alternatives step) applies.
