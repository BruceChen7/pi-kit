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
  | "empty_section";

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
  "Goal",
  "Current Flow",
  "Desired Flow",
  "Boundaries",
  "Implementation",
  "Testing",
  "Decisions",
  "Non-goals",
] as const;

const SECTION_ALIASES: Record<string, string> = {
  "Out of scope": "Non-goals",
};

type RequiredPlanSection = (typeof REQUIRED_PLAN_SECTIONS)[number];

const DEFAULT_ARTIFACT_POLICY_CONFIG: ArtifactPolicyConfig = {
  enabled: true,
  planFormat: "pi-standard",
  allowExtraSections: true,
  requireSectionOrder: true,
  requireChinese: false,
  requireReviewDetails: false,
};

const mergeConfig = (
  config: Partial<ArtifactPolicyConfig> | undefined,
): ArtifactPolicyConfig => ({
  ...DEFAULT_ARTIFACT_POLICY_CONFIG,
  ...config,
});

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

const normalizeSectionName = (name: string): string =>
  SECTION_ALIASES[name] ?? name;

const isRequiredPlanSection = (name: string): name is RequiredPlanSection =>
  REQUIRED_PLAN_SECTIONS.includes(
    normalizeSectionName(name) as RequiredPlanSection,
  );

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

  // Check required sections (with alias support)
  for (const sectionName of REQUIRED_PLAN_SECTIONS) {
    const hasExact = sectionByName.has(sectionName);
    const hasAlias =
      sectionName === "Non-goals"
        ? Object.keys(SECTION_ALIASES).some((alias) => sectionByName.has(alias))
        : false;
    if (!hasExact && !hasAlias) {
      issues.push({
        code: "missing_section",
        section: sectionName,
        message: `Missing ## ${sectionName} section.`,
        suggestion: `Add a ## ${sectionName} section (or "Out of scope" for Non-goals).`,
      });
    }
  }

  // Section order validation
  if (config.requireSectionOrder) {
    const actualRequiredSections = sections
      .filter((section) => isRequiredPlanSection(section.name))
      .map((section) => normalizeSectionName(section.name));
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
        message:
          "Plan top-level section order does not match the standard template.",
        suggestion:
          "Arrange sections in order: Goal, Current Flow, Desired Flow, " +
          "Boundaries, Implementation, Testing, Decisions, Non-goals.",
      });
    }
  }

  // Check for empty required sections
  const emptyCheckSections: RequiredPlanSection[] = [
    "Goal",
    "Current Flow",
    "Desired Flow",
    "Boundaries",
    "Implementation",
    "Testing",
    "Decisions",
    "Non-goals",
  ];
  for (const sectionName of emptyCheckSections) {
    const section =
      sectionByName.get(sectionName) ??
      (sectionName === "Non-goals"
        ? sectionByName.get("Out of scope")
        : undefined);
    if (section && section.content.length === 0) {
      issues.push({
        code: "empty_section",
        section: section.name,
        message: `## ${section.name} section cannot be empty.`,
        suggestion: `Add content to ## ${section.name}.`,
      });
    }
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
  missing_section: "## Goal\n- Describe the product goal in user language.",
  section_order:
    "## Goal\n\n## Current Flow\n\n## Desired Flow\n\n" +
    "## Boundaries\n\n## Implementation\n\n## Testing\n\n" +
    "## Decisions\n\n## Non-goals",
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
