---
name: coding-style-line-length
description: Use when writing or reviewing code to enforce 100 character line limits, format function parameters one-per-line, or structure long argument lists with trailing commas
---

# Coding Style

## Overview

Project-specific formatting rules for Go code consistency. Maximum 100 characters per line with each parameter/argument on its own line.

## When to Use

- Writing function signatures with 3+ parameters
- Calling functions with long argument lists (>100 chars)
- Code review checking formatting compliance

**When NOT to use:**
- Simple 1-2 argument calls that fit on one line
- Method chaining - use different pattern

## Line Length

**Limit: 100 characters**

Keep lines under 100 characters for readability.

**Common trap:** `gofmt` does NOT enforce 100 char limit - it only handles basic alignment. You MUST manually split long lines.

## Splitting Long Lines

**Function signatures:**
```go
// Bad: line exceeds 100 characters
func ProcessUserData(ctx context.Context, userID string, email string, phone string, address string, preferences map[string]string, lastLogin time.Time) error

// Good: each parameter on its own line
func ProcessUserData(
    ctx context.Context,
    userID string,
    email string,
    phone string,
    address string,
    preferences map[string]string,
    lastLogin time.Time,
) error
```

**Function calls:**
```go
// Bad: line exceeds 100 characters
result := CalculateMetrics(ctx, userID, startDate, endDate, metricsConfig, aggregationLevel, filterConditions, outputFormat)

// Good: each argument on its own line
result := CalculateMetrics(
    ctx,
    userID,
    startDate,
    endDate,
    metricsConfig,
    aggregationLevel,
    filterConditions,
    outputFormat,
)
```

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Relying only on `gofmt` | Long lines remain (>100 chars) | Manually split after `gofmt` |
| Missing trailing comma | `syntax error near unexpected token` | Add `,` after last parameter |
| Wrong indentation | Hard to read | Use 4 spaces for parameters |
| Closing paren on same line | Line may still exceed 100 chars | Move `)` to its own line |

## Quick Reference

| Element | Rule |
|---------|------|
| Line length | Max 100 characters |
| Parameters | One per line, 4-space indent |
| Arguments | One per line, 4-space indent |
| Trailing comma | Required after last item |
| Closing paren | On its own line |

**Tools:** Run `gofmt -w file.go` first for basic formatting, then manually split long lines.
