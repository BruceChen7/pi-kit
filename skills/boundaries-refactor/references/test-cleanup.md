# Test Cleanup and Redundant Mock Trimming

## Practical Test-Cleanup Pattern

When a refactor extracts a functional core from a mock-heavy module:

1. Add direct tests for the new pure functions first.
2. Re-run the old harness/integration tests and classify them:
   - **Keep**: proves boundary wiring, adapter contract, approval race, serialization, persistence, or cross-system coordination.
   - **Rewrite**: currently valuable, but asserting incidental details like exact prompt text or call position.
   - **Delete**: duplicates a now-direct pure-function test and only checks shell choreography.
3. Collapse near-duplicate cases into a small table when they exercise the same boundary with different values.
4. Keep the minimum shell coverage needed to catch broken orchestration, then let core tests own the branch matrix.

## Validation Checklist

Before finishing, verify:

- The core decision can be tested without DB, network, filesystem, sleeps, goroutines, or mocks.
- The shell is thinner than before and mostly coordinates effects.
- Boundary values contain only fields needed by the core.
- Existing behavior is preserved.
- New or updated tests cover the extracted core's important branches.
- At least one wiring or integration test still covers the shell when the refactor changes external behavior.
- Redundant mock-heavy tests were removed or simplified when pure decision tests now cover the branching logic directly.
- Remaining shell tests assert contracts and outcomes, not fragile UI strings, exact mock call counts, or nth-call sequencing unless that order is itself the contract.

## Do Not Overdo It

Do not extract a functional core for trivial pass-through code. Do not create generic DTO layers everywhere. Apply this refactor where behavior is branching, important, reused, or painful to test.
