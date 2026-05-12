export type ArtifactPolicyConfig = {
  enabled: boolean;
  planFormat: "pi-standard";
  allowExtraSections: boolean;
  requireSectionOrder: boolean;
  requireChinese: boolean;
  requireReviewDetails: boolean;
};

export type StandardPlanArtifactExtension = "md" | "html";

export type ArtifactPolicyIssueCode =
  | "missing_section"
  | "section_order"
  | "extra_section"
  | "empty_section"
  | "missing_steps_checkbox"
  | "missing_chinese_content"
  | "missing_review_details";

export type ArtifactPolicyIssue = {
  code: ArtifactPolicyIssueCode;
  section?: string;
  message: string;
  suggestion: string;
};

export type ArtifactPolicyResult = {
  applied: boolean;
  approved: boolean;
  issues: ArtifactPolicyIssue[];
};

export type ValidateArtifactPolicyInput = {
  path: string;
  content: string;
  config?: Partial<ArtifactPolicyConfig>;
};

type MarkdownSection = {
  name: string;
  content: string;
};

const REQUIRED_PLAN_SECTIONS = [
  "Context",
  "Steps",
  "Verification",
  "Review",
] as const;

type RequiredPlanSection = (typeof REQUIRED_PLAN_SECTIONS)[number];

const DEFAULT_ARTIFACT_POLICY_CONFIG: ArtifactPolicyConfig = {
  enabled: true,
  planFormat: "pi-standard",
  allowExtraSections: false,
  requireSectionOrder: true,
  requireChinese: true,
  requireReviewDetails: true,
};

const mergeConfig = (
  config: Partial<ArtifactPolicyConfig> | undefined,
): ArtifactPolicyConfig => ({
  ...DEFAULT_ARTIFACT_POLICY_CONFIG,
  ...config,
});

const isRequiredPlanSection = (name: string): name is RequiredPlanSection =>
  REQUIRED_PLAN_SECTIONS.includes(name as RequiredPlanSection);

export const getDefaultArtifactPolicyConfig = (): ArtifactPolicyConfig => ({
  ...DEFAULT_ARTIFACT_POLICY_CONFIG,
});

const normalizeArtifactPath = (artifactPath: string): string =>
  artifactPath.replaceAll("\\", "/").replace(/^@/, "");

export const isStandardPlanArtifactPath = (artifactPath: string): boolean => {
  const normalized = normalizeArtifactPath(artifactPath);
  const parts = normalized.split("/");
  const [dotPi, plans, repoSlug, artifactDir, fileName] = parts;
  if (
    parts.length !== 5 ||
    dotPi !== ".pi" ||
    plans !== "plans" ||
    !repoSlug ||
    artifactDir !== "plan" ||
    !fileName
  ) {
    return false;
  }

  // Standard generated plan files are date-prefixed Markdown or HTML files.
  return /^\d{4}-\d{2}-\d{2}-.+\.(?:md|html)$/.test(fileName);
};

export const isStandardMarkdownPlanArtifactPath = (
  artifactPath: string,
): boolean => {
  const normalized = normalizeArtifactPath(artifactPath);
  return isStandardPlanArtifactPath(normalized) && /^.+\.md$/i.test(normalized);
};

const parseTopLevelSections = (content: string): MarkdownSection[] => {
  // Plan policy only treats level-2 headings as top-level plan sections.
  const headingPattern = /^##\s+(.+?)\s*$/gm;
  const headings = [...content.matchAll(headingPattern)];

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const contentStart = heading.index + heading[0].length;
    const contentEnd = nextHeading?.index ?? content.length;
    return {
      name: heading[1].trim(),
      content: content.slice(contentStart, contentEnd).trim(),
    };
  });
};

const hasChineseText = (text: string): boolean => {
  // CJK Unified Ideographs indicate Chinese-language content in plan sections.
  return /[\u4e00-\u9fff]/u.test(text);
};

const hasCheckboxStep = (text: string): boolean => {
  // Steps must use Markdown task-list checkboxes for progress tracking.
  return /^\s*-\s+\[[ xX]\]\s+\S+/m.test(text);
};

const hasReviewDetailsPlaceholder = (text: string): boolean => {
  const requiredSignals = ["改动", "验证", "风险"];
  const hasRootCauseSignal = text.includes("原因") || text.includes("根因");
  return (
    requiredSignals.every((signal) => text.includes(signal)) &&
    hasRootCauseSignal
  );
};

const buildSectionMap = (
  sections: MarkdownSection[],
): Map<string, MarkdownSection> =>
  new Map(sections.map((section) => [section.name, section]));

