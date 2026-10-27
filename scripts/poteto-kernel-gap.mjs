#!/usr/bin/env node
/**
 * Poteto 内核 gap 矩阵。声明在 scripts/poteto-kernel-map.json，判定在这里。
 *
 * Usage:
 *   node scripts/poteto-kernel-gap.mjs                 # 打印矩阵
 *   node scripts/poteto-kernel-gap.mjs --check         # 缺项必须有落点且文件存在
 *   node scripts/poteto-kernel-gap.mjs --check-routes [entry]  # 入口路由与 playbook 对齐（.json 走 catalog，其余当 prompt 抽 `playbook:`）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAP_PATH = "scripts/poteto-kernel-map.json";
const DEFAULT_CATALOG = "skills/poteto-playbooks/routes.json";
const PLAYBOOK_DIR = "skills/poteto-playbooks/playbooks";

const VERDICTS = new Set(["已有替代", "缺", "不搬"]);
const LANDING_KINDS = new Set(["repo", "env"]);
const TIERS = new Set(["n/a", "P0", "P1", "P2"]);

export const parseMap = (text) => {
  const map = JSON.parse(text);
  if (!Array.isArray(map.rows) || map.rows.length === 0) {
    throw new Error(`${MAP_PATH}: rows 为空`);
  }
  const seen = new Set();
  for (const row of map.rows) {
    if (seen.has(row.upstream)) {
      throw new Error(`${MAP_PATH}: 重复行 ${row.upstream}`);
    }
    seen.add(row.upstream);
    if (!VERDICTS.has(row.verdict)) {
      throw new Error(`${row.upstream}: verdict=${row.verdict} 不在三态内`);
    }
    if (!TIERS.has(row.tier)) {
      throw new Error(`${row.upstream}: tier=${row.tier} 不合法`);
    }
    if (!row.note || row.note.trim() === "") {
      throw new Error(`${row.upstream}: note 为空`);
    }
    if (!("landing" in row)) {
      throw new Error(`${row.upstream}: 缺 landing 键，不搬写 null`);
    }
    if (row.landing !== null && typeof row.landing !== "string") {
      throw new Error(`${row.upstream}: landing 只能是字符串或 null`);
    }
    if (row.landingKind !== undefined && !LANDING_KINDS.has(row.landingKind)) {
      throw new Error(`${row.upstream}: landingKind=${row.landingKind} 不合法`);
    }
  }
  return map;
};

/** 缺 + P0 与已有替代必须有落点；不搬必须没有；env 落点不查盘。 */
export const evaluateRows = (rows, exists) => {
  const findings = [];
  for (const row of rows) {
    const { upstream, verdict, tier, landing } = row;
    if (row.landingKind === "env") {
      if (landing !== null) {
        findings.push({ upstream, rule: "env-has-landing", detail: landing });
      }
      continue;
    }
    if (verdict === "不搬") {
      if (landing !== null) {
        findings.push({
          upstream,
          rule: "unmoved-has-landing",
          detail: landing,
        });
      }
      continue;
    }
    if (verdict === "缺" && tier !== "P0") {
      if (landing !== null && !exists(landing)) {
        findings.push({ upstream, rule: "landing-missing", detail: landing });
      }
      continue;
    }
    if (!landing) {
      findings.push({
        upstream,
        rule: "landing-required",
        detail: `${verdict}/${tier}`,
      });
      continue;
    }
    if (!exists(landing)) {
      findings.push({ upstream, rule: "landing-missing", detail: landing });
    }
  }
  return findings;
};

export const tally = (rows) => {
  const counts = { 已有替代: 0, 缺: 0, 不搬: 0 };
  const byTier = { P0: 0, P1: 0, P2: 0, "n/a": 0 };
  for (const row of rows) {
    counts[row.verdict] += 1;
    byTier[row.tier] += 1;
  }
  return { counts, byTier };
};

export const formatMatrix = (rows) => {
  const lines = rows.map((row) =>
    [
      row.upstream,
      row.verdict,
      row.tier,
      row.landingKind === "env" ? "env" : (row.landing ?? "-"),
      row.note,
    ].join("\t"),
  );
  const { counts, byTier } = tally(rows);
  lines.push(
    [
      "# 合计",
      `已有替代=${counts["已有替代"]}`,
      `缺=${counts["缺"]}`,
      `不搬=${counts["不搬"]}`,
      `P0=${byTier.P0} P1=${byTier.P1} P2=${byTier.P2}`,
    ].join("\t"),
  );
  return lines.join("\n");
};

/** 抽取 routes.json 里的 playbook 引用（route playbookHints + mode playbook），去重后返回。 */
export const extractCatalogRefs = (catalogText) => {
  const catalog = JSON.parse(catalogText);
  const refs = [];
  for (const route of catalog.routes ?? []) {
    for (const hint of route.playbookHints ?? []) {
      if (hint?.playbook) refs.push(hint.playbook);
    }
  }
  for (const mode of catalog.modes ?? []) {
    if (mode?.playbook) refs.push(mode.playbook);
  }
  return [...new Set(refs)];
};

/** 抽取入口正文里全部 `playbook: <name>` 引用，去重后返回。 */
export const extractRouteRefs = (promptText) => {
  const refs = [];
  const re = /playbook:\s*`?([a-z0-9-]+)`?/g;
  for (const match of promptText.matchAll(re)) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
};

export const checkRoutes = (refs, playbooks) => {
  const available = new Set(playbooks);
  const findings = [];
  for (const ref of refs) {
    if (!available.has(ref)) {
      findings.push({ rule: "route-dangling", detail: ref });
    }
  }
  for (const name of available) {
    if (!refs.includes(name)) {
      findings.push({ rule: "playbook-orphan", detail: name });
    }
  }
  return findings;
};

const readIfExists = (relative) => {
  const absolute = path.join(REPO_ROOT, relative);
  return fs.existsSync(absolute);
};

const listPlaybooks = () => {
  const absolute = path.join(REPO_ROOT, PLAYBOOK_DIR);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.basename(name, ".md"))
    .sort();
};

const main = (argv) => {
  const map = parseMap(fs.readFileSync(path.join(REPO_ROOT, MAP_PATH), "utf8"));
  const rows = map.rows;

  if (argv.includes("--check")) {
    const findings = evaluateRows(rows, readIfExists);
    if (findings.length > 0) {
      for (const f of findings)
        console.error(`${f.rule}\t${f.upstream}\t${f.detail}`);
      console.error(`gap 门禁失败：${findings.length} 项`);
      return 1;
    }
    console.log(`gap 门禁通过：${rows.length} 行，无缺项落点`);
    return 0;
  }

  if (argv.includes("--check-routes")) {
    const given = argv[argv.indexOf("--check-routes") + 1];
    const relative = given && !given.startsWith("--") ? given : DEFAULT_CATALOG;
    const absolute = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(absolute)) {
      console.error(`--check-routes 找不到入口文件：${relative}`);
      return 1;
    }
    const sourceText = fs.readFileSync(absolute, "utf8");
    const refs = relative.endsWith(".json")
      ? extractCatalogRefs(sourceText)
      : extractRouteRefs(sourceText);
    const findings = checkRoutes(refs, listPlaybooks());
    if (findings.length > 0) {
      for (const f of findings) console.error(`${f.rule}\t${f.detail}`);
      console.error(`路由门禁失败：${findings.length} 项`);
      return 1;
    }
    console.log(
      `路由门禁通过：${refs.length} 个引用，${listPlaybooks().length} 个 playbook`,
    );
    return 0;
  }

  console.log(formatMatrix(rows));
  return 0;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
