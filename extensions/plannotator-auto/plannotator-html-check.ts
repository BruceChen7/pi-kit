/**
 * Static Plannotator-annotate compliance check for generated HTML artifacts.
 *
 * Plannotator renders the artifact in a sandboxed srcdoc iframe with
 * `sandbox="allow-scripts"` (no allow-same-origin). Two consequences the
 * artifact author must respect:
 *
 * 1. Browser storage/history/location APIs are unavailable: `localStorage`
 *    and `sessionStorage` reads/writes throw SecurityError,
 *    `history.replaceState`/`pushState` throw, and `location.search` is
 *    always empty. A variant switcher that persists state through these APIs
 *    crashes (or silently misbehaves) on the first interaction.
 * 2. In drag mode (the default) plain clicks pass through, so custom
 *    interactive controls need no marking — unlike Lavish's annotate mode.
 *    Only pinpoint mode intercepts clicks (that is its purpose), which is
 *    why keyboard fallbacks remain the only hard interactivity requirement.
 *
 * This module statically checks an artifact against those rules so the
 * submit path can block broken files before opening the review UI. Rules:
 *
 * - R1 `sandbox-storage-unsafe` (error for prototypes, warning otherwise):
 *   the script uses localStorage / sessionStorage / history.replaceState /
 *   history.pushState / location.search, which are unusable inside the
 *   review sandbox. Fix: keep switch state in a plain module variable, and
 *   optionally persist the reviewed variant via a `<meta
 *   name="pn-review-variant" content="A">` tag that the agent updates on
 *   revision.
 * - R2 `keyboard-fallback-missing` (warning): custom interactive controls
 *   exist (cursor:pointer on non-native elements) but the script has no
 *   ArrowLeft/ArrowRight keydown handling, so pinpoint-mode reviews have no
 *   way to operate them.
 * - R3 `review-hint-missing` (warning, prototypes only): the top-of-file
 *   comment does not mention the review controls (drag-select = annotate,
 *   toolstrip input-method switch, resubmit shows a version diff).
 * - R4 `script-absent-or-empty` (error/warning): the artifact declares
 *   `<script>` tags but ships no executable JS (all inline blocks empty and
 *   no src), or interactive controls exist with no script at all — the
 *   review surface would be a blank page. Empty blocks alongside valid
 *   scripts downgrade to a warning.
 * - R5 `script-before-dom-ready` (error): an inline script placed before
 *   `<body>` (or before the `#app` root) touches the DOM (getElementById /
 *   querySelector / mount) without waiting for DOMContentLoaded — it runs
 *   before the body exists, `getElementById("app")` returns null, and the
 *   mount fails → blank page.
 * - R6 `error-visibility-missing` (warning): an app-like script (mount /
 *   getElementById / $state) has no window.onerror fallback. The review
 *   sandbox (srcdoc iframe) swallows console output, so runtime errors
 *   render as a blank page with no clue; a fallback that paints the error
 *   into the page turns black-screen debugging into visible feedback.
 *
 * The check is pure (string in, issues out); the shell decides what to do
 * via `decidePlannotatorHtmlGate` (errors block the submission, warnings
 * only annotate the result).
 *
 * Static limitations (accepted): elements/APIs created at runtime (names
 * only inside JS strings) are not detected; the storage/keyboard/hint
 * checks are regex presence checks, not full JS analysis.
 */

export type PlannotatorHtmlIssueSeverity = "error" | "warning";

export interface PlannotatorHtmlIssue {
  rule:
    | "sandbox-storage-unsafe"
    | "keyboard-fallback-missing"
    | "review-hint-missing"
    | "script-absent-or-empty"
    | "script-before-dom-ready"
    | "error-visibility-missing";
  severity: PlannotatorHtmlIssueSeverity;
  message: string;
}

/** Tags Lavish lets clicks through to natively; no marking needed. */
const NATIVE_INTERACTIVE_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "a",
  "label",
  "summary",
  "option",
  "optgroup",
  "details",
  "output",
  "menu",
  "progress",
  "meter",
]);

interface PointerRule {
  /** First tag name in the selector ("" when it starts with . # : etc). */
  tag: string;
  classes: string[];
  ids: string[];
}

const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const CLASS_RE = /\.([\w-]+)/g;
const ID_RE = /#([\w-]+)/g;
const TAG_RE = /^([a-zA-Z][\w-]*)/;

