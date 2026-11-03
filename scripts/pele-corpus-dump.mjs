#!/usr/bin/env node
/**
 * pele 升级的等价性 harness：把真实 parse / render 的结果钉成 canonical JSON。
 *
 * 用法：
 *   node scripts/pele-corpus-dump.mjs <out.json>            # 手写语料（默认）
 *   node scripts/pele-corpus-dump.mjs --sweep <out.json>    # 仓库里所有 ```mermaid 块
 *
 * 升级 pele 的流程：在旧版本跑一次（`npm i pele@<old> --no-save`）、`npm install`、再跑一次、diff 两份 JSON。
 * `--sweep` 是真语料，能抓到 13 条手写语料看不见的问题 —— 实例：pele 1.7.0 把标签里的
 * `<repo>` 当 XML 标记吞掉，1.13.0 转义后正确显示。
 *
 * 为什么不比 SVG 全文：SVG 带 id 序号和浮点坐标，逐字节只会得到一屏噪声。
 * 记 sha256 + 长度定位「哪些图变了」，另外单独记三条我们真的承诺给用户的内容
 * （标签文字 / classDef 颜色 / `--pele-*` CSS 变量）是否还在。
 *
 * 走的是真的调用路径，不是复刻：
 * - parse 用 `extensions/shared/pele-runtime.ts` 的 `getPeleParser()`（pi 侧三个校验器用的同一个壳）
 * - render 用 `extensions/visual-artifact/ui/.../pele-runtime.ts` 的 `renderDiagramSvg()`（UI 用的同一个门面）
 *
 * 用 jiti 加载，因为扩展内部有 `./foo.js` 指向 `foo.ts` 的写法，node 原生解析不了。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const jiti = createJiti(
  pathToFileURL(path.join(KIT, "scripts/pele-corpus-dump.mjs")).href,
  {
    interopDefault: true,
    fsCache: false,
    moduleCache: false,
  },
);

const { getPeleParser } = await jiti.import(
  path.join(KIT, "extensions/shared/pele-runtime.ts"),
);
const { formatPeleError, peleErrorColumn, peleErrorLine } = await jiti.import(
  path.join(KIT, "extensions/shared/pele-error.ts"),
);
const uiRuntime = await jiti.import(
  path.join(
    KIT,
    "extensions/visual-artifact/ui/src/renderer/adapters/media/pele-runtime.ts",
  ),
);
const { TIER_1_DIAGRAM_TYPES } = await jiti.import(
  path.join(KIT, "extensions/shared/mermaid-normalize.ts"),
);

const { renderDiagramSvg, REGISTERED_DIAGRAM_TYPES } = uiRuntime;

/**
 * 语料：`TIER_1_DIAGRAM_TYPES` 的每个类型各一条（由脚本启动时的自检保证不漏），
 * 外加真实用例与坏语法。
 */
const CASES = [
  [
    "flowchart",
    'flowchart LR\n  A["Plan 提交"] --> B["门禁校验"]',
    ["Plan 提交"],
  ],
  ["graph", "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]", ["开始"]],
  [
    "sequenceDiagram",
    "sequenceDiagram\n  participant U as Agent\n  U->>S: submit\n  S-->>U: ok",
    ["submit"],
  ],
  [
    "classDiagram",
    "classDiagram\n  class Animal {\n    +String name\n  }",
    ["Animal"],
  ],
  ["stateDiagram", "stateDiagram\n  [*] --> Idle\n  Idle --> [*]", ["Idle"]],
  [
    "stateDiagram-v2",
    "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]",
    ["Idle"],
  ],
  [
    "erDiagram",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string name\n  }",
    ["CUSTOMER"],
  ],
  [
    "gantt",
    "gantt\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2024-01-01, 3d",
    ["Task"],
  ],
  ["mindmap", "mindmap\n  root((root))\n    a\n    b", ["root"]],
  ["gitGraph", "gitGraph\n  commit\n  branch dev\n  commit", []],
  [
    "classDef",
    'flowchart LR\n  A["x"] --> B["y"]\n  classDef data fill:#dbeafe,stroke:#2563eb,color:#111827\n  B:::data',
    ["#dbeafe"],
  ],
  ["broken-flowchart", "flowchart LR\n  A[bad (label] --> B", []],
  ["broken-field", "flowchart LR\n  A --> B(", []],
  ["leading-blanks", "\n\nflowchart LR\n  A --> B(", []],
  [
    "frontmatter",
    "---\nconfig:\n  theme: base\n---\nflowchart LR\n  A --> B(",
    [],
  ],
];

const { scanMermaidBlocks } = await jiti.import(
  path.join(KIT, "extensions/plannotator-auto/mermaid-validator.ts"),
);

const sha256 = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

