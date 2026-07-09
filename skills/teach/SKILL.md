---
name: teach
description: >
  Teach the user a new skill or concept, within this workspace. Uses a structured teaching
  workspace with mission, interactive lessons, learning records, and reference materials.
  Use when the user wants to learn a new topic, skill, or concept; says "teach me", "教我",
  "help me learn", or wants guided interactive learning sessions.
argument-hint: "What would you like to learn about?"
---

# Teach

The user has asked you to teach them something. This is a stateful request — they intend to learn the topic over multiple sessions.

Default to Chinese unless the user explicitly asks for another language.

## Teaching Workspace

Create a teaching workspace in a path the user specifies. If they don't specify one, ask once where to put it. Suggested convention for Pi projects:

- For general learning: a directory outside the project root (e.g. `~/learning/<topic>/`)
- For skill-specific learning related to this project: `.pi/teach/<topic>/`
- The workspace persists across sessions so learning progress is preserved.

The state of their learning is captured in several files:

- **`MISSION.md`** — the _reason_ the user is interested in the topic. Grounds all teaching. Use the format in [MISSION-FORMAT.md](./MISSION-FORMAT.md).
- **`RESOURCES.md`** — the curated set of trusted sources for this topic. Use the format in [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md).
- **`NOTES.md`** — a scratchpad to jot down user preferences, or working notes.
- **`./reference/`** — reference documents: cheat sheets, syntax, algorithms, glossaries. Beautiful, print-friendly HTML. They are the compressed essence of lessons.
- **`./learning-records/`** — learning records capturing what the user has learned. Use the format in [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md).
- **`./lessons/`** — self-contained HTML lessons. Each lesson teaches one tightly-scoped thing tied to the mission.
- **`./assets/`** — reusable **components** shared across lessons. See [Assets](#assets).

Create files and directories lazily — only when first needed.

## Philosophy

To learn at a deep level, the user needs three things:

1. **Knowledge** — captured from high-quality, high-trust resources
2. **Skills** — acquired through highly-relevant interactive lessons devised by you, based on the knowledge
3. **Wisdom** — which comes from interacting with other learners and practitioners

Before `RESOURCES.md` is well-populated, your focus should be to find high-quality resources to help the user acquire knowledge. Never trust your parametric knowledge — always ground teaching in cited sources.

Some topics may require more skills than knowledge. Learning more about theoretical physics might lean knowledge-based. Learning yoga is more skills-based. Adapt accordingly.

### Fluency vs Storage Strength

You should be careful to split between two types of learning:

- **Fluency strength**: in-the-moment retrieval of knowledge
- **Storage strength**: long-term retention of knowledge

Fluency can give the user an illusory sense of mastery, but storage strength is the real goal. Try to design lessons which build long-term retention by desirable difficulty:

- Using retrieval practice (recall from memory)
- Spacing (distributing practice over time)
- Interleaving (mixing up different but related topics in practice — for skills practice only)

## Lessons

A **lesson** is the main thing you produce — the unit in which knowledge and skills reach the user. Each lesson is one self-contained HTML file, saved to `./lessons/` and titled `0001-<dash-case-name>.html`, incrementing the number.

A lesson should be **beautiful** — clean, readable typography and layout — since the user will return to these later to review. Think Tufte.

The lesson should be short, and completable very quickly. Learners' working memory is very small, and we need to stay within it. But each lesson should give the user a single tangible win that they can build on. It should be directly tied to the mission and within the user's zone of proximal development.

Make opening a lesson as easy as possible — ideally a single command the user can run to open the HTML file in their browser:

```bash
open ./lessons/0001-<name>.html     # macOS
xdg-open ./lessons/0001-<name>.html # Linux
```

Each lesson should link via HTML anchors to other lessons and reference documents.

Each lesson should recommend a primary source for the user to read or watch. This should be the most high-quality, high-trust resource you found on the topic.

Each lesson should contain a reminder to ask followup questions to the agent. The agent is their teacher, and can assist with anything that's unclear.

### Plannotator HTML structure

Lessons and reference documents are often reviewed through Plannotator's `--render-html`
mode (via `plannotator_auto_submit_review`), which renders the HTML inside a sandboxed
`<iframe>` with an annotation overlay. To render correctly in both contexts:

- **Always** include `<meta name="plannotator-theme" content="host">` in the `<head>`.
  Without this, Plannotator cannot sync its host theme into the iframe and dark/light
  mismatch is likely.
- **Inline the CSS** in a `<style>` tag — do NOT use `<link>` to an external `.css` file.
  Plannotator's security model rejects parent-directory paths (`../`) so the CSS won't
  load from `href="../assets/shared.css"`. See [Assets](#assets) for details.
- **The shared stylesheet must use the CSS variable chain pattern** described in
  [Assets > Plannotator compatibility](#plannotator-compatibility).

### Lesson structure

Each lesson should:

1. **State what the user will learn** — one short sentence at the top.
2. **Teach the knowledge** — concise, citation-backed explanation.
3. **Interactive practice** — quiz, in-browser task, or real-world steps.
4. **Feedback** — immediate feedback on the user's practice.
5. **Call to action** — what to try next, or a prompt to ask follow-up questions.

Litter lessons with **citations** — links to external resources backing every claim. This increases trustworthiness and gives the user a path to go deeper.

## Assets

Lessons are built from reusable **components**, stored in `./assets/`: stylesheets, quiz widgets, simulators, diagram helpers — anything a second lesson could reuse.

Reuse is the default, not the exception. Before authoring a lesson, read `./assets/` and build from the components already there. When a lesson needs something new and reusable, write it as a component in `./assets/` and link to it — never inline code a future lesson would duplicate.

A shared stylesheet is the first component every workspace earns, maintained at `./assets/shared.css` as the canonical source. When generating each lesson or reference document, **inline the CSS content into a `<style>` tag** — do NOT use `<link rel="stylesheet" href="../assets/shared.css">`. Plannotator's asset path security rejects parent-directory (`../`) paths, so the external CSS won't load inside its sandboxed iframe. Inlining avoids this and makes each lesson fully self-contained. Keep the `./assets/shared.css` file as the source of truth for editing; the inlining happens at generation time.

### Plannotator compatibility

Lessons and reference documents are often reviewed through Plannotator's `--render-html`
mode, which renders them inside a sandboxed `<iframe>` with an annotation overlay.
The shared stylesheet must let lessons render correctly in both standalone and
Plannotator contexts.

The CSS variable chain pattern handles this without coupling to Plannotator internals.
It uses a **private intermediate variable** to avoid circular references:

```css
/* ═══════════════════════════════════════════
 * Layer 1 — Standalone light defaults
 * ═══════════════════════════════════════════ */
:root {
  --_bg: #fafafa;
  --_card-bg: #ffffff;
  --_text: #1a1a2e;
  --_muted: #6b7280;
  --_accent: #3b82f6;
  --_border: #e5e7eb;
  --_code-bg: #f3f4f6;
  --_accent-light: #eff6ff;
  --_table-stripe: #f8fafc;
  --_success-bg: #ecfdf5;
  --_error-bg: #fef2f2;
}

/* ═══════════════════════════════════════════
 * Layer 2 — Standalone dark mode
 * (only applies when NOT inside Plannotator)
 * ═══════════════════════════════════════════ */
@media (prefers-color-scheme: dark) {
  :root {
    --_bg: #0f172a;
    --_card-bg: #1e293b;
    --_text: #e2e8f0;
    --_muted: #94a3b8;
    --_border: #334155;
    --_code-bg: #1e293b;
    --_accent-light: #1e3a5f;
    --_table-stripe: #1e293b;
    --_success-bg: #064e3b;
    --_error-bg: #7f1d1d;
  }
}

/* ═══════════════════════════════════════════
 * Layer 3 — Plannotator host-theme chain
 * Plannotator unconditionally injects --pn-*
 * into the iframe at runtime. When present they
 * override; when absent (standalone) they fall
 * back to the private --_* variables from L1/L2.
 *
 * ⚠️  Never reference a public variable within
 * its own definition — that creates a circular
 * reference (CSS spec invalidates it).
 * ═══════════════════════════════════════════ */
:root {
  --bg: var(--pn-background, var(--_bg));
  --card-bg: var(--pn-card, var(--_card-bg));
  --text: var(--pn-foreground, var(--_text));
  --muted: var(--pn-muted, var(--_muted));
  --accent: var(--pn-primary, var(--_accent));
  --border: var(--pn-border, var(--_border));
  --code-bg: var(--pn-code-bg, var(--_code-bg));
}
```

**然后，必须把所有硬编码的 `background: white` 替换为 `background: var(--card-bg)`**，
以及所有硬编码的彩色背景（如 `#ecfdf5`、`#fef2f2`）替换为对应的变量。
没有这些替换，暗色模式下白底会残留，页面就是"一块块白的拼在暗色背景上"。

**Why the `--_` private variable?** CSS custom properties that reference themselves
in their own fallback are invalid. If layer 3 said `--bg: var(--pn-background, var(--bg))`,
the `var(--bg)` fallback creates a cycle → the declaration is ignored.
By separating the storage (`--_bg`) from the public API (`--bg`), the chain is
always a DAG and always resolves.

**Variable mapping reference:**
| Teach variable | Plannotator `--pn-*` | Note |
|---|---|---|
| `--bg` | `--pn-background` | Page background |
| `--card-bg` | `--pn-card` | Card/box background (replaces `background: white`) |
| `--text` | `--pn-foreground` | Body text |
| `--muted` | `--pn-muted` | Muted/secondary text |
| `--accent` | `--pn-primary` | Links, borders, headings |
| `--border` | `--pn-border` | Table/block borders |
| `--code-bg` | `--pn-code-bg` | Code/inline-code background |
| `--_table-stripe` | (no `--pn-*`; standalone only) | Alternating table row |
| `--_success-bg` | (no `--pn-*`; standalone only) | Quiz correct bg |
| `--_error-bg` | (no `--pn-*`; standalone only) | Quiz wrong bg |

Variables prefixed `--_` are private to the chain pattern; they don't have
`--pn-*` equivalents, so they only change between light/dark in standalone mode.

**When inlining the CSS into the lesson HTML, also strip `@import` rules**
(typically for external fonts). Google Fonts `@import` can fail or be delayed
inside the sandboxed iframe, leaving the page briefly unstyled. Instead:

- Use a system font stack as primary fallback (e.g. `-apple-system, system-ui, sans-serif`)
- Optionally include a `<link rel="stylesheet" href="https://fonts.googleapis.com/...">`
  in the `<head>` **if** fonts are essential — Plannotator rewrites `<link>` tags for
  external URLs correctly, unlike CSS `@import`.

**Every lesson's `<head>` must also include:**
```html
<meta name="plannotator-theme" content="host">
```

This lets Plannotator know the document is aware of host theming. Without it,
Plannotator skips bare `--background` / `--foreground` injection and the
`--pn-*` chain won't receive host values.

See [Lessons > Plannotator HTML structure](#plannotator-html-structure) for the
per-lesson requirements.

## The Mission

Every lesson should tie back to the mission — the reason the user is interested in learning about the topic.

If the user is unclear about the mission, or `MISSION.md` is not populated, your first job should be to question the user on why they want to learn this.

Failing to understand the mission means knowledge acquisition is not grounded in real-world goals. Lessons will feel too abstract. You will have no way of judging what the user should do next.

Missions may change as the user develops more skills and knowledge. This is normal — make sure to update the `MISSION.md` and add a learning record to capture the change. Confirm with the user before changing the mission.

## Zone Of Proximal Development

Each lesson should challenge the user 'just enough'.

- If the user specifies an exact thing to learn, teach that.
- If they don't, read their `learning-records/` and `MISSION.md` to determine the optimal next topic.
- Teach the most relevant thing that fits in their zone of proximal development.
- If the user says they already know about a topic, record it in `learning-records/` and move on.

## Acquiring Knowledge & Skills

Lessons should be designed around a **skill** the user is going to learn. The knowledge in the lesson should be only what's required to acquire that skill. Teach the knowledge first, then get the user to practice the skills via an interactive feedback loop.

For acquiring knowledge, difficulty is the enemy — it eats the working memory you need for understanding.

For skill acquisition, difficulty is the tool. Effortful retrieval is what builds storage strength.

### Skills practice patterns

- **Interactive lessons** — quizzes and light in-browser tasks
- **Real-world step guides** — e.g. yoga pose sequences, coding exercises
- **In-agent quizzes** — scenario-based questions about what they've learned

For quizzes, each answer should be exactly the same number of words (and characters, if possible). Don't give the user any clues about the answer through formatting.

Each should be based on a **feedback loop** where the user receives immediate feedback on their performance. The tighter the loop, the faster the learning.

## Acquiring Wisdom

Wisdom comes from true real-world interaction — testing skills outside the learning environment.

When the user asks a question that appears to require wisdom, your default posture should be to attempt to answer — but to ultimately delegate to a **community**: forums, subreddits, real-world classes, or local interest groups.

You should attempt to find high-reputation communities the user can join. If the user expresses a preference not to join a community, respect it.

## Reference Documents

While creating lessons, create **reference documents** alongside them:

- Syntax and code snippets for programming topics
- Algorithms and flowcharts for processes
- Yoga poses and sequences for fitness
- Glossaries for any topic with its own nomenclature (use [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md))

Lessons are rarely revisited after completion. Reference documents are — they should be the compressed essence of the lesson, designed for quick reference.

Glossaries, in particular, are essential. Once created, adhere to their terminology in every lesson.

## `NOTES.md`

The user will sometimes express preferences for how they want to be taught, or things you should keep in mind. Record those preferences here so you can refer back to them when designing lessons or working with the user.

## Pi integration

- Teaching workspace paths follow user preference — `.pi/teach/<topic>/` for project-related learning, external paths for general learning.
- When a lesson or reference artifact would benefit from review, use `plannotator_auto_submit_review`.
- Learning records under `.pi/contexts/` or ADRs for domain terminology are also valid when the learning is closely coupled to this project's domain language.
- Plan files under `.pi/plans/<repo>/plan/` can reference teaching milestones or lesson outcomes.
