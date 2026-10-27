import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCatalogRefs, parseMap } from "./poteto-kernel-gap.mjs";
import { FORBIDDEN_MARKERS, parseFrontmatter } from "./pstack-skills-rules.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const GROUP_DIR = "skills/poteto-playbooks";
const PLAYBOOK_DIR = `${GROUP_DIR}/playbooks`;
const CATALOG = `${GROUP_DIR}/routes.json`;
const MAP = "scripts/poteto-kernel-map.json";

const listDir = (dir: string, ext: string) => {
  const absolute = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith(ext))
    .sort();
};

const read = (relative: string) =>
  fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");

type MapRow = {
  upstream: string;
  verdict: string;
  tier: string;
  landing: string | null;
  note: string;
};

const readMap = (): { rows: MapRow[] } => parseMap(read(MAP));

const frontmatter = (text: string) => parseFrontmatter(text)?.fields ?? null;

const playbooks = listDir(PLAYBOOK_DIR, ".md").map((name) =>
  name.replace(/\.md$/, ""),
);

/** 仓库里真有的 skill 名：skills/ 下 SKILL.md 的 name，加 skills.txt 的声明行。 */
const declaredSkillNames = (): Set<string> => {
  const names = new Set<string>();
  const walk = (relative: string): string[] => {
    const absolute = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(absolute)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) found.push(...walk(child));
      else if (entry.name === "SKILL.md") found.push(child);
    }
    return found;
  };
  for (const file of walk("skills")) {
    const fields = parseFrontmatter(read(file))?.fields;
    if (fields?.name) names.add(fields.name);
  }
  for (const line of read("skills/skills.txt").split(/\r?\n/)) {
    if (!line.includes("|") || line.trimStart().startsWith("#")) continue;
    const name = line.split("|")[0]?.trim();
    if (name) names.add(name);
  }
  return names;
};

/** map 里判为缺且分到 P0 的 playbook 名，人工只写声明，期望集从这里推导。 */
const p0Playbooks = (): string[] =>
  readMap()
    .rows.filter(
      (row) =>
        row.verdict === "缺" &&
        row.tier === "P0" &&
        typeof row.landing === "string" &&
        row.landing.startsWith(`${PLAYBOOK_DIR}/`),
    )
    .map((row) => path.basename(String(row.landing), ".md"))
    .sort();

describe("poteto playbook group", () => {
  it("imports exactly the playbooks the map grades P0", () => {
    expect(playbooks).toEqual(p0Playbooks());
  });

  it("names every playbook after its file", () => {
    for (const name of playbooks) {
      const fields = frontmatter(read(`${PLAYBOOK_DIR}/${name}.md`));
      expect(fields?.name, `${name}.md frontmatter name`).toBe(name);
      expect(
        fields?.description?.length ?? 0,
        `${name}.md description`,
      ).toBeGreaterThan(10);
    }
  });

  it("leaves no harness word in the imported group", () => {
    const files = [
      `${GROUP_DIR}/SKILL.md`,
      `${GROUP_DIR}/README.md`,
      `${GROUP_DIR}/references/review-comment-triage.md`,
      ...playbooks.map((name) => `${PLAYBOOK_DIR}/${name}.md`),
    ];
    for (const file of files) {
      const text = read(file).toLowerCase();
      for (const word of FORBIDDEN_MARKERS) {
        expect(
          text.includes(word.toLowerCase()),
          `${file} contains ${word}`,
        ).toBe(false);
      }
    }
  });

  it("routes every /skill: reference to a skill this repo declares", () => {
    const declared = declaredSkillNames();
    const groupDocs = [
      `${GROUP_DIR}/SKILL.md`,
      `${GROUP_DIR}/README.md`,
      `${GROUP_DIR}/references/review-comment-triage.md`,
      ...playbooks.map((name) => `${PLAYBOOK_DIR}/${name}.md`),
    ];
    const missing: string[] = [];
    for (const doc of groupDocs) {
      for (const match of read(doc).matchAll(/\/skill:([a-z0-9-]+)/g)) {
        if (!declared.has(match[1])) missing.push(`${doc} -> ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("cites only principle ids that have a leaf file", () => {
    const leafDir = path.join(REPO_ROOT, "skills/pstack/principles/references");
    const ids = new Set(
      fs.existsSync(leafDir)
        ? fs
            .readdirSync(leafDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.replace(/\.md$/, ""))
        : [],
    );
    const missing: string[] = [];
    for (const name of playbooks) {
      for (const match of read(`${PLAYBOOK_DIR}/${name}.md`).matchAll(
        /principles:\s*([a-z0-9-]+)/g,
      )) {
        if (!ids.has(match[1])) missing.push(`${name} -> ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("hides the group index from automatic model selection", () => {
    const fields = frontmatter(read(`${GROUP_DIR}/SKILL.md`));
    expect(
      fields?.["disable-model-invocation"],
      "index stays out of the system prompt",
    ).toBe("true");
  });

  it("lists every imported playbook in the group index", () => {
    const index = read(`${GROUP_DIR}/SKILL.md`);
    for (const name of playbooks) {
      expect(
        index.includes(`playbooks/${name}.md`),
        `SKILL.md lists ${name}`,
      ).toBe(true);
    }
  });

  it("keeps the route catalog and the playbook files in step", () => {
    const refs = extractCatalogRefs(read(CATALOG));
    expect(refs.sort()).toEqual(playbooks);
  });

  it("keeps every map row pointing at a file that exists", () => {
    const missing = readMap()
      .rows.filter((row) => row.landing !== null)
      .filter(
        (row) => !fs.existsSync(path.join(REPO_ROOT, String(row.landing))),
      )
      .map((row) => `${row.upstream} -> ${row.landing}`);
    expect(missing).toEqual([]);
  });

  it("declares all 32 upstream assets exactly once", () => {
    const { rows } = readMap();
    expect(rows).toHaveLength(32);
    expect(new Set(rows.map((row) => row.upstream)).size).toBe(32);
  });
});
