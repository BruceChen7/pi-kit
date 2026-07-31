/**
 * Pre-submit Mermaid syntax validation for plan/spec/issue markdown.
 *
 * Scans every mermaid fenced block in the document and validates each one
 * against the real mermaid parser. Fence-structure problems (unclosed /
 * empty fences) and parse failures are all collected and reported together
 * (with file line anchors + block-internal line + diagram type + type
 * advice) so the agent can fix everything in one pass.
 *
 * Architecture: Functional Core, Imperative Shell.
 *   - scanMermaidBlocks / validatePlanMermaidBlocks / formatPlanMermaidErrors
 *     are the **pure core** (value in / value out, parser injected).
 *   - runPlanMermaidValidation is the **thin shell**: acquires + configures
 *     the mermaid dependency and degrades gracefully (skip + reason) when
 *     the runtime cannot be loaded — it must never block the review gate.
 *     Unexpected errors from the core itself are NOT swallowed: they
 *     propagate so real bugs surface instead of silently skipping.
 */

import {
  detectDiagramType,
  getTypeAdviceForDiagram,
} from "../shared/mermaid-normalize.ts";
import {
  extractMermaidErrorLine,
  formatMermaidError,
  getMermaidParser,
  type MermaidParser,
} from "../shared/mermaid-runtime.ts";

export type MermaidBlock = {
  /** 1-based line number of the opening fence in the markdown document. */
  startLine: number;
  body: string;
  diagramType?: string;
};

export type PlanMermaidError = {
  /** 1-based line number of the opening fence in the markdown document. */
  startLine: number;
  /** Absolute 1-based file line the parser's caret points at (if known). */
  errorLine?: number;
  diagramType?: string;
  message: string;
};

export type MermaidBlockScan = {
  /** Well-formed mermaid blocks (fences paired, body non-empty). */
  blocks: MermaidBlock[];
  /** Fence-structure problems (unclosed / empty fences), with file lines. */
  fenceErrors: PlanMermaidError[];
};

export type PlanMermaidValidationResult =
  | { skipped: true; reason: string; errors: [] }
  | { skipped: false; errors: PlanMermaidError[] };

/* ------------------------------------------------------------------ */
/*  Pure core                                                          */
/* ------------------------------------------------------------------ */

/**
 * Scan a markdown document for mermaid fenced blocks.
 *
 * Self-contained: in addition to extracting well-formed blocks, it reports
 * unclosed and empty fences as fence errors — callers do not need a
 * separate structural pre-check.
 */
export function scanMermaidBlocks(markdown: string): MermaidBlockScan {
  const lines = markdown.split(/\r?\n/u);
  const blocks: MermaidBlock[] = [];
  const fenceErrors: PlanMermaidError[] = [];

  let i = 0;
  while (i < lines.length) {
    const open = lines[i]?.match(/^\s*```\s*mermaid\b/i);
    if (!open) {
      i += 1;
      continue;
    }

    const startLine = i + 1;
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/u.test(lines[j] ?? "")) {
      j += 1;
    }
    if (j >= lines.length) {
      fenceErrors.push({
        startLine,
        message: "mermaid 围栏未闭合（缺少闭合围栏）。",
      });
      i += 1;
      continue;
    }

    const body = lines.slice(i + 1, j).join("\n");
    if (!body.trim()) {
      fenceErrors.push({
        startLine,
        message: "mermaid 围栏内容为空。",
      });
      i = j + 1;
      continue;
    }

    blocks.push({
      startLine,
      body,
      diagramType: detectDiagramType(body),
    });
    i = j + 1;
  }

  return { blocks, fenceErrors };
}

/**
 * Count leading YAML frontmatter lines (`---` … `---`) in a mermaid body.
 *
 * Mermaid strips a well-formed leading frontmatter block before parsing, and
 * its "Parse error on line N" is relative to the stripped code — so absolute
 * file lines must add back the number of stripped frontmatter lines. Returns
 * 0 when there is no frontmatter or it is not closed (mermaid then reports no
 * line number for such bodies, so nothing needs compensating).
 */
export function countLeadingFrontmatterLines(body: string): number {
  const lines = body.split(/\r?\n/u);
  if ((lines[0]?.trim() ?? "") !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i]?.trim() ?? "") === "---") return i + 1;
  }
  return 0;
}

/**
 * Validate every mermaid block against the injected parser.
 *
 * Pure core: no IO, no configuration — the caller is responsible for
 * initializing the parser. Returns fence-structure errors AND all parse
 * failures (no fail-fast). Block-internal parse error lines are mapped to
 * absolute file lines using the fence start line (the body begins on
 * `startLine + 1`, so body line N is file line `startLine + N`), plus any
 * frontmatter lines mermaid strips before parsing.
 */
export async function validatePlanMermaidBlocks(
  markdown: string,
  parser: MermaidParser,
): Promise<PlanMermaidError[]> {
  const { blocks, fenceErrors } = scanMermaidBlocks(markdown);
  const errors: PlanMermaidError[] = [...fenceErrors];
  if (blocks.length === 0) {
    return errors;
  }

  for (const block of blocks) {
    try {
      await parser.parse(block.body);
    } catch (error) {
      const blockErrorLine = extractMermaidErrorLine(error);
      errors.push({
        startLine: block.startLine,
        errorLine:
          blockErrorLine !== undefined
            ? block.startLine +
              countLeadingFrontmatterLines(block.body) +
              blockErrorLine
            : undefined,
        diagramType: block.diagramType,
        message: formatMermaidError(error),
      });
    }
  }

  return errors;
}

/** Format collected errors into an agent-readable message. */
export function formatPlanMermaidErrors(errors: PlanMermaidError[]): string {
  const lines = [
    `Mermaid 语法校验失败：${errors.length} 个 diagram 未通过解析。请修正后重新提交。`,
  ];

  for (const error of errors) {
    const location = error.errorLine ?? error.startLine;
    const type = error.diagramType ? `（类型: ${error.diagramType}）` : "";
    lines.push(`- 文件第 ${location} 行${type}: ${error.message}`);

    const advice = getTypeAdviceForDiagram(error.diagramType);
    if (advice) {
      for (const tip of advice) {
        lines.push(`  · ${tip}`);
      }
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Thin shell                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run mermaid validation on a markdown document.
 *
 * Degrades gracefully: if the mermaid runtime cannot be loaded or
 * configured (missing dependency, DOM shim failure, …), returns
 * { skipped: true, reason } so the caller can proceed with the review gate
 * and surface the reason. Only dependency acquisition/config is covered by
 * the degrade path — errors from the validation core propagate.
 */
export async function runPlanMermaidValidation(
  markdown: string,
  parserProvider: () => Promise<MermaidParser> = getMermaidParser,
): Promise<PlanMermaidValidationResult> {
  let parser: MermaidParser;
  try {
    parser = await parserProvider();
    parser.initialize({ startOnLoad: false, securityLevel: "loose" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { skipped: true, reason, errors: [] };
  }
  return {
    skipped: false,
    errors: await validatePlanMermaidBlocks(markdown, parser),
  };
}