const validateStandardPlan = (
  content: string,
  config: ArtifactPolicyConfig,
): ArtifactPolicyIssue[] => {
  const issues: ArtifactPolicyIssue[] = [];
  const sections = parseTopLevelSections(content);
  const sectionByName = buildSectionMap(sections);

  for (const sectionName of REQUIRED_PLAN_SECTIONS) {
    if (!sectionByName.has(sectionName)) {
      issues.push({
        code: "missing_section",
        section: sectionName,
        message: `缺少 ## ${sectionName} 章节。`,
        suggestion: `添加 ## ${sectionName} 章节并使用中文描述内容。`,
      });
    }
  }

  if (config.requireSectionOrder) {
    const actualRequiredSections = sections
      .filter((section) => isRequiredPlanSection(section.name))
      .map((section) => section.name);
    const expectedPrefix = REQUIRED_PLAN_SECTIONS.slice(
      0,
      actualRequiredSections.length,
    );
    if (
      actualRequiredSections.some(
        (name, index) => name !== expectedPrefix[index],
      )
    ) {
      issues.push({
        code: "section_order",
        message: "plan 顶层章节顺序不符合标准模板。",
        suggestion: "按 Context、Steps、Verification、Review 的顺序排列章节。",
      });
    }
  }

  if (!config.allowExtraSections) {
    for (const section of sections) {
      if (!isRequiredPlanSection(section.name)) {
        issues.push({
          code: "extra_section",
          section: section.name,
          message: `不允许额外的 ## ${section.name} 顶层章节。`,
          suggestion:
            "把额外信息合并到 Context、Steps、Verification 或 Review 中。",
        });
      }
    }
  }

  for (const sectionName of ["Context", "Steps", "Verification"] as const) {
    const section = sectionByName.get(sectionName);
    if (section && section.content.length === 0) {
      issues.push({
        code: "empty_section",
        section: sectionName,
        message: `## ${sectionName} 章节不能为空。`,
        suggestion: `用中文补充 ## ${sectionName} 的具体内容。`,
      });
    }
    if (config.requireChinese && section && !hasChineseText(section.content)) {
      issues.push({
        code: "missing_chinese_content",
        section: sectionName,
        message: `## ${sectionName} 章节需要使用中文描述。`,
        suggestion: "除非用户明确要求其他语言，否则请改为中文内容。",
      });
    }
  }

  const steps = sectionByName.get("Steps");
  if (steps && !hasCheckboxStep(steps.content)) {
    issues.push({
      code: "missing_steps_checkbox",
      section: "Steps",
      message: "## Steps 章节缺少 Markdown checkbox 步骤。",
      suggestion: "添加 `- [ ]` 或 `- [x]` 开头的可执行步骤。",
    });
  }

  const review = sectionByName.get("Review");
  if (
    config.requireReviewDetails &&
    review &&
    review.content.length > 0 &&
    !hasReviewDetailsPlaceholder(review.content)
  ) {
    issues.push({
      code: "missing_review_details",
      section: "Review",
      message: "## Review 占位内容缺少后续结果记录要求。",
      suggestion: "说明后续会记录改动点、验证结果、剩余风险和 bug 修复原因。",
    });
  }

  return issues;
};

export const validateArtifactPolicy = ({
  path,
  content,
  config,
}: ValidateArtifactPolicyInput): ArtifactPolicyResult => {
  const mergedConfig = mergeConfig(config);
  if (!mergedConfig.enabled || !isStandardMarkdownPlanArtifactPath(path)) {
    return {
      applied: false,
      approved: true,
      issues: [],
    };
  }

  const issues = validateStandardPlan(content, mergedConfig);
  return {
    applied: true,
    approved: issues.length === 0,
    issues,
  };
};

const FIX_SNIPPETS: Partial<Record<ArtifactPolicyIssueCode, string>> = {
  missing_section: "## Context\n- 用中文描述目标、约束、影响范围和非目标。",
  missing_steps_checkbox: "- [ ] 描述一个可验证的执行步骤",
  missing_chinese_content: "请用中文补充本章节的目标、约束或验证方式。",
  missing_review_details:
    "最终 review 将记录改动点、验证结果、剩余风险，以及 bug/根因原因。",
  section_order: "## Context\n\n## Steps\n\n## Verification\n\n## Review",
};

const fixSnippetForIssue = (issue: ArtifactPolicyIssue): string | null =>
  FIX_SNIPPETS[issue.code] ?? null;

const formatPolicyIssue = (issue: ArtifactPolicyIssue): string => {
  const section = issue.section ? ` (${issue.section})` : "";
  const snippet = fixSnippetForIssue(issue);
  const snippetText = snippet ? `\n  Suggested snippet: ${snippet}` : "";
  return `- ${issue.message}${section}\n  Fix: ${issue.suggestion}${snippetText}`;
};

const formatPolicyIssues = (issues: ArtifactPolicyIssue[]): string =>
  issues.map(formatPolicyIssue).join("\n");

export const formatArtifactPolicyFailure = (
  artifactPath: string,
  issues: ArtifactPolicyIssue[],
): string =>
  [
    "Plan Mode artifact policy blocked review submission.",
    `Path: ${artifactPath}`,
    "",
    "Fix the plan format before calling plannotator_auto_submit_review:",
    formatPolicyIssues(issues),
  ].join("\n");

export const formatApprovedArtifactPolicyFailure = (
  artifactPath: string,
  issues: ArtifactPolicyIssue[],
): string =>
  [
    "Plan Mode artifact policy requires fixes for an already approved plan.",
    `Path: ${artifactPath}`,
    "",
    "Fix the plan format before continuing with the approved plan:",
    formatPolicyIssues(issues),
  ].join("\n");