/** Extract CSS rules whose declarations set `cursor: pointer`. */
function extractPointerRules(css: string): PointerRule[] {
  const rules: PointerRule[] = [];
  for (const match of css.matchAll(CSS_RULE_RE)) {
    const decls = match[2] ?? "";
    if (!/cursor\s*:\s*pointer/i.test(decls)) continue;
    for (const rawSelector of (match[1] ?? "").split(",")) {
      const selector = rawSelector.trim();
      if (!selector) continue;
      // Only the last compound segment is the interactive target itself;
      // leading parts (#vA .row, .col .row) are scoping ancestors and must
      // not be collected as pointer classes/ids (false positives).
      const parts = selector.split(/\s+[>+~]\s*|\s+/).filter(Boolean);
      const last = parts[parts.length - 1] ?? "";
      const tagMatch = TAG_RE.exec(last);
      const tag = tagMatch ? tagMatch[1].toLowerCase() : "";
      if (NATIVE_INTERACTIVE_TAGS.has(tag)) continue;
      const classes = [...last.matchAll(CLASS_RE)].map((x) => x[1]);
      const ids = [...last.matchAll(ID_RE)].map((x) => x[1]);
      rules.push({ tag, classes, ids });
    }
  }
  return rules;
}

const PROTOTYPE_MARKER_RE =
  /data-variant\s*=|variant\s*=|id\s*=\s*["']switcher|class\s*=\s*["'][^"']*switcher/i;
const KEYDOWN_RE = /\bkeydown\b/i;
const ARROW_LEFT_RE = /ArrowLeft/;
const ARROW_RIGHT_RE = /ArrowRight/;
const REVIEW_HINT_RE = /批注|annotate|拖选|drag\b|pinpoint/i;

/** One `<script>` element of the document. */
interface ScriptBlock {
  /** Full opening tag (`<script ...>`) — used for src/position checks. */
  tag: string;
  /** Inline content ("" for src-only or empty blocks). */
  content: string;
  /** Whether the tag declares a `src` attribute (external script). */
  hasSrc: boolean;
  /** Index of the opening tag in the html string. */
  index: number;
}

/**
 * Extract every script element. The content regex is non-greedy up to the
 * first `</script>` — the same behavior browsers/parse5 use, so static
 * results match what the review surface would parse.
 */
function scriptBlocks(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    blocks.push({
      tag,
      content: match[1] ?? "",
      hasSrc: /\bsrc\s*=/.test(tag),
      index: match.index ?? 0,
    });
  }
  return blocks;
}

function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => m[1] ?? "",
  );
}

function scriptText(html: string): string {
  return scriptBlocks(html)
    .map((b) => b.content)
    .join("\n");
}

/**
 * R1 — browser storage/history/location APIs that are unusable inside the
 * Plannotator review sandbox (srcdoc + `sandbox="allow-scripts"`, opaque
 * origin). `localStorage`/`sessionStorage` accesses throw SecurityError,
 * `history.replaceState`/`pushState` throw for about:srcdoc, and
 * `location.search` is always empty (silent misbehavior).
 */