const describeError = (error) => ({
  message: formatPeleError(error),
  line: peleErrorLine(error) ?? null,
  column: peleErrorColumn(error) ?? null,
});

const parseCase = (parser, code) => {
  try {
    parser.parse(code);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

/**
 * 内容指纹：标签文字、颜色集合、以及去掉一切几何属性与数字后的结构。
 * `sha256` 只能告诉你「变了」，这三项告诉你「变的是不是用户看得见的东西」：
 * - `labelHash` 变了 → 标签文字变了
 * - `colors` 变了 → 配色变了
 * - `structureHash` 变了但 `labelHash`/`colors` 未变 → 标签数目/拆分变了（看内容时才需人工看）
 * - 三项都不变但 `sha256` 变了 → 纯几何（坐标、尺寸、间距）
 */
const contentFingerprint = (svg) => {
  const labelText = [...svg.matchAll(/>([^<>]+)</g)]
    .map((match) => match[1].trim())
    .filter((text) => text.length > 0)
    .join("\u0001");
  const colors = [...new Set(svg.match(/#[0-9a-fA-F]{3,8}/g) ?? [])]
    .map((color) => color.toLowerCase())
    .sort();
  const structure = [
    ...[...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((match) => match[1]),
    ...[...svg.matchAll(/class="([^"]*)"/g)].map((match) => match[1]),
  ].join("\u0002");
  return {
    labelHash: sha256(labelText),
    colors,
    structureHash: sha256(structure),
  };
};

/**
 * `labels` 只在传了 `mustContain` 时才有意义。`--sweep` 模式没有手写期望值，
 * 就干脆不输出这个字段 —— `[].every()` 恒为 true，写一个永真的检查比不写更糟。
 */
const renderCase = (code, mustContain) => {
  try {
    const svg = renderDiagramSvg({ theme: "light", definition: code });
    const checks = {
      peleClass: svg.includes("pele pele-"),
      cssVar: svg.includes("--_bg:var(--pele-bg"),
      ...(mustContain.length > 0 && {
        labels: mustContain.every((needle) => svg.includes(needle)),
      }),
    };
    return {
      ok: true,
      length: svg.length,
      sha256: sha256(svg),
      ...contentFingerprint(svg),
      checks,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const parser = await getPeleParser();
const results = {};

const corpusTypes = new Set(CASES.map(([name]) => name));
const missingTypes = [...TIER_1_DIAGRAM_TYPES].filter(
  (type) => !corpusTypes.has(type),
);
if (missingTypes.length > 0) {
  process.stderr.write(
    `手写语料缺这几个 TIER_1 类型: ${missingTypes.join(", ")}\n`,
  );
  process.exit(2);
}

if (process.argv.includes("--sweep")) {
  // 扫仓库里所有 ```mermaid 块：13 条手写语料只能证明「我们记得的那几个形状」，
  // 真语料才能抓到「旧版把标签里的 <x> 当标记吞了」这类只有真人写出来才会出现的问题。
  //
  // key 用 `<相对路径>:<块起始行>`，两种版本都能对上：文件里加了一个块，只影响它之后的行，
  // 不像自增序号那样让后面全部重编号。
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(KIT);

  for (const file of files.sort()) {
    // 复用产品门禁那套 fence 扫描（大小写 / 空块 / 未闭合的处理已经定过一次了）。
    const { blocks } = scanMermaidBlocks(readFileSync(file, "utf8"));
    for (const block of blocks) {
      results[`${path.relative(KIT, file)}:${block.startLine}`] = {
        parse: parseCase(parser, block.body),
        render: renderCase(block.body, []),
      };
    }
  }
} else {
  for (const [name, code, mustContain] of CASES) {
    results[name] = {
      parse: parseCase(parser, code),
      render: renderCase(code, mustContain),
    };
  }
}

const payload = {
  peleVersion: (await jiti.import("pele/package.json")).default.version,
  mode: process.argv.includes("--sweep") ? "sweep" : "corpus",
  caseCount: Object.keys(results).length,
  tier1Types: [...TIER_1_DIAGRAM_TYPES].sort(),
  registeredRenderers: [...REGISTERED_DIAGRAM_TYPES],
  cases: results,
};

const json = `${JSON.stringify(payload, null, 2)}\n`;

const KNOWN_FLAGS = new Set(["--sweep"]);
const unknown = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("--") && !KNOWN_FLAGS.has(arg));
if (unknown.length > 0) {
  process.stderr.write(`unknown flag(s): ${unknown.join(", ")}\n`);
  process.exit(2);
}

const outPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (outPath) {
  const target = path.resolve(KIT, outPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, json);
  process.stderr.write(
    `${payload.mode}: ${payload.caseCount} case(s) -> ${path.relative(KIT, target)}\n`,
  );
} else {
  process.stdout.write(json);
}
