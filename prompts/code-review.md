---
description: Review code/test changes using Boundaries Refactor + TDD principles with P0-P3 severity classification
argument-hint: "[path]"
---
Review the code or test changes using two complementary frameworks:

1. **Boundaries Refactor (Functional Core, Imperative Shell)** — Identify where IO/side effects mix with pure decision logic, where boundaries DTOs are missing, and where module-level mutable state leaks. Read `/skill:boundaries-refactor` for full reference.
2. **me-tdd** — Evaluate whether tests verify behavioral contracts through public interfaces, or are coupled to implementation details, mock too deeply, or assert on call-choreography instead of outcomes. Read `/skill:me-tdd` for full reference.

## Steps

1. Read every modified file in full
2. Read both skill references to internalize the principles
3. Classify each finding by severity:
   - **P0 (blocking)**: IO mixed with domain logic, pure decision embedded in shell, cannot test core without mocking filesystem
   - **P1 (strongly recommended)**: Test tests private fields, redundant test coverage (pure logic re-tested in shell), module-level mutable global state
   - **P2 (moderate)**: Mock boilerplate that could be extracted, lightly implementation-coupled assertions, minor import issues
   - **P3 (minor)**: Naming, location, or structure nits
4. Show code snippets for each finding with before/after suggestions
5. For P0 findings, include a concrete extraction suggestion (pure function signature + shell wrapper shape)
6. Mark what's already done right before diving into issues

## Output format

```
## 分级意见

### 🔴 P0 — 需要修复

**标题** — 一句话问题描述

问题分析：什么代码在什么地方，为什么混合了 IO/逻辑

建议：纯函数签名 + shell 如何调用

---

### 🟡 P1 — 强烈建议

...

### 🟢 P2 — 中等

...

### 🔵 P3 — 次要

---

## 摘要

| 级别 | 问题 | 现状 | 建议 |
|------|------|------|------|
| 🔴 P0 | ... | ... | ... |
```

## Scope

`$1` — target path or scope (optional, defaults to current working tree diff):
- Omitted: review the current working tree changes
- `path/to/file.ts`: review only that file
- `path/to/`: review a directory
- `tests/`: focus review on test quality
