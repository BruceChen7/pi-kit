# TypeScript Simplification Playbook

## Cleanup Heuristics

- Make domain intent explicit with types at boundaries.
- Replace nested ternaries with guard clauses or small helpers.
- Break dense chains into named intermediate values.
- Prefer discriminated unions over ad-hoc nullable state combinations.
- Pull repeated branch logic into focused helpers.
- Keep function signatures explicit when they represent stable contracts.

## Examples

### 1) Flatten Nested Conditionals

#### Before

```ts
const status = loading ? "loading" : error ? "error" : done ? "done" : "idle";
```

#### After

```ts
function getStatus(loading: boolean, error: boolean, done: boolean): string {
  if (loading) return "loading";
  if (error) return "error";
  if (done) return "done";
  return "idle";
}
```

### 2) Make Pipelines Readable

#### Before

```ts
const total = orders
  .filter((o) => o.state === "paid" && o.items.length > 0)
  .flatMap((o) => o.items)
  .filter((i) => i.price > 0)
  .map((i) => i.price * i.qty)
  .reduce((sum, v) => sum + v, 0);
```

#### After

```ts
const paidOrders = orders.filter((o) => o.state === "paid" && o.items.length > 0);
const lineItems = paidOrders.flatMap((o) => o.items);
const billableItems = lineItems.filter((i) => i.price > 0);
const subtotals = billableItems.map((i) => i.price * i.qty);
const total = subtotals.reduce((sum, v) => sum + v, 0);
```

### 3) Replace Nullable Flag Combinations with a Union

#### Before

```ts
type UserState = {
  loading: boolean;
  error?: string;
  data?: User[];
};

function render(state: UserState): string {
  if (state.loading) return "Loading...";
  if (state.error) return `Error: ${state.error}`;
  if (state.data && state.data.length === 0) return "No users";
  if (state.data) return `${state.data.length} users`;
  return "Idle";
}
```

#### After

```ts
type UserState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; users: User[] }
  | { kind: "idle" };

function render(state: UserState): string {
  switch (state.kind) {
    case "loading":
      return "Loading...";
    case "error":
      return `Error: ${state.message}`;
    case "empty":
      return "No users";
    case "ready":
      return `${state.users.length} users`;
    case "idle":
      return "Idle";
  }
}
```

### 4) Clarify Repeated Optional Checks

#### Before

```ts
function canCheckout(user?: User, cart?: Cart): boolean {
  return !!user && !!cart && cart.items.length > 0 && !user.suspended && user.emailVerified;
}
```

#### After

```ts
function canCheckout(user?: User, cart?: Cart): boolean {
  if (!user || !cart) return false;
  if (cart.items.length === 0) return false;
  if (user.suspended) return false;
  return user.emailVerified;
}
```
