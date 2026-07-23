---
description: Resume learning a repo by opening existing lessons and reference docs
argument-hint: "[topic]"
---
Resume learning this repo by opening previously created lessons. Detect `.pi/teach/` and `~/learning/` for teach workspaces.

## Topic detection

- **With argument**: use the given topic name directly (e.g. `repo-learn`, `pi-agent-design`)
- **No argument**: scan for available topics and present options

## Topic scanning

1. Scan `.pi/teach/` for topic directories that contain `lessons/*.html`
2. Also scan `~/learning/` for topic directories with `lessons/*.html`
3. **If multiple topics found** → list them and ask me to pick one
4. **If only one topic found** → use it automatically
5. **If no topics found anywhere** → see "No workspace" fallback below

## Opening lessons

For the selected topic, do both:

- **`.pi/teach/<topic>/lessons/*.html`** — open each file via `open` in filename order (0001 → 0009 → …)
- **`~/learning/<topic>/lessons/*.html`** — open each file via `open` in filename order
- Also open reference files if present:
  - `.pi/teach/<topic>/reference/*.html`
  - `~/learning/<topic>/reference/*.html`

Sort files ascending by filename. Open lessons from **Lesson 0001** onward (从头开始复习).

After opening, present a summary:
- Topic name
- Number of lessons / reference files opened
- Where they were found (`.pi/teach/` or `~/learning/`)
- Suggest I can ask questions about any lesson

## No workspace

If no teach workspace exists in either `.pi/teach/` or `~/learning/`:

1. **Check for reference docs** at `.pi/teach/<topic>/reference/*.html` — open if found
2. If still nothing, tell me no lessons found and **suggest running `/teach` to start learning** this repo

## Edge cases

- **Lessons exist in both `.pi/teach/` and `~/learning/`**: open both sets (dedup by filename, pick the newer version from whichever path)
- **Lessons directory exists but is empty**: treat as "no workspace" and fallback to reference / suggest `/teach`
- **Topic directory exists but has no `lessons/` or `reference/`**: same as empty
