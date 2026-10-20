/**
 * Structural rules for the vendored pstack skill group.
 *
 * Pure: every function takes text (or text plus a known-name set) and returns
 * findings. No fs, no network. `pstack-skills.test.ts` is the thin shell that
 * reads the repo and asserts the findings list is empty.
 */

export type RepoDoc = { path: string; content: string };

export type Finding = { path: string; rule: string; detail: string };

const FORBIDDEN_MARKERS = [
  ".cursor/",
  ".mdc",
  "pstack-models",
  "subagent_type",
  "Task 工具",
  "poteto-mode",
  "bugbot",
];

const MAX_DESCRIPTION_LENGTH = 1024;

export const parseFrontmatter = (
  text: string,
): { fields: Record<string, string>; body: string } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!field) continue;
    fields[field[1]] = field[2].replace(/^["'](.*)["']$/, "$1").trim();
  }

  return { body: text.slice(match[0].length), fields };
};

const frontmatterFindings = (
  doc: RepoDoc,
  directoryName: string,
  autoRoutable: boolean,
): Finding[] => {
  const parsed = parseFrontmatter(doc.content);
  if (!parsed) {
    return [
      { path: doc.path, rule: "frontmatter-missing", detail: "no --- block" },
    ];
  }

  const { fields } = parsed;
  const findings: Finding[] = [];
  const push = (rule: string, detail: string) =>
    findings.push({ path: doc.path, rule, detail });

  if (fields.name !== directoryName) {
    push("name-mismatch", `name="${fields.name ?? ""}" dir="${directoryName}"`);
  }

  const description = fields.description ?? "";
  if (description.length === 0)
    push("description-missing", "description is empty");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    push("description-too-long", `${description.length} chars`);
  }

  // Only `principles` may route automatically; the rest are point-invoked so
  // they do not compete with the existing skills for the same requests.
  if (!autoRoutable && fields["disable-model-invocation"] !== "true") {
    push("disable-model-invocation-missing", "expected true");
  }
  if (autoRoutable && fields["disable-model-invocation"] === "true") {
    push("auto-routable-marked-manual", "principles must stay auto-routable");
  }

  return findings;
};

export const extractSkillReferences = (text: string): string[] => {
  const names = new Set<string>();
  for (const match of text.matchAll(/\/skill:([a-z0-9-]+)/g)) {
    names.add(match[1]);
  }
  return [...names];
};

const referenceFindings = (
  doc: RepoDoc,
  knownSkillNames: ReadonlySet<string>,
): Finding[] =>
  extractSkillReferences(doc.content)
    .filter((name) => !knownSkillNames.has(name))
    .map((name) => ({
      path: doc.path,
      rule: "unknown-skill-reference",
      detail: `/skill:${name}`,
    }));

const normalizePath = (path: string): string => {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return `../${path}`;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
};

const markdownLinkFindings = (
  doc: RepoDoc,
  knownRepoPaths: ReadonlySet<string>,
): Finding[] => {
  const directory = doc.path.split("/").slice(0, -1).join("/");
  const findings: Finding[] = [];

  for (const match of doc.content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    // Links that climb out of the repo (or into a gitignored tree such as
    // .pi/plans) are the author's to keep honest; a check here would pass
    // locally and fail in a fresh clone.
    if (/^(https?:|mailto:|#|\/skill:)/.test(target)) continue;
    if (target.startsWith("../../")) continue;

    const resolved = normalizePath(`${directory}/${target.split("#")[0]}`);
    if (!knownRepoPaths.has(resolved)) {
      findings.push({
        path: doc.path,
        rule: "broken-markdown-link",
        detail: target,
      });
    }
  }

  return findings;
};

const forbiddenMarkerFindings = (doc: RepoDoc): Finding[] =>
  FORBIDDEN_MARKERS.filter((marker) => doc.content.includes(marker)).map(
    (marker) => ({
      path: doc.path,
      rule: "upstream-harness-residue",
      detail: marker,
    }),
  );

export const extractIndexedPrincipleIds = (indexText: string): string[] => {
  const ids: string[] = [];
  for (const line of indexText.split(/\r?\n/)) {
    const match = /^-\s+\*\*[^*]+\*\*（`([a-z0-9-]+)`）/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
};

const principleIndexFindings = (
  indexPath: string,
  indexText: string,
  referenceIds: readonly string[],
): Finding[] => {
  const indexed = new Set(extractIndexedPrincipleIds(indexText));
  const files = new Set(referenceIds);
  const findings: Finding[] = [];

  for (const id of indexed) {
    if (!files.has(id)) {
      findings.push({
        path: indexPath,
        rule: "indexed-principle-missing",
        detail: `references/${id}.md`,
      });
    }
  }
  for (const id of files) {
    if (!indexed.has(id)) {
      findings.push({
        path: indexPath,
        rule: "principle-not-indexed",
        detail: `references/${id}.md`,
      });
    }
  }

  return findings;
};

export type SkillGroupInput = {
  /** Docs whose directory carries a SKILL.md, keyed by their directory name. */
  skillDocs: Array<{ directoryName: string; doc: RepoDoc }>;
  autoRoutableDirectories: readonly string[];
  /** Every .md under the group, including SKILL.md files and README. */
  groupDocs: readonly RepoDoc[];
  principleIndex: {
    path: string;
    text: string;
    referenceIds: readonly string[];
  };
  promptDoc: RepoDoc;
  knownSkillNames: ReadonlySet<string>;
  knownRepoPaths: ReadonlySet<string>;
};

export const lintSkillGroup = (input: SkillGroupInput): Finding[] => {
  const autoRoutable = new Set(input.autoRoutableDirectories);

  const skillFindings = input.skillDocs.flatMap(({ directoryName, doc }) => [
    ...frontmatterFindings(doc, directoryName, autoRoutable.has(directoryName)),
    ...referenceFindings(doc, input.knownSkillNames),
    ...markdownLinkFindings(doc, input.knownRepoPaths),
    ...forbiddenMarkerFindings(doc),
  ]);

  const groupFindings = input.groupDocs.flatMap((doc) => [
    ...referenceFindings(doc, input.knownSkillNames),
    ...markdownLinkFindings(doc, input.knownRepoPaths),
    ...forbiddenMarkerFindings(doc),
  ]);

  return [
    ...skillFindings,
    ...groupFindings,
    ...principleIndexFindings(
      input.principleIndex.path,
      input.principleIndex.text,
      input.principleIndex.referenceIds,
    ),
    ...referenceFindings(input.promptDoc, input.knownSkillNames),
    ...markdownLinkFindings(input.promptDoc, input.knownRepoPaths),
  ];
};
