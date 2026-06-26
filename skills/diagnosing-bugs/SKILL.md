---
name: diagnosing-bugs
description: Disciplined diagnosis loop for hard bugs and performance regressions. Build a feedback loop → reproduce + minimise → pattern analysis → hypothesise → instrument → fix + regression test → cleanup → question architecture when repeated fix attempts fail. Use when encountering any bug, test failure, unexpected behavior, or performance regression.
---

# Diagnosing Bugs

A discipline for hard bugs. Skip phases only when explicitly justified.

Default to Chinese unless the user explicitly asks for another language.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed through Phase 3 (Hypothesise), you cannot propose fixes.

## Guardrails

### Red Flags

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**

### Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |

### When to Use

Use this for ANY technical issue:
- Test failures, bugs in production, unexpected behavior
- Performance problems, build failures, integration issues

Use this ESPECIALLY when under time pressure — emergencies make guessing tempting.
Systematic is faster than thrashing.

---

## Phase 1 — Build a Feedback Loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on *this* bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one — try in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive *them* with a structured script so the loop is still repeatable. Captured output feeds back to you.

Build the right feedback loop, and the bug is 90% fixed.

### Tighten the loop

Treat the loop as a product. Once you have *a* loop, **tighten** it:

- Can I make it **faster**? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the **signal sharper**? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more **deterministic**? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is tight — a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### Completion criterion — a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** — a script path, a test invocation, a curl — that you have **already run at least once** (paste the invocation and its output), and that is:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to *catch this specific bug*.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.

If you catch yourself reading code to build a theory before this command exists, **stop — jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for:

(a) Access to whatever environment reproduces it.
(b) A captured artifact — HAR file, log dump, core dump, screen recording with timestamps.
(c) Permission to add temporary production instrumentation.

Do **not** proceed to Phase 2 until you have a loop you believe in.

---

## Phase 2 — Reproduce + Minimise

Run the loop. Watch it go red — the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut — keep only what's load-bearing for the failure.

Why bother: a minimal repro shrinks the hypothesis space in Phase 3 (fewer moving parts left to suspect) and becomes the clean regression test in Phase 5.

Done when **every remaining element is load-bearing** — removing any one of them makes the loop go green.

Do not proceed until you have reproduced **and** minimised.

---

## Phase 2.5 — Pattern Analysis

Before forming hypotheses, look for patterns:

1. **Find Working Examples** — locate similar working code in the same codebase. What works that's similar to what's broken?
2. **Compare Against References** — if implementing a known pattern, read the reference implementation completely. Don't skim — read every line. Understand the pattern fully before applying.
3. **Identify Differences** — what's different between working and broken? List every difference, however small. Don't assume "that can't matter."
4. **Trace Data Flow** — where does the bad value originate? What called this with a bad value? Keep tracing up until you find the source. See [root-cause-tracing.md](root-cause-tracing.md) for the complete backward tracing technique.

---

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If \<X\> is the cause, then \<changing Y\> will make the bug disappear / \<changing Z\> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it — proceed with your ranking if the user is AFK.

---

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

---

## Phase 5 — Fix + Regression Test

Write the regression test **before the fix** — but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for Phase 7.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix — **ONE change at a time**. No "while I'm here" improvements.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

**If fix doesn't work:**
- STOP. Count how many fixes you've tried.
- If < 3: Return to Phase 1/3, re-analyse with new information.
- **If ≥ 3: Skip to Phase 7.** Don't attempt Fix #4 without questioning the architecture.

---

## Phase 6 — Cleanup + Post-Mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message — so the next debugger learns

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling) hand off to `/improve-codebase-architecture` with the specifics. Make the recommendation **after** the fix is in, not before — you have more information now than when you started.

For significant debugging outcomes, consider recording the root cause and prevention strategy in an ADR under `.pi/contexts/**/adr/` or a note in `.pi/plans/<repo>/plan/`.

---

## Phase 7 — Question Architecture

If 3+ fix attempts have failed:

**Pattern indicating architectural problem:**
- Each fix reveals new shared state / coupling / problem in a different place
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

**STOP and question fundamentals:**
- Is this pattern fundamentally sound?
- Are we "sticking with it through sheer inertia"?
- Should we refactor architecture vs. continue fixing symptoms?

**Discuss with your human partner before attempting more fixes.**

This is NOT a failed hypothesis — this is a wrong architecture. Hand off to `/improve-codebase-architecture`.

---

## Supporting Files

This skill's directory includes:

- **[root-cause-tracing.md](root-cause-tracing.md)** — Trace bugs backward through the call stack to find the original trigger.
- **[defense-in-depth.md](defense-in-depth.md)** — Add validation at multiple layers after finding root cause.

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Feedback Loop** | Build tight, red-capable pass/fail signal | One command that goes red on the bug |
| **2. Reproduce + Minimise** | Run the loop, shrink repro, confirm bug | Minimal scenario, bug appears on demand |
| **2.5. Pattern Analysis** | Find working examples, trace data flow | Differences identified |
| **3. Hypothesise** | 3–5 ranked falsifiable predictions | Ranked list ready |
| **4. Instrument** | Probe one variable at a time | Hypothesis confirmed or refuted |
| **5. Fix + Test** | Write regression test, apply fix, verify | Bug resolved, test passes |
| **6. Cleanup** | Remove instrumentation, document cause | Clean commit, no loose ends |
| **7. Question Architecture** | 3+ failures → question fundamentals | Architectural discussion started |

## Pi integration

- Default to Chinese for questions, summaries, and documentation unless the user specifies another language.
- Use `.pi/contexts/**/CONTEXT.md` for domain glossary lookups during data flow tracing.
- Record significant debugging outcomes (root cause, prevention strategy) in an ADR under `.pi/contexts/**/adr/` or a note in `.pi/plans/<repo>/plan/`.
- When a debugging session reveals an architectural problem, hand off to `/improve-codebase-architecture` with specific findings.

## Attribution

Adapted from the `diagnosing-bugs` skill in https://github.com/mattpocock/skills (v1.0.0+) under the MIT License.
