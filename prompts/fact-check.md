---
description: Verify the factual accuracy of a document against the actual codebase, correct inaccuracies in place
---
Verify the factual accuracy of a document that makes claims about a codebase. Read the file, extract every verifiable claim, check each against the actual code and git history, correct inaccuracies in place, and add a verification summary.

This prompt may edit an existing document in place. Prefer targets under `.pi/plans/<repo>/...` so Plan Mode and Plannotator Auto can track reviewable artifacts. If the target is a reviewed Plan Mode artifact, preserve its required format. For Markdown implementation plans under `.pi/plans/<repo>/plan/*.md`, keep only the standard `## Context`, `## Steps`, `## Verification`, and `## Review` top-level sections; put the verification summary inside `## Review` instead of adding a new `## Verification Summary` section. If the edited artifact has a pending or prior Plannotator review, submit it again with `plannotator_auto_submit_review({ path })`.

For HTML files: find the active `visual-explainer` or `plannotator-visual-explainer` skill directory first, then read that skill's `references/css-patterns.md` or equivalent styling reference to match the existing page's styling when inserting the verification summary.

**Target file** — determine what to verify from `$1`:
- Explicit path: verify that specific file (`.html`, `.md`, or any text document)
- No argument: verify the most recently modified `.html` file under `.pi/plans/<repo>/plan/` (for example, `ls -t .pi/plans/*/plan/*.html | head -1`)

Auto-detect the document type and adjust the verification strategy:
- **HTML review pages** (diff-review, plan-review, project-recap): detect from page content, verify against the git ref or plan file the review was based on
- **Plan/spec documents** (markdown): verify file references, function/type names, behavior descriptions, and architecture claims against the current codebase
- **Any other document**: extract and verify whatever factual claims about code it contains

**Phase 1: Extract claims.** Read the file. Extract every verifiable factual claim:
- **Quantitative**: line counts, file counts, function counts, module counts, test counts, any numeric metrics
- **Naming**: function names, type names, module names, file paths referenced in the document
- **Behavioral**: descriptions of what code does, how things work, before/after comparisons
- **Structural**: architecture claims, dependency relationships, import chains, module boundaries
- **Temporal**: git history claims, commit attributions, timeline entries

Skip subjective analysis (opinions, design judgments, readability assessments) — these aren't verifiable facts.

**Phase 2: Verify against source.** For each extracted claim, go to the source:
- Re-read every file referenced in the document — check function signatures, type definitions, behavior descriptions against the actual code
- For claims about git history: re-run git commands (`git diff --stat`, `git log`, `git diff --name-status`, etc.) and compare output against the document's numbers
- For diff-reviews: read both the ref version (`git show <ref>:file`) and working tree version to verify before/after claims aren't swapped or fabricated
- For plan docs: verify that files, functions, and types the plan references actually exist and behave as described
- For project-recaps: re-run `git log` commands to verify activity narrative and timeline

Classify each claim:
- **Confirmed**: claim matches the code/output exactly
- **Corrected**: claim was inaccurate — note what was wrong and what the correct value is
- **Unverifiable**: claim can't be checked (e.g., references a file that doesn't exist, or a behavior that requires runtime testing)

**Phase 3: Correct in place.** Edit the file directly using surgical text replacements:
- Fix incorrect numbers, function names, file paths, behavior descriptions
- Fix before/after swaps (a common error class in review pages)
- If a section is fundamentally wrong (not just a detail error), rewrite that section's content while preserving the surrounding structure
- For HTML: preserve layout, CSS, animations, Mermaid diagrams (unless they contain factual errors in node labels or edge descriptions)
- For markdown: preserve heading structure, formatting, and document organization

**Phase 4: Add verification summary.**
- **HTML files**: insert a verification section as a banner at the top or final section, matching the page's existing styling. Use a subtle card with muted colors.
- **Standard Plan Mode markdown plan files** (`.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`): put the summary inside the existing `## Review` section so the artifact policy remains valid.
- **Other markdown files**: append a `## Verification Summary` section at the end of the document.

Include in the summary:
- Total claims checked
- Claims confirmed (with count)
- Corrections made (with brief list of what was fixed: "Changed `processCleanup` to `runCleanup` to match actual function name in `worker.ts:45`")
- Unverifiable claims flagged (if any)

**Phase 5: Report.** Tell the user what was checked, what was corrected, and the file path. For HTML, deliver through Plannotator annotation UI when appropriate; do not open the browser directly. If nothing needed correction, say so — the verification still has value as confirmation.

This is not a re-review. It does not second-guess analysis, opinions, or design judgments. It does not change the document's structure or organization. It is a fact-checker — it verifies that the data presented matches reality, corrects what doesn't, and leaves everything else alone.

Write corrections to the original file.

Ultrathink.

$@
