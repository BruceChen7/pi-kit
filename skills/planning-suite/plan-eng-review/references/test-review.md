# Test Review

Goal: 100% coverage of new code paths and user-visible flows.

## Test framework detection
1. Read `AGENTS.md` for a testing section.
2. If absent, auto-detect:
   ```bash
   ls jest.config.* vitest.config.* playwright.config.* cypress.config.* .rspec pytest.ini phpunit.xml 2>/dev/null
   ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
   ```
If nothing is detected, still produce the coverage diagram but skip specific test file naming.

## Step 1: Coverage diagram
Trace every planned codepath and user flow. Diagram both code paths and user flows in ASCII.
Mark each path as:
- [TESTED ★★★] Happy + error + edge cases
- [TESTED ★★] Happy path only
- [TESTED ★] Smoke only
- [GAP]

Include E2E or eval markers where needed:
- [→E2E] multi-step user flow or high-risk integration
- [→EVAL] LLM/prompt change

## Step 2: Decision matrix
Recommend E2E when:
- User flow spans 3+ components/services
- Auth/payment/data-destruction flows
- Mocking would hide real failures

Unit tests are fine for pure functions and internal helpers.

## Regression rule (mandatory)
If the plan modifies existing behavior and tests do not cover it, **add a regression test**.
This is non-optional. Mark as **CRITICAL** in the plan.

## Step 3: Add missing tests
For each GAP, specify:
- Test type (unit/integration/E2E/eval)
- Suggested test file
- What to assert (inputs → expected output)

## Step 4: Write test plan artifact
Use the template in `references/test-plan-template.md` and write to:
`.pi/plans/<repo-slug>/plan-eng-review/{user}-{branch}-test-plan-{datetime}.md`

The test plan should list pages/routes, key interactions, edge cases, and critical paths.
