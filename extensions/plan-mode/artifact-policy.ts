import {
  MERMAID_CONFIG_LIGHT,
  PLAN_CONTENT_FORM_RULES,
  type PlanContentForm,
} from "./guidance.ts";

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
  | "missing_content_form"
  | "missing_fc_is";

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
  requireReviewDetails: true,
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

const hasMermaidBlock = (content: string): boolean =>
  content.includes("```mermaid");

const hasAsciiCallTree = (content: string): boolean =>
  /[\u251c\u2514]/.test(content);

// FC/IS marker: plan must declare Functional Core / Imperative Shell split
// in Implementation, Boundaries, Testing. Lightweight keyword check so the
// policy can never drift from guidance (FC_IS_GUIDANCE / FC_IS_CHECKLIST_ENTRY).
const FC_IS_MARKER_RE =
  /Functional Core|Imperative Shell|FC\/IS|value in|value out|纯函数/i;

const hasFcIsMarker = (content: string): boolean =>
  FC_IS_MARKER_RE.test(content);

const FC_IS_SECTIONS: readonly string[] = [
  "Boundaries",
  "Implementation",
  "Testing",
];

const FC_IS_SUGGESTION =
  "Add Functional Core / Imperative Shell split: Core = pure value in/value out, Shell = thin IO wrapper. " +
  "In Boundaries define plain DTO boundaries; in Implementation mark Core vs Shell + side effects in the ASCII tree; " +
  "in Testing list Core value-in/value-out cases and keep Shell thin (no mock choreography). Keywords: Functional Core, Imperative Shell, FC/IS, value in / value out, 纯函数.";

const validateFcIs = (
  sectionByName: Map<string, MarkdownSection>,
): ArtifactPolicyIssue[] => {
  const issues: ArtifactPolicyIssue[] = [];
  for (const sectionName of FC_IS_SECTIONS) {
    const section = sectionByName.get(sectionName);
    if (!section || section.content.length === 0) {
      continue;
    }
    if (!hasFcIsMarker(section.content)) {
      issues.push({
        code: "missing_fc_is",
        section: sectionName,
        message: `## ${sectionName} section must describe the Functional Core / Imperative Shell split.`,
        suggestion: FC_IS_SUGGESTION,
      });
    }
  }
  return issues;
};

type ContentFormCheck = {
  section: string;
  ok: (content: string) => boolean;
  message: string;
  suggestion: string;
};

const contentFormOk = (
  form: PlanContentForm,
): ((content: string) => boolean) =>
  form === "mermaid" ? hasMermaidBlock : hasAsciiCallTree;

const contentFormMessage = (section: string, form: PlanContentForm): string =>
  `## ${section} section is missing a ${
    form === "mermaid" ? "Mermaid diagram" : "ASCII call tree"
  }.`;

// Derived from PLAN_CONTENT_FORM_RULES so the enforced checks and the
// agent-facing pre-submit checklist (guidance.ts) can never drift apart.
const CONTENT_FORM_CHECKS: readonly ContentFormCheck[] =
  PLAN_CONTENT_FORM_RULES.map((rule) => ({
    section: rule.section,
    ok: contentFormOk(rule.form),
    message: contentFormMessage(rule.section, rule.form),
    suggestion: rule.suggestion,
  }));

const validateContentForms = (
  sectionByName: Map<string, MarkdownSection>,
): ArtifactPolicyIssue[] => {
  const issues: ArtifactPolicyIssue[] = [];
  for (const check of CONTENT_FORM_CHECKS) {
    const section = sectionByName.get(check.section);
    if (!section || section.content.length === 0) {
      continue;
    }
    if (!check.ok(section.content)) {
      issues.push({
        code: "missing_content_form",
        section: check.section,
        message: check.message,
        suggestion: check.suggestion,
      });
    }
  }
  return issues;
};

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

  if (config.requireReviewDetails) {
    issues.push(...validateContentForms(sectionByName));
    issues.push(...validateFcIs(sectionByName));
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
  missing_fc_is:
    "## Implementation\ndecide(input): Output  ← Functional Core, pure value in/value out\nshell():\n  ├─ load() ← Imperative Shell / IO\n  └─ decide(data) ← Core (pure)\n\n## Boundaries\nCore ↔ Shell DTO: { input, output } plain data\n\n## Testing\n- Core: value in / value out table tests\n- Shell: thin wiring, no mock choreography",
};

const CONTENT_FORM_SNIPPETS: Record<string, string> = {
  "Current Flow":
    "```mermaid\n" +
    MERMAID_CONFIG_LIGHT +
    "\n\nsequenceDiagram\n  A->>B: current step\n```",
  "Desired Flow":
    "```mermaid\n" +
    MERMAID_CONFIG_LIGHT +
    "\n\nsequenceDiagram\n  A->>B: new step  ← 新增\n```",
  Boundaries:
    "```mermaid\n" +
    MERMAID_CONFIG_LIGHT +
    "\n\nsequenceDiagram\n  L1->>L2: call  ← ownership\n```",
  Implementation:
    "parentFn()\n  ├─ childA()  ← 条件分支\n  └─ childB()  ← 副作用",
};

const fixSnippetForIssue = (issue: ArtifactPolicyIssue): string | null => {
  if (issue.code === "missing_content_form") {
    return issue.section
      ? (CONTENT_FORM_SNIPPETS[issue.section] ?? null)
      : null;
  }
  return FIX_SNIPPETS[issue.code] ?? null;
};

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
