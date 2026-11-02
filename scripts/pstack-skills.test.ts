import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractIndexedPrincipleIds,
  type Finding,
  GAP_EMPTY_PHRASE,
  GAP_UNAVAILABLE_PHRASE,
  gapDistinctionFindings,
  lintSkillGroup,
  namingFindings,
  orphanJudgmentListFindings,
  parseFrontmatter,
  probeCoverageFindings,
  type RepoDoc,
  removedFeatureFindings,
  type SkillGroupInput,
  sourceDegradationFindings,
} from "./pstack-skills-rules.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const readDoc = (relativePath: string): RepoDoc => ({
  path: relativePath,
  content: fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
});

const listFiles = (relativeDirectory: string): string[] => {
  const absolute = path.join(REPO_ROOT, relativeDirectory);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(REPO_ROOT, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
};

const markdownFiles = (files: string[]): string[] =>
  files.filter((file) => file.endsWith(".md"));

const directoryOf = (file: string): string => path.posix.dirname(file);

const skillNameOf = (file: string): string | undefined =>
  parseFrontmatter(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"))?.fields
    .name;

// Only the skills that sit directly under skills/. The knowledge-wiki group nests
// one level deeper and carries its parent in the name by design.
const flatSkillFiles = (skillFiles: string[]): string[] =>
  skillFiles.filter(
    (file) => path.posix.dirname(path.posix.dirname(file)) === "skills",
  );

const buildRepoInput = () => {
  const skillFiles = markdownFiles(listFiles("skills")).filter((file) =>
    file.endsWith("/SKILL.md"),
  );
  const promptFiles = markdownFiles(listFiles("prompts"));
  const groupFiles = markdownFiles(listFiles("skills/pstack"));
  const groupSkillFiles = skillFiles.filter((file) =>
    file.startsWith("skills/pstack/"),
  );

  const referenceIds = groupFiles
    .filter((file) => file.startsWith("skills/pstack/principles/references/"))
    .map((file) => path.basename(file, ".md"));

  const flatSkillDocs = flatSkillFiles(skillFiles).map((file) => ({
    directoryName: path.posix.basename(path.posix.dirname(file)),
    doc: readDoc(file),
  }));

  return {
    skillFiles,
    flatSkillDocs,
    groupFiles,
    referenceIds,
    input: {
      skillDocs: groupSkillFiles.map((file) => ({
        directoryName: path.basename(directoryOf(file)),
        doc: readDoc(file),
      })),
      autoRoutableDirectories: ["principles"],
      groupDocs: groupFiles.map(readDoc),
      principleIndex: {
        path: "skills/pstack/principles/SKILL.md",
        text: readDoc("skills/pstack/principles/SKILL.md").content,
        referenceIds,
      },
      promptDoc: readDoc("prompts/poteto.md"),
      promptDocs: promptFiles.map(readDoc),
      hasSubagentExtension: fs.existsSync(
        path.join(REPO_ROOT, "extensions/subagent/index.ts"),
      ),
      knownSkillNames: new Set(
        skillFiles.map(skillNameOf).filter((name): name is string => !!name),
      ),
      knownRepoPaths: new Set([...skillFiles, ...promptFiles, ...groupFiles]),
    },
  };
};

describe("pstack skill group", () => {
  // The group grows as the spec's P1/P2 phases land, so assert the required
  // skills by name instead of pinning how many there are.
  const REQUIRED_SKILLS = [
    "principles",
    "blast-radius",
    "correct",
    "unslop",
    "interrogate",
    "swarm",
    "arena",
    "create-verification-skill",
    "maintain-verification-skill",
    "ketchup",
    "typescript-best-practices",
    "sharpen",
    "why",
    "how",
    "recall",
    "figure-it-out",
  ];

  it("scans the vendored group, not an empty set", () => {
    const { groupFiles, referenceIds, input } = buildRepoInput();

    expect(groupFiles.length).toBeGreaterThan(4);
    expect(input.skillDocs.map((skill) => skill.directoryName)).toEqual(
      expect.arrayContaining(REQUIRED_SKILLS),
    );
    expect(referenceIds).toHaveLength(24);
    expect(input.knownSkillNames.size).toBeGreaterThan(30);
  });

  it("passes every structural rule", () => {
    const { input } = buildRepoInput();

    expect(lintSkillGroup(input)).toEqual([]);
  });

  it("routes only to skills that exist", () => {
    const { input } = buildRepoInput();

    expect(input.promptDoc.content).toContain("/skill:principles");
  });

  // A generated project skill that hides from the system prompt can only be
  // typed by hand, which defeats the point of generating one for an agent.
  it("keeps generated verification skills agent-callable", () => {
    const doc = readDoc("skills/pstack/create-verification-skill/SKILL.md");

    expect(doc.content).toContain("不要写 `disable-model-invocation: true`");
    expect(doc.content).toContain("/reload");
  });
});

describe("repo skill naming", () => {
  it("names every flat skill after its directory", () => {
    const { flatSkillDocs } = buildRepoInput();

    expect(namingFindings(flatSkillDocs)).toEqual([]);
  });
  it("flags an upstream sync that rewrites the name", () => {
    const findings = namingFindings([
      {
        directoryName: "review",
        doc: {
          path: "skills/review/SKILL.md",
          content: "---\nname: plan-code-review\ndescription: x\n---\n",
        },
      },
    ]);

    expect(findings).toEqual([
      {
        path: "skills/review/SKILL.md",
        rule: "name-mismatch",
        detail: 'name="plan-code-review" dir="review"',
      },
    ]);
  });
});

describe("removed feature mentions", () => {
  // Prose that names a deleted feature was caught twice by hand and missed by
  // the literal `herdr-squad` grep both times, so the scan is repo-wide.
  const proseDocs = (): RepoDoc[] =>
    [
      ...listFiles("skills").filter((file) => /\.(md|json|txt)$/.test(file)),
      ...listFiles("prompts").filter((file) => file.endsWith(".md")),
    ].map(readDoc);

  it("keeps skills and prompts free of deleted feature names", () => {
    expect(proseDocs().length).toBeGreaterThan(60);
    expect(removedFeatureFindings(proseDocs())).toEqual([]);
  });

  it("flags the real strings that survived the literal grep", () => {
    const historical = [
      "| 要人看着、可插话   | `/skill:herdr-squad` | 收 report |",
      'description: "...或一次长跑、后台任务、squad 结束后要交付。"',
      "`reviewed by <model>` when a squad reviewer ran, or `self-review` when it did not.",
      "fire off independent research sub-sessions",
      "- `subagent explore` or `herdr-squad` — available for research tickets",
    ];

    expect(
      removedFeatureFindings(
        historical.map((content, index) => ({
          path: `probe/${index}.md`,
          content,
        })),
      ),
    ).toEqual([
      {
        path: "probe/0.md",
        rule: "removed-feature-mention",
        detail: '"squad" names a deleted feature',
      },
      {
        path: "probe/1.md",
        rule: "removed-feature-mention",
        detail: '"squad" names a deleted feature',
      },
      {
        path: "probe/2.md",
        rule: "removed-feature-mention",
        detail: '"squad" names a deleted feature',
      },
      {
        path: "probe/4.md",
        rule: "removed-feature-mention",
        detail: '"squad" names a deleted feature',
      },
    ]);
  });

  it("leaves ordinary delegation prose alone", () => {
    const findings = removedFeatureFindings([
      {
        path: "probe/ok.md",
        content:
          'Dispatch a `subagent` (`agent: "explore"`, `background: true`) and collect it with `subagent action: "wait"`.',
      },
    ]);

    expect(findings).toEqual([]);
  });
});

describe("lintSkillGroup", () => {
  const emptyInput: SkillGroupInput = {
    skillDocs: [],
    autoRoutableDirectories: ["principles"],
    groupDocs: [],
    principleIndex: { path: "index.md", text: "", referenceIds: [] },
    promptDoc: { path: "prompts/poteto.md", content: "" },
    promptDocs: [],
    hasSubagentExtension: false,
    knownSkillNames: new Set(["principles"]),
    knownRepoPaths: new Set<string>(),
  };

  const lint = (overrides: Partial<typeof emptyInput>): Finding[] =>
    lintSkillGroup({ ...emptyInput, ...overrides });

  const rules = (findings: Finding[]) =>
    findings.map((finding) => finding.rule);

  const skillDoc = (content: string) => [
    {
      directoryName: "correct",
      doc: { path: "skills/pstack/correct/SKILL.md", content },
    },
  ];

  it("catches a /skill: reference to a skill that was never imported", () => {
    const findings = lint({
      groupDocs: [
        {
          path: "skills/pstack/principles/references/explain-the-number.md",
          content:
            "Run the full procedure with the [benchmark-checklist](/skill:benchmark-checklist) skill.",
        },
      ],
    });

    expect(findings).toEqual([
      {
        path: "skills/pstack/principles/references/explain-the-number.md",
        rule: "unknown-skill-reference",
        detail: "/skill:benchmark-checklist",
      },
    ]);
  });

  it("catches a relative markdown link to a missing file", () => {
    const findings = lint({
      groupDocs: [
        {
          path: "skills/pstack/principles/references/prove-it-works.md",
          content: "Distinct from [Prove It Works](prove-it-works.md).",
        },
      ],
    });

    expect(rules(findings)).toEqual(["broken-markdown-link"]);
  });

  it("catches upstream harness residue", () => {
    const findings = lint({
      groupDocs: [
        {
          path: "skills/pstack/correct/SKILL.md",
          content: "Read .cursor/rules first.",
        },
      ],
    });

    expect(rules(findings)).toEqual(["upstream-harness-residue"]);
  });

  it("catches a frontmatter name that does not match its directory", () => {
    const findings = lint({
      skillDocs: skillDoc("---\nname: blaster\ndescription: x\n---\n"),
    });

    expect(rules(findings)).toEqual([
      "name-mismatch",
      "disable-model-invocation-missing",
    ]);
  });

  it("catches a missing frontmatter block", () => {
    expect(rules(lint({ skillDocs: skillDoc("# no frontmatter\n") }))).toEqual([
      "frontmatter-missing",
    ]);
  });

  it("catches an over-long description", () => {
    const findings = lint({
      skillDocs: skillDoc(
        `---\nname: correct\ndescription: ${"x".repeat(1025)}\ndisable-model-invocation: true\n---\n`,
      ),
    });

    expect(rules(findings)).toEqual(["description-too-long"]);
  });

  it("catches principles being marked as manual-only", () => {
    const findings = lint({
      skillDocs: [
        {
          directoryName: "principles",
          doc: {
            path: "skills/pstack/principles/SKILL.md",
            content:
              "---\nname: principles\ndescription: x\ndisable-model-invocation: true\n---\n",
          },
        },
      ],
    });

    expect(rules(findings)).toEqual(["auto-routable-marked-manual"]);
  });

  it("catches an index that drifts from the reference files", () => {
    const findings = lint({
      principleIndex: {
        path: "skills/pstack/principles/SKILL.md",
        text: "- **Prove It Works**（`prove-it-works`）— x\n",
        referenceIds: ["prove-it-works", "fix-root-causes"],
      },
    });

    expect(findings).toEqual([
      {
        path: "skills/pstack/principles/SKILL.md",
        rule: "principle-not-indexed",
        detail: "references/fix-root-causes.md",
      },
    ]);
  });

  it("catches a prompt that denies a capability the repo has", () => {
    const findings = lint({
      promptDocs: [
        {
          path: "prompts/poteto.md",
          content: "不派写任务的子代理。pi 没有这个能力。",
        },
      ],
      hasSubagentExtension: true,
    });

    expect(findings).toEqual([
      {
        path: "prompts/poteto.md",
        rule: "stale-capability-claim",
        detail: "pi 没有这个能力",
      },
      {
        path: "prompts/poteto.md",
        rule: "stale-capability-claim",
        detail: "不派写任务的子代理",
      },
    ]);
  });

  it("catches an upstream model slug in the group", () => {
    const findings = lint({
      groupDocs: [
        {
          path: "skills/pstack/interrogate/SKILL.md",
          content: "Run both on claude-opus-5-5 and grok-4.7-xhigh-fast.",
        },
      ],
    });

    expect(findings).toEqual([
      {
        path: "skills/pstack/interrogate/SKILL.md",
        rule: "upstream-model-slug",
        detail: "claude-opus-5-5",
      },
      {
        path: "skills/pstack/interrogate/SKILL.md",
        rule: "upstream-model-slug",
        detail: "grok-4.7-xhigh-fast",
      },
    ]);
  });

  it("catches a prompt that delegates before the extension exists", () => {
    const findings = lint({
      promptDocs: [
        {
          path: "prompts/poteto.md",
          content: "Use subagent general for the write task.",
        },
      ],
      hasSubagentExtension: false,
    });

    expect(findings).toEqual([
      {
        path: "prompts/poteto.md",
        rule: "delegation-target",
        detail:
          "prompts reference subagent but extensions/subagent/index.ts is missing",
      },
    ]);
  });
});

describe("extractIndexedPrincipleIds", () => {
  it("reads ids from index bullets only", () => {
    const text = [
      "## Verification",
      "- **Prove It Works**（`prove-it-works`）— 收尾前。",
      "- **Fix Root Causes**（`fix-root-causes`）— 调试。",
      "与 `codebase-design` 的边界：它给流程。",
    ].join("\n");

    expect(extractIndexedPrincipleIds(text)).toEqual([
      "prove-it-works",
      "fix-root-causes",
    ]);
  });
});

// 「本机没有这个源」与「查了没有」是两种结论。合成时把它们写混，等于宣称做过
// 一次没做过的检索。这三条门禁盯住那个区分不被改动压平。
describe("gap distinction", () => {
  it("keeps both gap phrasings in the why source index", () => {
    const doc = readDoc("skills/pstack/why/references/source-playbook.md");

    expect(gapDistinctionFindings(doc)).toEqual([]);
  });

  it("flags a playbook that only knows how to say one of them", () => {
    const findings = gapDistinctionFindings({
      path: "skills/pstack/why/references/source-playbook.md",
      content: `写 ${GAP_UNAVAILABLE_PHRASE} 就够了。`,
    });

    expect(findings).toEqual([
      {
        path: "skills/pstack/why/references/source-playbook.md",
        rule: "gap-phrase-missing",
        detail: GAP_EMPTY_PHRASE,
      },
    ]);
  });

  it("keeps the two phrasings distinct, not aliases of each other", () => {
    // 同一句话里同时出现两种时，读者无法判断哪个是环境事实、哪个是检索结果。
    expect(GAP_UNAVAILABLE_PHRASE).not.toBe(GAP_EMPTY_PHRASE);
  });
});

describe("optional sources degrade", () => {
  const sourceDocs = (): RepoDoc[] =>
    listFiles("skills/pstack/why/references/sources")
      .filter((file) => file.endsWith(".md"))
      .map(readDoc);

  it("ships optional source playbooks to check", () => {
    expect(sourceDocs().length).toBeGreaterThan(5);
  });

  it("tells every source what to do when it is absent", () => {
    const findings = sourceDegradationFindings(sourceDocs()).filter(
      // 事故口味那份不是独立来源，是叠加在别的源上的查询口味。
      (finding) => !finding.path.endsWith("incident-postmortem.md"),
    );

    expect(findings).toEqual([]);
  });

  it("flags a source that assumes it is always there", () => {
    const findings = sourceDegradationFindings([
      { path: "probe/source.md", content: "直接查这个源就行。" },
    ]);

    expect(findings).toEqual([
      {
        path: "probe/source.md",
        rule: "source-without-degradation",
        detail: "可选来源必须写明本机没有时怎么办",
      },
    ]);
  });
});

describe("judgment lists have an edge in", () => {
  it("reaches the design red flags from codebase-design", () => {
    const target = readDoc("skills/codebase-design/DESIGN-RED-FLAGS.md");
    const referrers = ["skills/codebase-design/SKILL.md"].map(readDoc);

    expect(orphanJudgmentListFindings(target, referrers)).toEqual([]);
  });

  it("flags a judgment list nobody links to", () => {
    const findings = orphanJudgmentListFindings(
      { path: "skills/codebase-design/ORPHAN.md", content: "# x" },
      [{ path: "skills/codebase-design/SKILL.md", content: "没有引用。" }],
    );

    expect(findings).toEqual([
      {
        path: "skills/codebase-design/ORPHAN.md",
        rule: "orphan-judgment-list",
        detail: "没有入边：ORPHAN.md 没被任何文件引用（codebase-design）",
      },
    ]);
  });
});

describe("probe covers credentials, not just directories", () => {
  it("probes both the skill directory and its credential", () => {
    const doc = readDoc("skills/pstack/why/SKILL.md");

    expect(probeCoverageFindings(doc)).toEqual([]);
  });

  it("flags a probe that stops at the directory check", () => {
    const findings = probeCoverageFindings({
      path: "skills/pstack/why/SKILL.md",
      content:
        'for s in a b; do [ -d "$HOME/.agents/skills/$s" ] && echo "$s"; done',
    });

    expect(findings).toEqual([
      {
        path: "skills/pstack/why/SKILL.md",
        rule: "probe-misses-credentials",
        detail: "探源只探目录，没探凭据",
      },
    ]);
  });
});
