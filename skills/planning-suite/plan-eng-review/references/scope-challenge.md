# Step 0: Scope Challenge

Answer these before the main review. Be explicit and concrete.

1. **What already exists**
   - What code, utilities, or flows already solve part of this?
   - Can we reuse outputs instead of building a parallel path?

2. **Minimum change set**
   - What is the smallest change set that achieves the goal?
   - Flag anything that can be deferred without blocking the core objective.

3. **Complexity check**
   - If the plan touches >8 files or introduces >2 new services/classes, treat as a smell.
   - Ask whether to reduce scope or proceed as-is.

4. **Search check (optional)**
   - If web search tooling is available, check for built-ins and best practices.
   - If not available, state “Search unavailable — proceeding with in-distribution knowledge only.”

5. **TODOS.md cross-reference**
   - Does this plan unblock any existing TODOs?
   - Does it create new TODOs that should be captured?

6. **Completeness check**
   - Is the plan shipping a shortcut when the complete version is only marginally more effort?
   - Prefer complete handling of edge cases and tests when feasible.

7. **Distribution check** (only if new artifact type)
   - CLI, package, container, mobile app: does the plan include build/publish steps?
   - If deferred, call it out explicitly in **NOT in scope**.