const STORAGE_API_RES = [
  { name: "localStorage", re: /\blocalStorage\b/ },
  { name: "sessionStorage", re: /\bsessionStorage\b/ },
  {
    name: "history.replaceState/pushState",
    re: /\bhistory\s*\.\s*(?:replaceState|pushState)\s*\(/,
  },
  {
    name: "location.search/location.hash",
    re: /\blocation\s*\.\s*(?:search|hash)\b/,
  },
];

function findUnsafeStorageApis(script: string): string[] {
  const found: string[] = [];
  for (const { name, re } of STORAGE_API_RES) {
    if (re.test(script)) found.push(name);
  }
  return found;
}

/** Main entry: returns all compliance issues for an HTML document. */
export function checkPlannotatorHtmlCompliance(
  html: string,
): PlannotatorHtmlIssue[] {
  const issues: PlannotatorHtmlIssue[] = [];
  const isPrototype = PROTOTYPE_MARKER_RE.test(html);
  const script = scriptText(html);

  // R1 — sandbox storage/history/location constraints.
  const unsafeApis = findUnsafeStorageApis(script);
  if (unsafeApis.length > 0) {
    issues.push({
      rule: "sandbox-storage-unsafe",
      severity: isPrototype ? "error" : "warning",
      message:
        `script 中使用了评审沙箱内不可用的浏览器 API: ${unsafeApis.join("、")}。` +
        `Plannotator 评审面是 srcdoc + sandbox="allow-scripts"（无 allow-same-origin）:` +
        `localStorage/sessionStorage 读写会抛 SecurityError,history.replaceState/pushState 抛错,` +
        `location.search 恒为空（静默失效）。修改:切换/持久化状态改为模块级内存变量;` +
        `如需跨评审会话记住当前变体,在 <head> 放 <meta name="pn-review-variant" content="A|B|C"> ` +
        `并在每次修订时同步为反馈指向的变体（评审面可读 DOM,不可写浏览器存储）。`,
    });
  }

  // R2 — keyboard fallback for custom interactive controls.
  const pointerRules = styleBlocks(html).flatMap(extractPointerRules);
  const hasCustomControls = pointerRules.length > 0;
  const hasKeydown = KEYDOWN_RE.test(script);
  const hasArrows = ARROW_LEFT_RE.test(script) && ARROW_RIGHT_RE.test(script);
  if (hasCustomControls && !(hasKeydown && hasArrows)) {
    issues.push({
      rule: "keyboard-fallback-missing",
      severity: "warning",
      message:
        `存在自定义交互控件(cursor:pointer)但未检测到 ←/→ 键盘等效操作。` +
        `Plannotator 的 drag 模式（默认）点击会放行,但评审者切到 pinpoint 模式点元素批注时` +
        `点击会被拦截,交互控件只能靠键盘操作。建议在 script 中加 keydown 监听处理 ` +
        `ArrowLeft/ArrowRight（输入框聚焦时跳过）。`,
    });
  }

  // R3 — review hint for prototypes.
  if (isPrototype) {
    const bodyIndex = html.search(/<body/i);
    const head = html.slice(0, bodyIndex === -1 ? html.length : bodyIndex);
    if (!REVIEW_HINT_RE.test(head)) {
      issues.push({
        rule: "review-hint-missing",
        severity: "warning",
        message:
          `文件头注释未说明评审操作。建议在顶部 HTML 注释中写明:拖选文字即批注、` +
          `toolstrip 切换 pinpoint 模式点元素批注、重提后自动显示与上一版的 diff 高亮。`,
      });
    }
  }

  // R4 — script absent or empty: the artifact declares scripts but ships no
  // executable JS (all inline blocks empty, no src). The review surface
  // would be a blank page for any interactive artifact.
  const blocks = scriptBlocks(html);
  const inlineTotal = blocks.reduce((n, b) => n + b.content.length, 0);
  const hasSrcScript = blocks.some((b) => b.hasSrc);
  const hasEmptyInlineBlock = blocks.some(
    (b) => !b.hasSrc && b.content.trim().length === 0,
  );
  if (blocks.length > 0 && inlineTotal === 0 && !hasSrcScript) {
    issues.push({
      rule: "script-absent-or-empty",
      severity: "error",
      message:
        `检测到 HTML 声明了 <script> 但没有任何可执行 JS:所有内联脚本内容为空且无 src 脚本。` +
        `评审面将是一片黑屏(无 JS 可执行)。常见原因:内联脚本时用非贪婪正则匹配了自闭合的 ` +
        `<script src=...></script>（捕获到空内容）。修复:按 src 属性读取对应文件内容再内联;` +
        `提交前验证脚本内容长度 > 0。排障:黑屏先查自己生成的工件文件——script 内容是否为空、` +
        `位置是否在 #app 之后、是否 DOM 就绪。`,
    });
  } else if (pointerRules.length > 0 && blocks.length === 0) {
    issues.push({
      rule: "script-absent-or-empty",
      severity: "error",
      message:
        `检测到自定义交互控件(cursor:pointer)但页面没有任何 <script>:交互 UI 无 JS 驱动,` +
        `评审面将是一片黑屏/无响应。修复:为交互控件添加脚本（或移除控件）。`,
    });
  } else if (hasEmptyInlineBlock && (hasSrcScript || inlineTotal > 0)) {
    issues.push({
      rule: "script-absent-or-empty",
      severity: "warning",
      message:
        `检测到空的 <script></script> 块（无内容且无 src），但页面存在其他有效脚本。` +
        `空块通常是内联/构建残留，建议删除或确认其用途。`,
    });
  }

  // R5 — script runs before the DOM is ready: an inline script placed
  // before <body> (or before the #app root) touches the DOM without waiting
  // for DOMContentLoaded. It runs before the body exists,
  // getElementById("app") returns null, and the mount fails → blank page.
  const DOM_ACCESS_RE =
    /\bgetElementById\b|\bquerySelector(?:All)?\s*\(|\bmount\s*\(/;
  const DOM_READY_RE = /\bDOMContentLoaded\b/;
  const bodyIndex = html.search(/<body\b/i);
  const appIndex = html.search(/<div\b[^>]*\bid\s*=\s*["']app["']/i);
  for (const b of blocks) {
    if (b.hasSrc) continue;
    const beforeBody = bodyIndex !== -1 && b.index < bodyIndex;
    const beforeApp = appIndex !== -1 && b.index < appIndex;
    if (
      (beforeBody || beforeApp) &&
      DOM_ACCESS_RE.test(b.content) &&
      !DOM_READY_RE.test(b.content)
    ) {
      issues.push({
        rule: "script-before-dom-ready",
        severity: "error",
        message:
          `检测到脚本在 DOM 就绪前执行:内联脚本位于 <head>（或 #app 之前）且未监听 ` +
          `DOMContentLoaded，却在脚本中访问 DOM(getElementById/querySelector/mount)。` +
          `此时 body 尚未解析,getElementById("app") 返回 null,mount 失败 → 评审面黑屏。` +
          `修复:把脚本放到 body 末尾（#app 之后），或包在 DOMContentLoaded 回调里。`,
      });
      break;
    }
  }

  // R6 — error visibility: the review sandbox (srcdoc iframe) swallows
  // console output, so a runtime error renders as a blank page with no
  // clue. App-like scripts should install a window.onerror fallback that
  // paints the error into the page.
  const APP_SCRIPT_RE = /\bmount\s*\(|\bgetElementById\b|\$state\b/;
  const ERROR_VISIBILITY_RE =
    /\bonerror\b|addEventListener\s*\(\s*["']error["']/;
  if (APP_SCRIPT_RE.test(script) && !ERROR_VISIBILITY_RE.test(script)) {
    issues.push({
      rule: "error-visibility-missing",
      severity: "warning",
      message:
        `检测到应用脚本（mount/getElementById/$state）但未安装错误可见 fallback。` +
        `评审沙箱是 srcdoc iframe,console 输出不可见:运行时错误会表现为黑屏且无任何线索。` +
        `建议在脚本开头安装 window.onerror:把错误文本渲染到页面（如写入 #app/body）,` +
        `这样评审面显示错误信息而非黑屏。`,
    });
  }

  return issues;
}

/**
 * Gate decision for the submit/manual-review shells: which severity gets
 * which outcome. Errors block the submission entirely; warnings only
 * annotate the result. The shells dispatch on `kind` and do the IO — they
 * never re-derive the severity rules. `issues` always carries the full list
 * so blocked messages can also list warnings as suggested fixes.
 */
export type PlannotatorGateDecision =
  | { kind: "pass" }
  | { kind: "block"; issues: PlannotatorHtmlIssue[] }
  | { kind: "warn"; issues: PlannotatorHtmlIssue[] };

export const decidePlannotatorHtmlGate = (
  issues: PlannotatorHtmlIssue[],
): PlannotatorGateDecision => {
  if (issues.some((issue) => issue.severity === "error")) {
    return { kind: "block", issues };
  }
  if (issues.length > 0) {
    return { kind: "warn", issues };
  }
  return { kind: "pass" };
};

/** Format issues into an actionable Chinese message for the agent. */
export function formatPlannotatorHtmlIssues(
  issues: PlannotatorHtmlIssue[],
  options: { blocked: boolean; planFile: string },
): string {
  const blockedIssues = issues.filter((issue) => issue.severity === "error");
  const warningIssues = issues.filter((issue) => issue.severity === "warning");
  const lines: string[] = [];
  if (options.blocked) {
    lines.push(
      `[PLANNOTATOR HTML 合规检查未通过] 提交被拦截,请先修改 ${options.planFile} 再重新提交:` +
        `(评审沙箱内 localStorage/history/location 等 API 不可用,工件的交互脚本会崩溃或静默失效)`,
    );
    for (const issue of blockedIssues) {
      lines.push(`- [${issue.rule}] ${issue.message}`);
    }
    if (warningIssues.length > 0) {
      lines.push("建议同时修复:");
      for (const issue of warningIssues) {
        lines.push(`- [${issue.rule}] ${issue.message}`);
      }
    }
  } else {
    lines.push(
      `[PLANNOTATOR HTML 合规提示(不阻塞提交,建议修复)] ${options.planFile}:`,
    );
    for (const issue of warningIssues) {
      lines.push(`- [${issue.rule}] ${issue.message}`);
    }
  }
  return lines.join("\n");
}
