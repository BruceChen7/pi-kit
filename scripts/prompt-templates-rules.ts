/**
 * Prompt 模板 frontmatter 的守卫规则（Functional Core）。
 *
 * pi 用真正的 YAML 解析器读 `prompts/*.md` 的 frontmatter：块标量 `>-` 的正文必须
 * 换行后缩进，`key: >- text` 这种写法直接解析失败，整个模板会被丢掉。反过来，
 * frontmatter 被改写成 markdown 标题时 YAML 不报错，但 description 变成空字符串，
 * 模板会静默失联（斜杠命令还在，描述没了）。
 *
 * 这两种形态都被一次「顺手格式化」真实造成过，所以这里只留最小规则集，不做 YAML 校验器。
 */

import { parseFrontmatter } from "../extensions/shared/frontmatter.ts";

export interface PromptDoc {
  /** repo 相对路径，用于 fail 时定位。 */
  path: string;
  text: string;
}

export interface PromptFinding {
  path: string;
  rule: string;
  detail: string;
}

/** `key: >-` 后面跟正文，块标量头必须独占一行。 */
const INLINE_BLOCK_SCALAR = /^[A-Za-z][\w-]*:[ \t]*[|>][-+]?[ \t]+\S/m;

/** frontmatter 键被改写成标题，例如 `## description: ...`。 */
const METADATA_AS_HEADING = /^#{1,6}[ \t]+(?:description|argument-hint):/m;

export const findPromptFrontmatterProblems = (
  docs: readonly PromptDoc[],
): PromptFinding[] =>
  docs.flatMap((doc) => {
    const findings: PromptFinding[] = [];
    const push = (rule: string, detail: string) =>
      findings.push({ path: doc.path, rule, detail });

    if (INLINE_BLOCK_SCALAR.test(doc.text)) {
      push(
        "block-scalar-inline",
        "block scalar header shares its line with content; YAML drops the whole template",
      );
    }

    if (METADATA_AS_HEADING.test(doc.text)) {
      push(
        "metadata-as-heading",
        "frontmatter key rendered as a markdown heading; description ends up empty",
      );
    }

    const { description } = parseFrontmatter(doc.text, "");
    if (!description) {
      push(
        "description-missing",
        "no non-empty description in the frontmatter block",
      );
    }

    return findings;
  });
