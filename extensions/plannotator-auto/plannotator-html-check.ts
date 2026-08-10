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
    | "review-hint-missing";
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

function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => m[1] ?? "",
  );
}

function scriptText(html: string): string {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1] ?? "")
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
