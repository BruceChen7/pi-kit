---
name: push-ifs-up-fors-down
description: >
  Use when reviewing, refactoring, or designing code with messy if/for nesting, duplicated guards,
  optional/null precondition checks, scalar APIs called repeatedly in loops, hot loops, batch operations,
  enum/match plumbing, or control-flow-heavy code. Trigger this skill when the user asks to simplify
  nested conditionals, review control flow, move checks to callers, design batch APIs, optimize loops,
  reduce per-item branching, or clean up code that mixes ifs and fors. Applies the heuristic
  "push ifs up and fors down": centralize branching decisions in callers or orchestration code, and
  move iteration/batch handling into lower-level operations when it improves clarity, API shape, or performance.
---

# Push Ifs Up And Fors Down

Use this skill as a code style and refactoring heuristic. It is not a lint rule: apply it when it reduces duplicated control flow, clarifies preconditions, or improves hot-path performance.

## Core Rule

- Push `if`/`match` decisions upward toward the caller or orchestration layer.
- Push `for`/iteration downward into batch-oriented functions or data-processing layers.

The ideal shape is often: one upper-level function decides what should happen, while lower-level functions do straight-line work over valid inputs or whole batches.

## Quick Triage

Before applying the heuristic, classify the control flow:

- Policy or orchestration decision? Push it up.
- Safety, authorization, invariant, or trust-boundary validation? Keep it down.
- Repeated scalar work over a collection? Push the loop down into a batch API.
- User-visible ordering, cancellation, progress, or per-item error handling? Keep the loop high unless batching preserves those semantics.

## Common Transformations

| Smell | Better shape |
| --- | --- |
| Callee accepts `Option<T>` / nullable only to return early | Caller checks, callee accepts valid `T` |
| Helper silently no-ops on missing precondition | Caller owns the branch, helper does straight-line work |
| Enum is constructed and immediately matched | Keep direct control flow at the orchestration layer |
| Many callers write the same `for item in items { process(item) }` | Expose `process_batch(items)` |
| Loop contains a condition independent of the item | Move the condition outside the loop |
| Scalar call repeats expensive setup, lock, DB call, or RPC | Batch operation shares setup and optimizes ordering |

## Push Ifs Up

When a function checks whether it should do nothing, consider moving that check to the caller.

Prefer:

```rust
if let Some(walrus) = walrus {
    frobnicate(walrus);
}

fn frobnicate(walrus: Walrus) {
    ...
}
```

Over:

```rust
fn frobnicate(walrus: Option<Walrus>) {
    let Some(walrus) = walrus else { return };
    ...
}
```

The same shape applies outside Rust:

```ts
if (user) {
  sendWelcomeEmail(user);
}

function sendWelcomeEmail(user: User) {
  // straight-line work over a valid user
}
```

Prefer that over a helper whose main job is to accept invalid input and immediately return.

Look for:

- Functions accepting nullable/optional values only to immediately return on empty input.
- Helpers that silently no-op when a precondition fails.
- Repeated guards spread across multiple callees.
- Nested `if`/`match` branches where some branches are impossible because of checks already made by the caller.
- Temporary enums or tagged values created by one function and immediately matched by another.

Refactor by:

1. Move precondition checks to the caller that has the most context.
2. Make callee parameters express the required valid state.
3. Use types, assertions, or narrower APIs to document the precondition.
4. Keep complex branching together when that makes redundancies and dead branches visible.
5. Delegate branch bodies to small, straight-line helpers.

## Dissolve Enum Plumbing

If code constructs an enum only to immediately branch on it later, check whether the original condition can stay at the orchestration layer.

Prefer:

```rust
if condition {
    foo(x);
} else {
    bar(y);
}
```

Over:

```rust
let e = if condition { E::Foo(x) } else { E::Bar(y) };

match e {
    E::Foo(x) => foo(x),
    E::Bar(y) => bar(y),
}
```

Keep the enum when it represents a real domain state that crosses boundaries, is stored, is returned as part of an API contract, or decouples producers and consumers meaningfully.

## Push Fors Down

When callers loop over items and call a scalar operation repeatedly, consider offering a batch operation as the primary interface.

Prefer:

```rust
frobnicate_batch(walruses);
```

Over:

```rust
for walrus in walruses {
    frobnicate(walrus);
}
```

For I/O-heavy work, prefer one batch call over repeated scalar calls when semantics allow it:

