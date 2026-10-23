#!/usr/bin/env node
/**
 * 证明「模型实际收到的请求里带着 poteto guidance」。
 *
 * `verify-plugin.mjs` 的 command 模式不调模型，所以它永远看不到注入。这里换一条路：
 * 真跑一次 `pi -p`，用一个一次性探针扩展把 `before_provider_request` 的 payload
 * dump 出来，再在 payload 里找 guidance 的特征串。
 *
 *   node scripts/verify-injection.mjs              # 默认模型，一次很小的一次性请求（用 --poteto-mode flag 开）
 *   node scripts/verify-injection.mjs --use-config # 不用 flag，靠 settings 的默认值开
 *   node scripts/verify-injection.mjs --control    # 再跑一次完全不带本扩展的，断言特征串不出现
 *   node scripts/verify-injection.mjs --model <provider/model>
 *   node scripts/verify-injection.mjs --keep       # 保留临时目录，便于手看 payload
 *
 * 退出码：0 通过，1 未通过，2 前置条件不满足（pi 不在 PATH）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PLUGIN = path.join(REPO_ROOT, "extensions/poteto-mode");
const NEEDLES = [
  "poteto 模式（常驻）",
  "由 plan-mode 管",
  "| verification（只读） |",
];

const PROBE = `import { writeFileSync } from "node:fs";

export default function payloadProbe(pi) {
  pi.on("before_provider_request", (event) => {
    writeFileSync(process.env.PROBE_OUT, JSON.stringify(event.payload));
  });
}
`;

const parseArgs = (argv) => {
  const options = {
    model: null,
    keep: false,
    control: false,
    useConfig: false,
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") {
      options.model = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--control") {
      options.control = true;
    } else if (arg === "--use-config") {
      options.useConfig = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] ?? options.timeoutMs);
      index += 1;
    }
  }
  return options;
};

/** 跑一次 pi，返回 payload 文本；没写出来返回 null。 */
const capturePayload = ({ variant, probePath, outDir, options }) => {
  const payloadPath = path.join(outDir, `${variant}.json`);

  const args = [
    "-p",
    "reply with the single word ok",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
    "-e",
    probePath,
  ];
  // control 组完全不装本扩展，这样特征串只可能来自它。
  if (variant !== "control") {
    args.splice(args.indexOf("-e"), 0, "-e", PLUGIN);
    if (!options.useConfig) {
      args.push("--poteto-mode");
    }
  }
  if (options.model) {
    args.push("--model", options.model);
  }

  const run = spawnSync("pi", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PROBE_OUT: payloadPath },
    encoding: "utf8",
    timeout: options.timeoutMs,
  });

  if (run.error) {
    return { error: run.error, payloadPath, payload: null };
  }
  if (!fs.existsSync(payloadPath)) {
    return { error: null, payloadPath, payload: null, run };
  }
  return {
    error: null,
    payloadPath,
    payload: fs.readFileSync(payloadPath, "utf8"),
    run,
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const probePath = path.join(
    os.tmpdir(),
    `pi-kit-payload-probe-${process.pid}.ts`,
  );
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-injection-"));
  fs.writeFileSync(probePath, PROBE);

  const cleanup = () => {
    fs.rmSync(probePath, { force: true });
    if (!options.keep) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };

  const enabled = capturePayload({
    variant: options.useConfig ? "config" : "enabled",
    probePath,
    outDir,
    options,
  });
  if (enabled.error) {
    cleanup();
    console.error(`前置条件不满足：无法启动 pi（${enabled.error.message}）`);
    return 2;
  }
  if (enabled.payload === null) {
    console.error(`FAIL 探针没有写出 payload（退出码 ${enabled.run?.status}）`);
    console.error(`stderr: ${(enabled.run?.stderr ?? "").slice(-800)}`);
    cleanup();
    return 1;
  }

  const missing = NEEDLES.filter((needle) => !enabled.payload.includes(needle));
  if (missing.length > 0) {
    console.error(`FAIL payload 里缺这些串：${missing.join(" / ")}`);
    console.error(`payload 落在：${outDir}（加 --keep 保留）`);
    cleanup();
    return 1;
  }

  console.log(
    `PASS 注入到达真实请求（${options.useConfig ? "settings 默认值" : "--poteto-mode"}）`,
  );
  console.log(`  needle: ${NEEDLES.length}/${NEEDLES.length}`);
  console.log(`  payload: ${(enabled.payload.length / 1024).toFixed(1)}KB`);

  if (options.control) {
    const control = capturePayload({
      variant: "control",
      probePath,
      outDir,
      options,
    });
    if (control.payload === null) {
      console.error("FAIL control 跑没有写出 payload");
      cleanup();
      return 1;
    }
    const leaked = NEEDLES.filter((needle) => control.payload.includes(needle));
    if (leaked.length > 0) {
      console.error(`FAIL 没开模式也出现了：${leaked.join(" / ")}`);
      cleanup();
      return 1;
    }
    console.log("PASS 不装本扩展时同样的 needle 不出现");
  }

  console.log(
    `  evidence: ${options.keep ? outDir : `${outDir}（已删除，加 --keep 保留）`}`,
  );
  cleanup();
  return 0;
};

process.exit(main());
