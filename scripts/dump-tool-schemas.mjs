#!/usr/bin/env node
/**
 * 等价性 harness：把每个扩展 factory 真正注册出来的 tool schema 打印成 canonical JSON。
 *
 * 用途：schema 库迁移（`@sinclair/typebox` 0.34 → 宿主自带的 `typebox` 1.x）前后各跑一次，
 * 两份输出必须逐字节相同。key 顺序要归一化，因为 0.34 和 1.x 对同一个
 * `Type.Integer({ minimum: 0 })` 产出的 key 顺序不同，但语义相同。
 *
 *   node scripts/dump-tool-schemas.mjs .pi/plans/pi-kit/evidence/tool-schemas-after.json
 *   不给参数就写到 stdout；给路径则落盘（扩展的加载日志会污染 stdout）。
 *
 * 用 jiti 加载，因为 pi 自己就用 jiti，扩展里 `./foo.js` 指向 `foo.ts` 的写法只有它能解析。
 *
 * 输出里除了 `extensions` 还有 `failures`：跑不起来的扩展会记在那里。两次运行
 * `counts` 与 `failures` 也必须相同，否则等于换了样本在比。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOAD_TIMEOUT_MS = 20_000;

/** 递归排序 key：只归一化顺序，不动值。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

/** 未知成员一律给出可调用的空实现，让 factory 能跑到 registerTool 那一行。 */
function makeStub() {
  const target = function stub() {};
  return new Proxy(target, {
    get(obj, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "toString") return () => "";
      if (!(key in obj)) obj[key] = makeStub();
      return obj[key];
    },
    apply() {
      return undefined;
    },
    set(obj, key, value) {
      obj[key] = value;
      return true;
    },
  });
}

function makeRecorder() {
  const tools = [];
  const pi = {
    cwd: KIT,
    events: {
      on: () => () => {},
      once: () => () => {},
      off: () => {},
      emit: () => {},
    },
    on: () => () => {},
    registerTool: (def) => {
      tools.push({
        name: def?.name ?? null,
        parameters: canonicalize(def?.parameters ?? null),
        outputSchema: canonicalize(def?.outputSchema ?? null),
      });
    },
  };
  return { pi: makeStubWith(pi), tools };
}

/** 已知成员用真实实现，其余走 stub。 */
function makeStubWith(known) {
  return new Proxy(known, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (key === "then") return undefined;
      obj[key] = makeStub();
      return obj[key];
    },
  });
}

function resolveEntry(spec) {
  const abs = path.resolve(KIT, spec);
  if (!existsSync(abs)) return null;
  if (statSync(abs).isFile()) return abs;
  for (const name of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
    const candidate = path.join(abs, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const withTimeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`load timeout: ${label}`)),
          LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    // 不清理会让进程为每个扩展多活一个 20s 的 pending timer。
    clearTimeout(timer);
  }
};

const pkg = JSON.parse(readFileSync(path.join(KIT, "package.json"), "utf8"));
const jiti = createJiti(
  pathToFileURL(path.join(KIT, "scripts/dump-tool-schemas.mjs")).href,
  {
    interopDefault: false,
    fsCache: false,
    moduleCache: false,
  },
);

const extensions = [];
const failures = [];

for (const spec of pkg.pi?.extensions ?? []) {
  const entry = resolveEntry(spec);
  if (!entry) {
    failures.push({ extension: spec, error: "no entry file" });
    continue;
  }
  const { pi, tools } = makeRecorder();
  try {
    const mod = await withTimeout(jiti.import(pathToFileURL(entry).href), spec);
    const factory = mod?.default;
    if (typeof factory !== "function")
      throw new Error("no default export factory");
    await withTimeout(Promise.resolve(factory(pi)), spec);
    extensions.push({ extension: spec, tools });
  } catch (error) {
    failures.push({ extension: spec, error: String(error?.message ?? error) });
  }
}

const payload = {
  extensionCount: extensions.length,
  toolCount: extensions.reduce((sum, ext) => sum + ext.tools.length, 0),
  extensions,
  failures,
};
const json = `${JSON.stringify(payload, null, 2)}\n`;

// 可选输出文件：扩展在加载期打一行日志就会污染 stdout，落盘更稳。
const outPath = process.argv[2];
if (outPath) writeFileSync(path.resolve(KIT, outPath), json);
else process.stdout.write(json);
