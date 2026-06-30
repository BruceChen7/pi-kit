# Go Patterns

## Prefer Value-In, Value-Out

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

## Return Actions Instead Of Doing Actions

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

## Keep Interfaces At The Edge

Interfaces are useful for external capabilities:

```go
type Mailer interface {
    SendBillingProblem(ctx context.Context, email string) error
}
```

Avoid pushing those interfaces into pure decision functions. In core code, prefer concrete value structs because they are easier to construct, compare, serialize, and reason about.
