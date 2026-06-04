---
description: Generate a reviewed HTML implementation plan that matches Plan Mode and Plannotator Auto
---
Generate a comprehensive visual implementation plan for `$@` as a self-contained HTML plan artifact.

This prompt is for Plan Mode / Plannotator Auto review-first workflows. It must produce a reviewable
plan file, not an informational diagram.

## Runtime contract

- Use the `plannotator-visual-explainer` skill Plan path, not the generic diagram path.
- Inspect the codebase with read/search/list tools before designing.
- Create or update a concrete TODO list before writing the artifact.
- Write exactly one HTML plan artifact under:
  `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html`
- Do not write implementation code while drafting the plan.
- After writing the HTML file, call:
  `plannotator_auto_submit_review({ path: ".pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.html" })`
- If Plannotator denies the review, revise the same HTML file and submit it again.
- Keep the first `#` / main heading unchanged across denied revisions unless the reviewer explicitly
  asks for a rename; Plannotator uses that heading for version diffs.
- After approval, execute only the approved plan and keep TODO status aligned with progress.

## Data gathering

1. Parse the feature request:
   - Core problem and desired behavior
   - User-visible outcome
   - Constraints, scope boundaries, and non-goals
   - Explicit output format or review requirements

2. Read the relevant codebase:
   - Files likely to change
   - Existing patterns for state, commands, config, UI, tests, and error handling
   - Public APIs, extension points, hooks, and event boundaries
   - Test seams and adapter boundaries; test module interfaces, not implementation details

3. Check for prior art:
   - Similar features already implemented
   - Related plan/spec files under `.pi/plans/<repo>/`
   - Existing rejected alternatives or documented constraints

## Design requirements

Before writing HTML, reason through and verify:

- State design: new state, changed state, transitions, invalid states
- API design: commands/functions/config/types, signatures, validation, errors
- Integration design: call paths, hook points, event flow, persistence, UI updates
- Edge cases: concurrency, interruption, denial/retry, missing files, invalid config, stale state
- Verification: exact tests, lint/typecheck commands, and manual checks

If any claim cannot be verified from the code or docs, mark it as an assumption or open question.

## HTML plan content

Follow the `plannotator-visual-explainer` Plan path and Plannotator theme tokens. Prefer inline SVG for
architecture and flow diagrams. Use Mermaid only when it is safer than custom SVG; if using Mermaid,
use paired non-empty ```mermaid fences and simple `flowchart` syntax.

Include the sections that fit the task:

1. Header — title, prompt/brief, scope, non-goals
2. Summary strip — 3-5 concrete facts such as files/modules/tests affected
3. Before/after problem framing — current behavior vs. desired behavior
4. Architecture or data flow — before/after diagrams for logic/state/data/control-flow changes
5. Milestones / sequencing — dependency order without time estimates
6. Key code — minimal sketches of important types, function signatures, conditions, or assertions
7. Test and verification plan — concrete commands and test cases
8. Risks, mitigations, and open questions — severity and owner/decision point when useful

For code-changing plans that affect logic, state, data models, control flow, or process flow, include
before/after diagrams and a small key code sketch. Do not paste a full implementation.

## Quality bar

- The plan answers “what, why, and how” within 30 seconds.
- One idea per viewport; generous whitespace; no boilerplate filler.
- No time estimates.
- Do not invent file names, functions, or behavior. Cite uncertainty explicitly.
- The final answer to the user should report the artifact path and review status.

Ultrathink.
