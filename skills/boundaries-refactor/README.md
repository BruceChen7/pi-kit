# Boundaries Refactor

Refactor code toward **Functional Core, Imperative Shell** — Gary Bernhardt's pattern for extracting business decisions into pure value-in/value-out functions while keeping IO and side effects at the shell edge.

## When to use

Use this skill when code is hard to test or change because business rules are mixed with:

- Database queries, ORM models, or repository interfaces
- HTTP handlers, RPC handlers, CLI commands, cron jobs, or queue consumers
- Network clients, mailers, payment providers, storage, or filesystem calls
- `time.Now`, random IDs, environment variables, globals, or caches
- Mocks that mostly assert call choreography instead of behavior

## What it does

1. **Find the decision** — identify the business question the code answers
2. **Map effects vs values** — mark reads, writes, pure inputs, and pure outputs
3. **Create boundary DTOs** — small structs with only fields the core needs
4. **Extract the functional core** — pure function receiving values, returning values
5. **Thin the imperative shell** — load, convert, call core, interpret actions, persist
6. **Add focused tests** — table tests for core, minimal wiring tests for shell
7. **Iterate safely** — small extractions, preserve behavior, rename after tests green

## Structure

```
boundaries-refactor/
├── SKILL.md              # Entrypoint — trigger + 7-step workflow
├── manifest.json         # Lifecycle and governance metadata
├── agents/interface.yaml # Cross-platform metadata
├── references/
│   ├── go-patterns.md    # Value-in/value-out, action returns, interface placement
│   ├── smells.md         # Anti-patterns signaling tangled logic
│   └── test-cleanup.md   # Mock trimming, validation checklist
├── evals/
│   ├── trigger_cases.json    # Trigger accuracy test suite
│   └── semantic_config.json  # Positive/negative concept definitions
└── README.md             # This file
```

## Validation

```bash
# Structure validation
make -C skills validate SKILL=boundaries-refactor

# Trigger evaluation (requires evals/)
make -C skills eval SKILL=boundaries-refactor

# Skill interpretation report
make -C skills interpretation SKILL=boundaries-refactor
```

## References

- [Go Patterns](references/go-patterns.md) — code examples for core/shell shape
- [Smells](references/smells.md) — anti-patterns to watch for
- [Test Cleanup](references/test-cleanup.md) — mock trimming and validation checklist
