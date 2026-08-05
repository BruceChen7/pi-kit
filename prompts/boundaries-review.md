---
description: Review code/test changes using Boundaries Refactor + me-tdd + Improve Codebase Architecture principles with P0-P3 severity classification
argument-hint: "[scope]"
---
Review the code or test changes using three complementary frameworks:

1. **Boundaries Refactor (Functional Core, Imperative Shell)** — Identify where IO/side effects mix with pure decision logic, where boundary DTOs are missing, and where module-level mutable state leaks. Read `/skill:boundaries-refactor` for full reference.
2. **me-tdd** — Evaluate whether tests verify behavioral contracts through public interfaces, or are coupled to implementation details, mock too deeply, or assert on call-choreography instead of outcomes. Read `/skill:me-tdd` for full reference.
3. **Improve Codebase Architecture** — Evaluate module depth and seam quality: shallow modules (interface nearly as complex as implementation), pass-through modules that fail the deletion test, tightly-coupled modules leaking across seams, and whether new tests exercise behavior through the module interface. Read `/skill:improve-codebase-architecture` for full reference.

> **Vocabulary note**: the two architecture frameworks use different terms for related concepts — boundaries-refactor speaks of *boundary DTOs* at the *IO/logic boundary*; improve-codebase-architecture speaks of *seams* and *adapters* and deliberately avoids the word "boundary". Use each framework's own terms when applying it, and tag every finding with its framework (below) so terms never mix inside one finding.

## Scope detection

Determine what to review based on the argument (`$@`):

- **No argument**: uncommitted changes only — `git diff` (working tree) and `git diff --staged` (staged)
- **Commit ref** (e.g. `HEAD`, `HEAD~1`, `abc123`): that commit's changes — `git diff <ref>~1 <ref>` and `git log -1 <ref>`
- **Commit range** (e.g. `abc123..def456`): diff between two commits
- **Branch name** (e.g. `main`, `develop`): working tree vs that branch — `git diff <branch>`
- **PR number** (e.g. `#42`): `gh pr diff 42`

For commit/range/PR scopes, also read commit messages for context:
- `git log -1 --format="%H%n%an%n%ad%n%s%n%b" <ref>` for a single commit
- `git log --oneline <range>` for a range

## Steps

0. **Determine scope**: apply the scope detection above. If reviewing a commit or range, first read commit messages (`git log -1`, `git log --oneline`) and display them for context.
1. **Read every modified file in full** — include surrounding code paths needed to judge seam placement and interface quality, not just the diff hunks.
2. **Read the three skill references** to internalize the principles.
3. **Optional context skim**: if the diff touches existing module seams, skim `.pi/contexts/CONTEXT.md` (domain vocabulary) and `.pi/contexts/adr/` (recorded decisions). Use the domain terms; do not re-litigate ADRs unless the diff creates real friction with one.
4. **Classify each finding by severity** and tag it with its framework:
   - **P0 (blocking)** — `[boundaries]` IO mixed with domain logic, pure decision embedded in shell, cannot test core without mocking filesystem; `[arch]` new code that silently breaks an existing seam or contradicts a recorded ADR decision without justification
   - **P1 (strongly recommended)** — `[tdd]` tests assert private fields, redundant test coverage (pure logic re-tested in shell), module-level mutable global state; `[arch]` shallow module (interface ≈ implementation), pass-through module that fails the deletion test, behavior untestable through the module interface
   - **P2 (moderate)** — `[tdd]` mock boilerplate that could be extracted, lightly implementation-coupled assertions, minor import issues; `[arch]` helper extraction that reduces locality for real behavior, speculative single-adapter seam
   - **P3 (minor)** — `[any]` naming, location, or structure nits
5. **Show code snippets** for each finding with before/after suggestions.
6. **For P0 findings**, include a concrete extraction suggestion: pure function signature + shell wrapper shape (`[boundaries]`), or module interface + adapter shape (`[arch]`).
7. **Mark what's already done right** before diving into issues.

## Output format

```
## 分级意见

### 🔴 P0 — 需要修复

**`[框架]` 标题** — 一句话问题描述

问题分析：什么代码在什么地方，为什么混合了 IO/逻辑或破坏了深度/接缝

建议：纯函数签名 + shell 如何调用（或模块接口 + adapter 形状）

---

### 🟡 P1 — 强烈建议

...

### 🟢 P2 — 中等

...

### 🔵 P3 — 次要

...

---

## 摘要

| 级别 | 框架 | 问题 | 现状 | 建议 |
|------|------|------|------|------|
| 🔴 P0 | boundaries | ... | ... | ... |
```
