---
name: boundaries-refactor
description: >-
  Use this skill when refactoring code to apply Gary Bernhardt's Boundaries /
  Functional Core, Imperative Shell style: move business decisions into pure
  value-in/value-out functions, keep IO and side effects at the edges, reduce
  mocks, improve testability, and trim brittle shell tests after core
  extraction. Especially useful for Go services, handlers, jobs, domain logic,
  and code tangled with databases, HTTP clients, queues, mailers, clocks, or
  global state.
---

# Boundaries Refactor

Refactor toward **Functional Core, Imperative Shell**:

- Core logic receives simple values and returns simple values.
- Shell code performs IO, mutation, framework calls, logging, metrics, retries, and transactions.
- Boundaries between subsystems are plain data structures, not live service objects.
- Tests focus on decision logic without excessive mocks.

## Use When

Use this skill when code is hard to test or change because business rules are mixed with:

- database queries or ORM models
- HTTP handlers, RPC handlers, CLI commands, cron jobs, or queue consumers
- network clients, mailers, payment providers, storage, filesystem calls
- `time.Now`, random IDs, environment variables, globals, caches, goroutines, or channels
- mocks that mostly assert call choreography instead of behavior

## Refactoring Workflow

1. **Find the decision**
   - Identify the business question the code answers.
   - Examples: "Which users are overdue?", "What should this cart cost?", "Which notification should be sent?", "Is this state transition allowed?"
   - Name this decision before changing code.

2. **Map effects vs values**
   - Mark reads from the outside world: DB, HTTP, files, env, clock, queues.
   - Mark writes to the outside world: DB updates, API calls, emails, logs, metrics, events.
   - Mark pure inputs already present as values: IDs, structs, slices, maps, enums, timestamps, config values.
   - Mark pure outputs the decision could return: actions, commands, validation errors, state transitions, prices, derived records.

3. **Create boundary DTOs**
   - Define small structs containing only fields the core decision needs.
   - Do not pass ORM entities, HTTP requests, DB rows, service clients, or framework contexts into the core.
   - Prefer explicit value types over `map[string]any`.
   - In Go, keep `context.Context` in the shell unless cancellation is part of the core decision, which is rare.

4. **Extract the functional core**
   - Write a function whose signature is close to:

   ```go
   func Decide(input Input, now time.Time) Output
   ```

   - Inputs should be values.
   - Outputs should describe what should happen, not perform it.
   - Inject clocks, random seeds, config, and feature flags as values.
   - Return domain errors as values when possible.

5. **Thin the imperative shell**
   - Keep loading, parsing, authorization plumbing, transactions, calls to services, persistence, logging, and metrics outside the core.
   - The shell should:
     1. load or decode outside-world data
     2. convert it into boundary values
     3. call the core
     4. interpret the returned actions
     5. persist, send, publish, or respond

6. **Add focused tests**
   - Unit test the core with table tests over plain values.
   - Cover edge cases and branching paths in the core.
   - Avoid mocks for the core.
   - Keep a small number of shell tests for integration wiring, transaction behavior, serialization, and external adapters.
   - When refactoring an existing mock-heavy test file, move assertions toward returned values, explicit outcome DTOs, and persisted effects.
   - Delete or merge tests that only re-assert UI copy, call order, or internal helper choreography after the core decision already has direct coverage.
   - Prefer one pure decision matrix test plus one wiring test over many near-duplicate harness tests.
   - A good trimming heuristic: if a test fails because wording changed, a helper was inlined, or a callback moved from the 2nd call to the 3rd, it is probably shell-noise rather than core protection.

7. **Iterate safely**
   - Prefer small extractions over sweeping rewrites.
   - Preserve public behavior first; rename and reshape after tests are green.
   - If the extracted core is awkward, the boundary values probably still mirror infrastructure too closely.

## Go Patterns

### Prefer Value-In, Value-Out

Good core shape:

```go
type CartItem struct {
    SKU      string
    Price    int
    Quantity int
}

type Coupon struct {
    PercentOff int
}

type Pricing struct {
    Subtotal int
    Discount int
    Total    int
}

func PriceCart(items []CartItem, coupon *Coupon) Pricing {
    var subtotal int
    for _, item := range items {
        subtotal += item.Price * item.Quantity
    }

    discount := 0
    if coupon != nil {
        discount = subtotal * coupon.PercentOff / 100
    }

    return Pricing{
        Subtotal: subtotal,
        Discount: discount,
        Total:    subtotal - discount,
    }
}
```

Shell shape:

```go
func (h *Handler) Checkout(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    items, err := h.Store.LoadCartItems(ctx, userIDFromRequest(r))
    if err != nil {
        http.Error(w, "load cart", http.StatusInternalServerError)
        return
    }

    coupon, err := h.Store.LoadCoupon(ctx, userIDFromRequest(r))
    if err != nil {
        http.Error(w, "load coupon", http.StatusInternalServerError)
        return
    }

    pricing := PriceCart(items, coupon)
    // Charge, persist, encode response here.
}
```

### Return Actions Instead Of Doing Actions

When the core decides multiple side effects, return action values:

```go
type BillingAction struct {
    UserID int64
    Email  string
    Kind   BillingActionKind
}

func OverdueBillingActions(users []BillingUser, today time.Time) []BillingAction {
    cutoff := today.AddDate(0, 0, -30)
    actions := make([]BillingAction, 0)

    for _, user := range users {
        if user.Active && user.LastPaidAt.Before(cutoff) {
            actions = append(actions, BillingAction{
                UserID: user.ID,
                Email:  user.Email,
                Kind:   BillingActionSendReminder,
            })
        }
    }

    return actions
}
```

The shell interprets the actions and calls mailers, repositories, queues, or APIs.

## Smells To Remove

- A domain function accepts `*sql.DB`, repository interfaces, HTTP clients, or `*http.Request`.
- A handler contains pricing, eligibility, validation, or state transition rules.
- Tests require many mocks to check simple business outcomes.
- Test assertions mostly verify "method X was called" instead of returned values or persisted effects.
- The current time, random IDs, or env config are read deep inside core logic.
- ORM models are passed through many layers and used as domain objects.
- A function both decides what should happen and performs every effect immediately.

## Keep Interfaces At The Edge

Interfaces are useful for external capabilities:

```go
type Mailer interface {
    SendBillingProblem(ctx context.Context, email string) error
}
```

Avoid pushing those interfaces into pure decision functions. In core code, prefer concrete value structs because they are easier to construct, compare, serialize, and reason about.

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

## Test Cleanup and Redundant Mock Trimming

## Practical Test-Cleanup Pattern

When a refactor extracts a functional core from a mock-heavy module:

1. Add direct tests for the new pure functions first.
2. Re-run the old harness/integration tests and classify them:
   - **Keep**: proves boundary wiring, adapter contract, approval race, serialization, persistence, or cross-system coordination.
   - **Rewrite**: currently valuable, but asserting incidental details like exact prompt text or call position.
   - **Delete**: duplicates a now-direct pure-function test and only checks shell choreography.
3. Collapse near-duplicate cases into a small table when they exercise the same boundary with different values.
4. Keep the minimum shell coverage needed to catch broken orchestration, then let core tests own the branch matrix.

## Do Not Overdo It

Do not extract a functional core for trivial pass-through code. Do not create generic DTO layers everywhere. Apply this refactor where behavior is branching, important, reused, or painful to test.
