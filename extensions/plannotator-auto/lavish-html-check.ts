/**
 * Static Lavish-annotate compliance check for generated HTML artifacts.
 *
 * Lavish's annotate mode (default ON) intercepts clicks and text drags on any
 * element that is not `data-lavish-ui`, `data-lavish-action`, or a native
 * interactive control. Custom interactive controls (plain div/span + onclick +
 * `cursor:pointer`) that are not marked therefore become unoperable for the
 * reviewer: every click pops the annotation card instead of running the
 * artifact's own handler.
 *
 * This module statically checks an artifact against the documented contract
 * (see skills/prototype/UI.md "Interactive controls (Lavish annotate mode)")
 * so the submit path can block non-compliant files before opening Lavish.
 *
 * Rules:
 * - R1 `interactive-control-unmarked` (error): a custom (non-native) element
 *   with `cursor:pointer` (from CSS class/id/tag rules or inline style) that
 *   is not itself marked `data-lavish-action` and has no marked ancestor.
 * - R2 `keyboard-fallback-missing` (error for variant-switcher prototypes,
 *   warning otherwise): custom interactive controls exist but the script has
 *   no ArrowLeft/ArrowRight keydown handling, so annotate mode leaves no way
 *   to operate the prototype.
 * - R3 `review-hint-missing` (warning, prototypes only): the top-of-file
 *   comment does not mention the review controls (⌘I toggle, drag = annotate).
 *
 * Static limitations (accepted): elements created at runtime (class names only
 * inside JS strings) are not detected; the keyboard/hint checks are regex
 * presence checks, not full JS analysis.
 */

export type LavishHtmlIssueSeverity = "error" | "warning";

export interface LavishHtmlIssue {
  rule:
    | "interactive-control-unmarked"
    | "keyboard-fallback-missing"
    | "review-hint-missing";
  severity: LavishHtmlIssueSeverity;
  message: string;
}

/** Tags Lavish lets clicks through to natively; no marking needed. */
export const NATIVE_INTERACTIVE_TAGS = new Set([
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

export interface PointerRule {
  /** Original selector text, e.g. `#switcher .arrow`. */
  selector: string;
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
export function extractPointerRules(css: string): PointerRule[] {
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
      rules.push({ selector, tag, classes, ids });
    }
  }
  return rules;
}

export interface ScannedElement {
  tag: string;
  classes: string[];
  id: string;
  /** True when the element itself or any open ancestor has data-lavish-action. */
  marked: boolean;
  /** True when the element has an inline style with cursor: pointer. */
  inlinePointer: boolean;
}

const SKIP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "svg",
  "template",
  "textarea",
]);
const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "meta",
  "link",
  "input",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "track",
  "wbr",
]);

const ATTR_CLASS_RE = /class\s*=\s*["']([^"']*)["']/i;
const ATTR_ID_RE = /id\s*=\s*["']([^"']*)["']/i;
const ATTR_STYLE_RE = /style\s*=\s*["']([^"']*)["']/i;

/**
 * Lightweight HTML tokenizer: scans tags outside script/style/svg/template/
 * textarea content, tracks a tag stack with cumulative data-lavish-action
 * marking, and returns every scanned element.
 */
export function tokenizeElements(html: string): ScannedElement[] {
  const elements: ScannedElement[] = [];
  const stack: Array<{ tag: string; marked: boolean }> = [];
  let index = 0;
  const len = html.length;
  while (index < len) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? len : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);
    index = gt + 1;

    if (raw.startsWith("/")) {
      const name = /^([\w-]+)/.exec(raw.slice(1))?.[1]?.toLowerCase();
      if (name && stack.length > 0 && stack[stack.length - 1].tag === name) {
        stack.pop();
      }
      continue;
    }
    if (raw.startsWith("!")) continue;

    const name = /^([\w-]+)/.exec(raw)?.[1]?.toLowerCase();
    if (!name) continue;

    if (SKIP_CONTENT_TAGS.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, gt);
      if (close === -1) {
        index = len;
      } else {
        const closeGt = html.indexOf(">", close);
        index = closeGt === -1 ? len : closeGt + 1;
      }
      continue;
    }

    const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(name);
    const markedNow = /data-lavish-action/.test(raw);
    const classAttr = ATTR_CLASS_RE.exec(raw);
    const idAttr = ATTR_ID_RE.exec(raw);
    const styleAttr = ATTR_STYLE_RE.exec(raw);
    elements.push({
      tag: name,
      classes: classAttr ? classAttr[1].split(/\s+/).filter(Boolean) : [],
      id: idAttr ? idAttr[1] : "",
      marked: markedNow || stack.some((entry) => entry.marked),
      inlinePointer: styleAttr
        ? /cursor\s*:\s*pointer/i.test(styleAttr[1])
        : false,
    });
    if (!selfClosing) stack.push({ tag: name, marked: markedNow });
  }
  return elements;
}

const PROTOTYPE_MARKER_RE =
  /data-variant\s*=|variant\s*=|id\s*=\s*["']switcher|class\s*=\s*["'][^"']*switcher/i;
const KEYDOWN_RE = /\bkeydown\b/i;
const ARROW_LEFT_RE = /ArrowLeft/;
const ARROW_RIGHT_RE = /ArrowRight/;
const REVIEW_HINT_RE = /⌘I|Ctrl\s*\+\s*I|annotate|批注|浏览模式/i;

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

