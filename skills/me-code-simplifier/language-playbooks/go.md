# Go / Golang Simplification Playbook

## Cleanup Heuristics

- Use early returns to remove indentation pyramids.
- Keep each function focused on one policy decision.
- Keep interfaces small and consumer-oriented.
- Add context to errors where it helps debugging.
- Prefer explicit loops and steps over dense branching.
- Isolate special-case behavior in named helpers.

## Examples

### 1) Use Early Returns for Empty/Input Guards

#### Before

```go
func activeItems(items []Item) []Item {
	if items != nil {
		if len(items) > 0 {
			out := []Item{}
			for _, it := range items {
				if it.Active {
					out = append(out, it)
				}
			}
			return out
		}
	}
	return nil
}
```

#### After

```go
func activeItems(items []Item) []Item {
	if len(items) == 0 {
		return nil
	}

	out := make([]Item, 0, len(items))
	for _, it := range items {
		if it.Active {
			out = append(out, it)
		}
	}
	return out
}
```

### 2) Split Mixed Concerns by Intent

#### Before

```go
func buildInvoiceLine(raw RawLine) (InvoiceLine, error) {
	if raw.SKU == "" {
		return InvoiceLine{}, errors.New("missing sku")
	}
	if raw.Qty <= 0 {
		return InvoiceLine{}, errors.New("qty must be positive")
	}
	price, err := strconv.ParseFloat(raw.Price, 64)
	if err != nil {
		return InvoiceLine{}, err
	}
	if price < 0 {
		return InvoiceLine{}, errors.New("price must be non-negative")
	}
	return InvoiceLine{SKU: raw.SKU, Qty: raw.Qty, Price: price}, nil
}
```

#### After

```go
func buildInvoiceLine(raw RawLine) (InvoiceLine, error) {
	if err := validateRawLine(raw); err != nil {
		return InvoiceLine{}, err
	}

	price, err := parsePrice(raw.Price)
	if err != nil {
		return InvoiceLine{}, err
	}

	return InvoiceLine{SKU: raw.SKU, Qty: raw.Qty, Price: price}, nil
}

func validateRawLine(raw RawLine) error {
	if raw.SKU == "" {
		return errors.New("missing sku")
	}
	if raw.Qty <= 0 {
		return errors.New("qty must be positive")
	}
	return nil
}

func parsePrice(s string) (float64, error) {
	price, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("parse price %q: %w", s, err)
	}
	if price < 0 {
		return 0, errors.New("price must be non-negative")
	}
	return price, nil
}
```

### 3) Add Error Context at Boundaries

#### Before

```go
func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}
```

#### After

```go
func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config %q: %w", path, err)
	}
	return cfg, nil
}
```

### 4) Shrink Interfaces to What the Caller Needs

#### Before

```go
type UserStore interface {
	GetByID(ctx context.Context, id string) (User, error)
	Save(ctx context.Context, u User) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context) ([]User, error)
}

func sendWelcome(ctx context.Context, store UserStore, id string) error {
	u, err := store.GetByID(ctx, id)
	if err != nil {
		return err
	}
	return deliverWelcomeEmail(u.Email)
}
```

#### After

```go
type userReader interface {
	GetByID(ctx context.Context, id string) (User, error)
}

func sendWelcome(ctx context.Context, store userReader, id string) error {
	u, err := store.GetByID(ctx, id)
	if err != nil {
		return fmt.Errorf("load user %s: %w", id, err)
	}
	return deliverWelcomeEmail(u.Email)
}
```