```ts
const users = await fetchUsersByIds(ids);
```

Over:

```ts
const users = [];
for (const id of ids) {
  users.push(await fetchUserById(id));
}
```

Look for:

- Hot paths that process many entities.
- Repeated setup/teardown cost inside per-item calls.
- Per-item APIs that force a fixed processing order unnecessarily.
- Opportunities for batching, vectorization, caching, shared allocation, fewer locks, fewer syscalls, or fewer remote calls.
- Business logic that naturally operates on collections rather than single records.

Refactor by:

1. Add or prefer a batch-oriented function.
2. Move shared setup outside the per-item inner work.
3. Let the batch function choose ordering, grouping, buffering, and data layout.
4. Preserve or explicitly redesign caller-visible semantics: ordering, partial failure, cancellation, retries, transaction boundaries, progress reporting, idempotency, and per-item error handling.
5. Keep scalar convenience wrappers only when they are genuinely useful:

```rust
fn frobnicate_one(walrus: Walrus) {
    frobnicate_batch(std::iter::once(walrus));
}
```

## Compose The Rules

When a loop contains a condition that does not depend on the loop item, move the condition outside the loop.

Prefer:

```rust
if condition {
    for walrus in walruses {
        walrus.frobnicate();
    }
} else {
    for walrus in walruses {
        walrus.transmogrify();
    }
}
```

Over:

```rust
for walrus in walruses {
    if condition {
        walrus.frobnicate();
    } else {
        walrus.transmogrify();
    }
}
```

This avoids repeated condition evaluation, removes a branch from the hot loop, and may unlock batch processing or vectorization.

If the condition depends on each item, keep it inside the loop unless grouping items by branch would be clearer or faster.

## Review Checklist

When reviewing code, ask:

- Is this callee checking a precondition the caller already knows?
- Would moving the branch up make dead branches or duplicate conditions obvious?
- Is an enum/result object being used only to reify a branch that could remain direct control flow?
- Is this scalar API causing every caller to write the same loop?
- Is a branch inside a hot loop independent of the loop item?
- Would a batch API reduce setup cost, improve locality, or allow better ordering?

## Exceptions

Do not apply the heuristic mechanically.

Keep `if`s lower when:

- The callee is a trust boundary and must validate inputs.
- The check protects invariants, security, authorization, or data integrity.
- The caller should not know the callee's internal preconditions.
- Moving the branch up duplicates the same guard across many callers.
- A no-op API is intentional and documented.

For example, do not push authorization checks out to every caller:

```ts
function deleteAccount(user: User, actor: User) {
  if (!actor.canDelete(user)) {
    throw new ForbiddenError();
  }
  // destructive operation
}
```

Authorization is a trust-boundary check. Keeping it inside the callee prevents callers from accidentally bypassing it.

Keep `for`s higher when:

- The caller needs precise per-item control, ordering, cancellation, progress, or error handling.
- The collection is tiny and batching would complicate the API.
- A scalar function is the clearest domain abstraction.
- The loop body is genuinely orchestration rather than repeated data-plane work.

## Safe Refactoring Sequence

When changing code with this heuristic:

1. Identify whether the branch or loop is policy, validation, or repeated data-plane work.
2. Confirm current behavior for empty input, missing preconditions, ordering, cancellation, and errors.
3. Move only the control flow first; avoid changing business logic at the same time.
4. Narrow types or APIs after behavior is preserved.
5. Add or update tests when API boundaries, error behavior, or batching semantics change.

## Output Guidance

When using this skill in a review or refactor:

- Describe the specific branch or loop being moved, not just the slogan.
- Mention the expected benefit: clearer precondition, centralized control flow, fewer branches in a hot loop, batch performance, or simpler API.
- Preserve behavior first; then simplify names and types around the new control-flow shape.
- Add tests when moving conditionals changes API boundaries, error behavior, or batching semantics.

## Review Response Shape

When giving review feedback, prefer this structure:

- Pattern spotted: identify the exact branch, loop, enum plumbing, or scalar call pattern.
- Suggested shape: describe where the `if`, `match`, or `for` should move.
- Why it helps: mention clarity, precondition ownership, reduced duplicate guards, hot-loop performance, or batch API design.
- Caveat: mention when not to apply it, especially trust boundaries, invariants, ordering, cancellation, or error semantics.
