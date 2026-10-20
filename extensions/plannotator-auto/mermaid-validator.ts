import {
  detectDiagramType,
  diagnoseSequenceDiagramIssues,
  getTypeAdviceForDiagram,
  type MermaidBlockDiagnostic,
} from "../shared/mermaid-normalize.ts";
import { formatPeleError, peleErrorLine } from "../shared/pele-error.ts";
import { getPeleParser, type PeleParser } from "../shared/pele-runtime.ts";

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
  /**
   * Line-anchored diagnostics that explain WHY the block failed, pointing at
   * the concrete offending line (the raw parser message is often cryptic and
   * its own line number can point at the line AFTER the real problem).
   */
  diagnostics?: MermaidBlockDiagnostic[];
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
 * Count leading lines that the parser strips before parsing a block body.
 *
 * Pele, like Mermaid, drops a well-formed leading YAML frontmatter block
 * (`---` … `---`) AND any blank lines directly after it (plus leading blank
 * lines when there is no frontmatter) before parsing — its "Parse error on
 * line N" is relative to the stripped code, so absolute file lines must add
 * this count back.
 *
 * Returns the number of stripped lines: 0 when there is no frontmatter and no
 * leading blank lines, 0 for an unclosed leading delimiter (the parser then
 * reports no line number for such bodies, so nothing needs compensating).
 */
export function countLeadingStrippedLines(body: string): number {
  const lines = body.split(/\r?\n/u);

  let stripped = 0;

  // Leading blank lines are stripped even without frontmatter.
  while (stripped < lines.length && !lines[stripped]?.trim()) {
    stripped += 1;
  }

  if ((lines[stripped]?.trim() ?? "") !== "---") return stripped;

  let closedAt = -1;
  for (let i = stripped + 1; i < lines.length; i += 1) {
    if ((lines[i]?.trim() ?? "") === "---") {
      closedAt = i;
      break;
    }
  }
  if (closedAt === -1) return stripped;

  stripped = closedAt + 1;

  // Blank lines directly after the frontmatter are stripped too.
  while (stripped < lines.length && !lines[stripped]?.trim()) {
    stripped += 1;
  }

  return stripped;
}

/**
 * Validate every mermaid block against the injected parser.
 *
 * Pure core: no IO, no configuration — the caller injects the parser.
 * Returns fence-structure errors AND all parse failures (no fail-fast).
 * Block-internal parse error lines are mapped to absolute file lines using
 * the fence start line (the body begins on `startLine + 1`, so body line N is
 * file line `startLine + N`), plus any frontmatter lines the parser strips.
 */
export function validatePlanMermaidBlocks(
  markdown: string,
  parser: PeleParser,
): PlanMermaidError[] {
  const { blocks, fenceErrors } = scanMermaidBlocks(markdown);
  const errors: PlanMermaidError[] = [...fenceErrors];
  if (blocks.length === 0) {
    return errors;
  }

  for (const block of blocks) {
    try {
      parser.parse(block.body);
    } catch (error) {
      const blockErrorLine = peleErrorLine(error);
      errors.push({
        startLine: block.startLine,
        errorLine:
          blockErrorLine !== undefined
            ? block.startLine +
              countLeadingStrippedLines(block.body) +
              blockErrorLine
            : undefined,
        diagramType: block.diagramType,
        message: formatPeleError(error),
        // Sequence-specific root-cause hints: the raw parser message is
        // cryptic ("Expecting '()', 'SOLID_OPEN_ARROW', …") and its caret can
        // land on the line AFTER the real problem, so give the agent the
        // concrete offending source line(s) to fix in one pass. Other diagram
        // types have no diagnostic rules yet.
        diagnostics:
          block.diagramType === "sequenceDiagram"
            ? diagnoseSequenceDiagramIssues(block.body)
            : [],
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

    // Precise root-cause diagnostics first. Use content anchors (the actual
    // offending source line) instead of absolute line numbers: line numbers
    // depend on mermaid's stripping behavior and can drift; the agent can
    // grep for `code` reliably. Backticks in the code are escaped so the
    // inline code span cannot be broken by the offending source.
    if (error.diagnostics && error.diagnostics.length > 0) {
      for (const diag of error.diagnostics) {
        lines.push(`  · 疑似根因: ${diag.message}`);
        lines.push(`    出错行内容: \`${diag.code.replaceAll("`", "\\`")}\``);
      }
    }

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
 * Degrades gracefully: if the pele runtime cannot be loaded (missing
 * dependency), returns { skipped: true, reason } so the caller can proceed
 * with the review gate and surface the reason. Only dependency acquisition is
 * covered by the degrade path — errors from the validation core propagate.
 */
export async function runPlanMermaidValidation(
  markdown: string,
  parserProvider: () => Promise<PeleParser> = getPeleParser,
): Promise<PlanMermaidValidationResult> {
  let parser: PeleParser;
  try {
    parser = await parserProvider();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { skipped: true, reason, errors: [] };
  }
  return {
    skipped: false,
    errors: validatePlanMermaidBlocks(markdown, parser),
  };
}
