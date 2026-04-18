# Code Simplifier Language Playbooks

Language-specific cleanup reference for `skills/code-simplifier/SKILL.md`.

Use only the playbook for the active task language to keep context usage low.

## How to Use

1. Pick the active language.
2. Scan that playbook’s heuristics.
3. Copy the closest before/after pattern.
4. Keep behavior identical (inputs, outputs, side effects, and errors).

## Playbooks by Language

- [TypeScript](language-playbooks/typescript.md)
- [Go / Golang](language-playbooks/go.md)
- [Zig](language-playbooks/zig.md)
- [Python](language-playbooks/python.md)

## Cross-Language Safety Checklist

- Preserve public API contracts and data shapes.
- Prefer explicit control flow over compact cleverness.
- Remove duplication, not meaningful abstraction.
- Run tests/lint/format when available.
- If tests are missing, call out risk explicitly.