function describeElement(el: ScannedElement): string {
  if (el.id) return `#${el.id}`;
  if (el.classes.length > 0) return `.${el.classes.join(".")}`;
  return `<${el.tag}>`;
}

function describeTargets(elements: ScannedElement[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const el of elements) {
    const desc = describeElement(el);
    if (seen.has(desc)) continue;
    seen.add(desc);
    parts.push(desc);
  }
  return (
    parts.slice(0, 5).join("、") +
    (parts.length > 5 ? ` 等 ${parts.length} 类` : "")
  );
}

/** Main entry: returns all compliance issues for an HTML document. */
export function checkLavishHtmlCompliance(html: string): LavishHtmlIssue[] {
  const issues: LavishHtmlIssue[] = [];

  const pointerRules = styleBlocks(html).flatMap(extractPointerRules);
  const pointerClasses = new Set(pointerRules.flatMap((rule) => rule.classes));
  const pointerIds = new Set(pointerRules.flatMap((rule) => rule.ids));
  const pointerTags = new Set(
    pointerRules
      .filter(
        (rule) =>
          rule.tag !== "" && rule.classes.length === 0 && rule.ids.length === 0,
      )
      .map((rule) => rule.tag),
  );

  const elements = tokenizeElements(html);
  const unmarked: ScannedElement[] = [];
  for (const el of elements) {
    if (NATIVE_INTERACTIVE_TAGS.has(el.tag)) continue;
    const matchesPointer =
      el.inlinePointer ||
      el.classes.some((cls) => pointerClasses.has(cls)) ||
      (el.id !== "" && pointerIds.has(el.id)) ||
      pointerTags.has(el.tag);
    if (!matchesPointer) continue;
    if (!el.marked) unmarked.push(el);
  }
  if (unmarked.length > 0) {
    issues.push({
      rule: "interactive-control-unmarked",
      severity: "error",
      message:
        `自定义交互控件 ${describeTargets(unmarked)} 设置了 cursor:pointer 但未标记 ` +
        `data-lavish-action(共 ${unmarked.length} 处)。Lavish annotate 模式下点击会被批注卡片拦截,` +
        `评审者无法操作。修改:控件或其容器加 data-lavish-action 属性(原生 button/input/a 无需标记);` +
        `若它是评审对象(需要被点击批注),交互改走键盘。`,
    });
  }

  const isPrototype = PROTOTYPE_MARKER_RE.test(html);
  const script = scriptText(html);
  const hasKeydown = KEYDOWN_RE.test(script);
  const hasArrows = ARROW_LEFT_RE.test(script) && ARROW_RIGHT_RE.test(script);
  const hasCustomControls = pointerRules.length > 0;
  if (isPrototype) {
    if (!(hasKeydown && hasArrows)) {
      issues.push({
        rule: "keyboard-fallback-missing",
        severity: "error",
        message:
          `变体切换原型未提供 ←/→ 键盘兜底(keydown 监听中缺少 ArrowLeft/ArrowRight)。` +
          `annotate 模式下点击评审对象会弹批注卡,切换方案必须键盘可达。` +
          `修改:script 中加 keydown 监听处理 ArrowLeft/ArrowRight(输入框聚焦时跳过)。`,
      });
    }
  } else if (hasCustomControls && !hasArrows) {
    issues.push({
      rule: "keyboard-fallback-missing",
      severity: "warning",
      message:
        `存在自定义交互控件(cursor:pointer)但未检测到 ←/→ 键盘等效操作。` +
        `建议提供键盘路径,否则 annotate 模式下只能靠批注交互。`,
    });
  }

  if (isPrototype) {
    const bodyIndex = html.search(/<body/i);
    const head = html.slice(0, bodyIndex === -1 ? html.length : bodyIndex);
    if (!REVIEW_HINT_RE.test(head)) {
      issues.push({
        rule: "review-hint-missing",
        severity: "warning",
        message:
          `文件头注释未说明评审操作(⌘I / Ctrl+I 切换批注/浏览模式、拖选文字即批注、←/→ 切方案)。` +
          `建议在顶部 HTML 注释中写明,评审者才知道如何操作。`,
      });
    }
  }

  return issues;
}

/** Format issues into an actionable Chinese message for the agent. */
export function formatLavishHtmlIssues(
  issues: LavishHtmlIssue[],
  options: { blocked: boolean; planFile: string },
): string {
  const blockedIssues = issues.filter((issue) => issue.severity === "error");
  const warningIssues = issues.filter((issue) => issue.severity === "warning");
  const lines: string[] = [];
  if (options.blocked) {
    lines.push(
      `[LAVISH HTML 合规检查未通过] 提交被拦截,请先修改 ${options.planFile} 再重新提交:` +
        `(Lavish annotate 模式下,未标记 data-lavish-action 的自定义交互控件无法被评审者操作)`,
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
      `[LAVISH HTML 合规提示(不阻塞提交,建议修复)] ${options.planFile}:`,
    );
    for (const issue of warningIssues) {
      lines.push(`- [${issue.rule}] ${issue.message}`);
    }
  }
  return lines.join("\n");
}
