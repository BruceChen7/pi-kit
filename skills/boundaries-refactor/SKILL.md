---
name: boundaries-refactor
description: >-
  Refactor code toward Functional Core, Imperative Shell: extract pure
  decision functions, thin the imperative shell, create boundary DTOs,
  and reduce mock-heavy tests. Use when code mixes business rules with
  database queries, HTTP handlers, RPC, CLI commands, cron jobs, queue
  consumers, network clients, mailers, clocks, env vars, or global state.
  Inputs: source code with tangled logic. Outputs: extracted core functions,
  thinned shell, boundary DTOs, focused tests. Not for: greenfield design,
  pure IO plumbing, or one-off script refactors.
---

# Boundaries Refactor

Refactor toward **Functional Core, Imperative Shell**:

- Core receives simple values, returns simple values.
- Shell performs IO, mutation, logging, metrics, retries.
- Boundaries are plain data structures, not live service objects.
- Tests focus on decision logic without excessive mocks.

## Use When

Business rules are mixed with:

- DB queries, ORM models, HTTP/RPC handlers, CLI commands, cron jobs, queue consumers
- Network clients, mailers, payment providers, filesystem calls
- `time.Now`, random IDs, env vars, globals, caches
- Mocks that assert call choreography instead of behavior

## Workflow

1. **Find the decision** — name the business question the code answers
2. **Map effects vs values** — mark reads, writes, pure inputs, pure outputs
3. **Create boundary DTOs** — small structs with only fields the core needs
4. **Extract the functional core** — `func Decide(input Input, now time.Time) Output`
5. **Thin the imperative shell** — load → convert → call core → interpret → persist
6. **Add focused tests** — table tests for core, minimal wiring tests for shell
7. **Iterate safely** — small extractions, preserve behavior, rename after tests green

## References

- [Go Patterns](references/go-patterns.md) — value-in/value-out, action returns, interface placement
- [Smells](references/smells.md) — anti-patterns signaling tangled logic
- [Test Cleanup](references/test-cleanup.md) — mock trimming, validation checklist
