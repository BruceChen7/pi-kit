/**
 * diagram-core — 图表能力的纯函数核（Functional Core） + 一次注入式解析校验。
 *
 * 两条能力：
 * - 校验：复用 `shared/mermaid-runtime`（linkedom shim + 真 parser，无 Chrome），
 *   以及 `shared/mermaid-normalize` 的类型判断与修正建议。
 * - 渲染：**条件能力**——只有机器上存在 `mmdc` 时才出 PNG。core 只负责
 *   "能力判定 / 参数拼装 / 结果映射"，真正的子进程调用在 shell。
 *
 * SVG 一期不做：校验层对 SVG 毫无能力，产出等于无自检，已写进 plan 的 Non-goals。
 */

import {
  detectDiagramType,
  getTypeAdviceForDiagram,
} from "../shared/mermaid-normalize.ts";
import {
  extractMermaidErrorLine,
  formatMermaidError,
  type MermaidParser,
} from "../shared/mermaid-runtime.ts";

export type MermaidRenderCapability =
  | { render: true }
  | { render: false; reason: "mmdc-not-found" };

/** 把"探测结果"映射成能力：缺 mmdc 时静默降级，不报错、不安装。 */
export const detectRenderCapability = (
  hasMmdc: boolean,
): MermaidRenderCapability =>
  hasMmdc ? { render: true } : { render: false, reason: "mmdc-not-found" };

export type MermaidValidationFailure = {
  ok: false;
  errors: string[];
  diagramType?: string;
};

export type MermaidValidationSuccess = { ok: true; diagramType?: string };

export type MermaidValidation =
  | MermaidValidationSuccess
  | MermaidValidationFailure;

/** 从 markdown 文本里取 mermaid 围栏内容（未闭合的围栏也会被取出并报错）。 */
export const extractMermaidBlocks = (
  markdown: string,
): { source: string; index: number }[] => {
  const blocks: { source: string; index: number }[] = [];
  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (start === -1 && /^\s*```\s*mermaid\b/i.test(line)) {
      start = i;
      continue;
    }
    if (start !== -1 && /^\s*```\s*$/.test(line)) {
      blocks.push({
        source: lines.slice(start + 1, i).join("\n"),
        index: blocks.length,
      });
      start = -1;
    }
  }
  if (start !== -1) {
    blocks.push({
      source: lines.slice(start + 1).join("\n"),
      index: blocks.length,
    });
  }
  return blocks;
};

/** 单个 mermaid 源：用真 parser 校验，失败时给出类型相关的修正建议。 */
export const validateMermaidSource = async (
  source: string,
  parser: MermaidParser,
): Promise<MermaidValidation> => {
  const body = source.trim();
  const diagramType = detectDiagramType(body);
  if (body.length === 0) {
    return { ok: false, errors: ["mermaid source is empty"], diagramType };
  }
  try {
    await parser.parse(body);
    return { ok: true, diagramType };
  } catch (error) {
    const errors = [formatMermaidError(error)];
    const errorLine = extractMermaidErrorLine(error);
    if (typeof errorLine === "number") {
      errors.push(`parse error near line ${errorLine}`);
    }
    const advice = getTypeAdviceForDiagram(diagramType);
    if (advice && advice.length > 0) {
      errors.push(`hints for ${diagramType ?? "this diagram type"}:`);
      errors.push(...advice);
    }
    return { ok: false, errors, diagramType };
  }
};

/** 校验一段 mermaid 源，或一段含 mermaid 围栏的 markdown。 */
export const validateMermaidInput = async (
  input: string,
  parser: MermaidParser,
): Promise<{ results: MermaidValidation[]; fromFences: boolean }> => {
  const blocks = extractMermaidBlocks(input).filter((block) =>
    block.source.trim(),
  );
  if (blocks.length === 0) {
    return {
      results: [await validateMermaidSource(input, parser)],
      fromFences: false,
    };
  }
  const results: MermaidValidation[] = [];
  for (const block of blocks) {
    results.push(await validateMermaidSource(block.source, parser));
  }
  return { results, fromFences: true };
};

/** mmdc 的命令行参数（纯拼装，便于测试与替换）。 */
export const renderArgs = (input: {
  inputPath: string;
  outputPath: string;
}): string[] => ["-i", input.inputPath, "-o", input.outputPath];
