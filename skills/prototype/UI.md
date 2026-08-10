# UI Prototype（静态 HTML + Plannotator 评审）

Generate **several radically different UI variations in a single self-contained HTML file**, switchable from a floating bottom bar, reviewed through **Plannotator**. The user flips between variants in the browser, drag-selects or pinpoints elements to annotate, sends feedback, and you iterate until they approve.

Default to Chinese unless the user explicitly asks for another language.

If the question is about logic/state rather than what something looks like — wrong branch. Use [LOGIC.md](LOGIC.md).

## When this is the right shape

- "这个页面应该长什么样？"
- "我想在提交代码前看看这个仪表盘的几种方案。"
- "给配置页面试一种不同的布局。"
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Deliverable location

Write the prototype to a **single self-contained HTML file** under the HTML artifact review directory:

```
.pi/html/<repo>/YYYY-MM-DD-<slug>.html
```

(`<repo>` follows the same slug resolution as plan files — the repo name or cwd basename.) Writing there auto-queues a pending review gate, and submitting it opens the **Plannotator annotate** review (one-shot; re-submissions show a version diff). Do NOT write prototype HTML anywhere else if you want the review loop.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being radically different and starts being noise — cap there.

Write down the plan in a top-of-file HTML comment:

> "配置页面的三种变体，评审走 Plannotator。"

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to. **Statically recreate the real context**: if the prototype is for something inside an existing app, replicate its real header, sidebar, data, and density in the HTML (hardcoded sample data is fine) — a mockup in a vacuum hides design problems.
- The project's component library / styling system (TailwindCSS via CDN, shadcn-style patterns, plain CSS — whatever matches the project).
- A clear variant key, e.g. `A`, `B`, `C`.

Variants must be **structurally different** — different layout, different information hierarchy, different primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together in one file

All variants live in the same HTML file; one JS switcher shows/hides them:

```html
<section data-variant="A" class="variant"><!-- VariantA markup --></section>
<section data-variant="B" class="variant" hidden><!-- VariantB markup --></section>
<section data-variant="C" class="variant" hidden><!-- VariantC markup --></section>
```

Switcher behavior:

- **State** — a plain module-level variable. Do NOT use `localStorage`, `history.replaceState`, or `location.search`: the review sandbox blocks all three (see §4b). Optionally, keep a `<meta name="pn-review-variant" content="B">` tag in `<head>`; the switcher reads it at startup (falling back to the first variant), and the agent updates it to the variant the user's feedback referred to when revising — so the next review session opens on the variant being iterated instead of bouncing back to A.
- **Floating bar** — a small fixed-position bar at the bottom-centre, visually distinct from the page (high-contrast pill, subtle shadow): left arrow cycles back, variant label shows the key (+ name if useful, e.g. `B — Sidebar layout`), right arrow cycles forward. Wraps around.
- **Keyboard** — `←` / `→` also cycle. Don't intercept arrow keys when an `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- On load, hide all variants except the active one.

### 4. Generate constraints (Plannotator review-surface compatibility)

The file is reviewed inside Plannotator's sandboxed iframe (srcdoc, `sandbox="allow-scripts"`), so:

- **Self-contained**: inline all CSS and JS. CDN references (fonts, Tailwind, Mermaid) are acceptable; local assets must be copied next to the HTML file and referenced with **relative paths** (never root-prefixed `/assets/...`). See the `teach` skill's "Review-surface compatibility" section for the same constraints in detail.
- No external CSS files via `<link href="../...">`.
- The artifact must render identically standalone and inside the review.

### 4b. Interactive controls (Plannotator review)

Plannotator's review opens in **drag mode**: text drags open the annotation card, but plain clicks pass through — custom interactive controls work without any marking. Only **pinpoint mode** (the reviewer toggles it in the toolstrip to annotate a specific element) intercepts clicks. Rules:

- **No marking needed.** Do NOT add `data-lavish-action` or any review-specific attribute; review targets and controls alike render exactly as standalone.
- **Native controls pass through for free.** `<button>`, `<a href>`, `<input>`, `<select>`, `<textarea>`, `<label>`, `<summary>` need nothing.
- **Keyboard fallback is mandatory.** Because a pinpoint-mode review intercepts clicks on every element, every select/switch interaction must also work from the keyboard (`←`/`→` to cycle variants, `↑`/`↓` to move rows, Enter to confirm). `←`/`→` cycling is already required in step 3; extend it to any row/option selection.
- **Browser storage/history/location APIs are unavailable.** The review iframe is srcdoc with `sandbox="allow-scripts"` (no same-origin): `localStorage`/`sessionStorage` reads and writes throw, `history.replaceState`/`pushState` throw, `location.search` is always empty. Keep switch state in memory (§3); never rely on these APIs.
- **Tell the reviewer how to operate.** Add a short note to the top-of-file HTML comment: 拖选文字即批注；toolstrip 切换 pinpoint 模式点元素批注；重提后自动显示与上一版的 diff。
- **Self-check before submitting**: (1) every select/switch works from the keyboard; (2) the script contains no `localStorage` / `history.replaceState` / `location.search` usage; (3) a fresh open starts on the variant the last feedback referred to (or the first variant).

### 5. Review loop (Plannotator)

Immediately after writing the file, call:

```
plannotator_auto_submit_review({ path: ".pi/html/<repo>/YYYY-MM-DD-<slug>.html" })
```

This opens the Plannotator annotate UI in the browser (one-shot session) and waits for the decision. Then:

- **Feedback arrives** (`annotated`) → the pending gate stays locked. Revise the HTML file (sync the `pn-review-variant` meta to the variant the feedback referred to), then re-submit:
  ```
  plannotator_auto_submit_review({ path: "..." })
  ```
  The new session opens with a **version diff** vs the previous submission, so the reviewer sees exactly what changed.
- **Keep iterating** until the reviewer clicks **Approve** (`approved`) — the pending target settles and the review is complete.
- If the reviewer closes the tab without deciding (`dismissed`), the gate releases without settling; the next write to the file re-queues the review.
- If the review cannot open (CLI unavailable), report the error and don't force another round.

### 6. Capture the answer and keep the prototype

Once a variant has won (or the user says the prototype has answered its question), write down **which one and why**, following the guidance in [SKILL.md](SKILL.md#when-done):

- The interesting feedback is usually **"I want the header from B with the sidebar from C"** — that's the actual design they want. Record the combination.
- Record the verdict in the relevant plan/spec/ADR as usual.

**Keep the prototype file** in `.pi/html/<repo>/` — the user may want to reopen it for comparison. If you modify it again in a later session, the review gate will re-queue it; that's expected and fine (the user can end it immediately).

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much markup between variants.** A shared header block is fine; a shared layout defeats the point.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub — the question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints (no tests, minimal error handling). Rewrite it properly when you fold it in.
- **Leaving the dev server requirement behind.** This flow needs no dev server and no framework router — don't reintroduce `?variant=` route params, `router.replace`, or framework-specific switchers.
