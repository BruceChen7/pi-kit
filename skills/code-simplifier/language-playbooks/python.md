# Python Simplification Playbook

## Cleanup Heuristics

- Prefer clear control flow over dense one-liners.
- Use named intermediate values when transformations stack up.
- Keep exception handling specific and meaningful.
- Split functions when one block mixes parsing, validation, and side effects.
- Isolate special-case behavior in helpers with clear names.
- Keep data-shape decisions explicit at module boundaries.

## Examples

### 1) Expand Dense Comprehension Pipelines

#### Before

```python
total = sum(x * 2 for x in values if x > 0 and x % 3 == 0)
```

#### After

```python
positive_multiples = [x for x in values if x > 0 and x % 3 == 0]
doubled = [x * 2 for x in positive_multiples]
total = sum(doubled)
```

### 2) Narrow Broad Exception Handling

#### Before

```python
def load_user(path: str) -> dict:
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}
```

#### After

```python
def load_user(path: str) -> dict:
    try:
        raw = Path(path).read_text()
    except OSError as exc:
        raise RuntimeError(f"failed to read user file: {path}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid user json: {path}") from exc
```

### 3) Split Parsing from I/O Side Effects

#### Before

```python
def import_orders(path: str, db: Database) -> int:
    data = json.loads(Path(path).read_text())
    count = 0
    for row in data:
        if "id" in row and "total" in row and row["total"] >= 0:
            db.save_order(Order(id=row["id"], total=row["total"]))
            count += 1
    return count
```

#### After

```python
def import_orders(path: str, db: Database) -> int:
    rows = read_order_rows(path)
    valid_orders = [row_to_order(row) for row in rows if is_valid_order_row(row)]

    for order in valid_orders:
        db.save_order(order)

    return len(valid_orders)


def read_order_rows(path: str) -> list[dict]:
    return json.loads(Path(path).read_text())


def is_valid_order_row(row: dict) -> bool:
    return "id" in row and "total" in row and row["total"] >= 0


def row_to_order(row: dict) -> Order:
    return Order(id=row["id"], total=row["total"])
```

### 4) Replace Branch Pyramids with Guard Clauses

#### Before

```python
def can_publish(user: User | None, article: Article | None) -> bool:
    if user is not None:
        if article is not None:
            if article.status == "draft":
                if user.role in {"editor", "admin"}:
                    return True
    return False
```

#### After

```python
def can_publish(user: User | None, article: Article | None) -> bool:
    if user is None or article is None:
        return False
    if article.status != "draft":
        return False
    return user.role in {"editor", "admin"}
```
