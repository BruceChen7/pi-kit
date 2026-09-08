#!/usr/bin/env node
/**
 * Package extension settings + plugin data into a zip with a manifest and a
 * restore guide.
 *
 * Usage: node scripts/package-settings.mjs   (or `make package-settings`)
 *
 * Env overrides:
 *   PI_AGENT_DIR       agent settings dir (default ~/.pi/agent)
 *   OUT                output zip path (default pi-kit-settings-<ts>.zip in repo root)
 *   EXTRA_PLUGIN_DATA  space-separated "agent:<rel>" entries appended to the registry
 *
 * Layout in the zip (prefix `pi-kit-settings/`):
 *   agent/third_extension_settings.json
 *   agent/query-notes-log/...
 *   agent/<extra>/...
 *   MANIFEST.txt
 *   INSTALL.md
 *
 * Functional Core / Imperative Shell: renderManifest / renderInstallDoc are pure
 * (value in / value out, exported for tests); main() is the thin IO shell.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Registry (data source constant) ─────────────────────────────────────────
const DEFAULT_REGISTRY = [
  { base: "agent", rel: "third_extension_settings.json" },
  { base: "agent", rel: "query-notes-log" },
];

export const parseExtraPluginData = (raw = "") =>
  raw
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx < 0) {
        return { base: "agent", rel: entry };
      }
      const base = entry.slice(0, idx);
      const rel = entry.slice(idx + 1);
      return { base: base === "agent" ? "agent" : "project", rel };
    });

// ── Functional Core (pure, value in / value out) ────────────────────────────
export const renderManifest = (specs) => {
  const lines = ["zip内路径 | 源路径 | 大小(bytes)", "---"];
  for (const spec of specs) {
    lines.push(`${spec.zipPath} | ${spec.srcPath} | ${spec.size}`);
  }
  return `${lines.join("\n")}\n`;
};

export const renderInstallDoc = ({ hasGlobal }) => {
  const lines = [
    "# pi-kit 扩展配置与插件数据还原说明 (INSTALL)",
    "",
    "本 zip 由 `make package-settings` 生成，包含：",
    "- `agent/third_extension_settings.json`：全局扩展配置",
    "- `agent/query-notes-log/...`：query_my_notes 插件数据（查询历史）",
    "- `MANIFEST.txt`：完整文件清单（zip 内路径 | 源路径 | 大小）",
    "",
    "## 还原步骤",
    "1. 备份现有文件：",
    "   cp ~/.pi/agent/third_extension_settings.json ~/.pi/agent/third_extension_settings.json.bak.$(date +%s)",
    "2. 解压后按 MANIFEST.txt 对照还原（zip 内前缀为 `pi-kit-settings/`）：",
    "   cp pi-kit-settings/agent/third_extension_settings.json ~/.pi/agent/third_extension_settings.json",
    "   cp -R pi-kit-settings/agent/query-notes-log ~/.pi/agent/",
    "3. 使配置生效：在 pi 内执行 /reload，或重启 pi 会话。",
    "",
    "## 注意事项",
    "- 配置文件可能包含敏感信息（如 remoteApproval.botToken / chatId），请妥善保管本 zip。",
    "",
  ];
  if (!hasGlobal) {
    lines.splice(3, 1, "- （全局扩展配置在本 zip 中不存在，仅含插件数据）");
  }
  return lines.join("\n");
};

// ── Imperative Shell (thin IO) ──────────────────────────────────────────────
const walkFiles = (dir, relPrefix) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = `${relPrefix}/${name}`;
    const stats = fs.statSync(full);
    if (stats.isDirectory()) {
      out.push(...walkFiles(full, rel));
    } else if (stats.isFile()) {
      out.push({ srcPath: full, zipRel: rel, size: stats.size });
    }
  }
  return out;
};

const buildSpecs = (agentDir, repoRoot, registry) => {
  const specs = [];
  for (const entry of registry) {
    const srcPath =
      entry.base === "agent"
        ? path.join(agentDir, entry.rel)
        : path.join(repoRoot, entry.rel);
    if (!fs.existsSync(srcPath)) {
      continue;
    }
    const stats = fs.statSync(srcPath);
    const zipRel = `${entry.base}/${entry.rel}`;
    if (stats.isFile()) {
      specs.push({
        zipPath: `pi-kit-settings/${zipRel}`,
        srcPath,
        size: stats.size,
      });
    } else if (stats.isDirectory()) {
      for (const file of walkFiles(srcPath, zipRel)) {
        specs.push({
          zipPath: `pi-kit-settings/${file.zipRel}`,
          srcPath: file.srcPath,
          size: file.size,
        });
      }
    }
  }
  return specs;
};

const formatTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const runZip = (stagingDir, outPath) => {
  execFileSync("zip", ["-r", outPath, "pi-kit-settings"], {
    cwd: stagingDir,
    stdio: "inherit",
  });
};

const main = () => {
  const agentDir = path.resolve(
    process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  );
  const repoRoot = process.cwd();
  const outPath = path.resolve(
    process.env.OUT ?? `pi-kit-settings-${formatTimestamp()}.zip`,
  );
  const registry = [
    ...DEFAULT_REGISTRY,
    ...parseExtraPluginData(process.env.EXTRA_PLUGIN_DATA),
  ];

  const specs = buildSpecs(agentDir, repoRoot, registry);
  if (specs.length === 0) {
    console.error("Nothing to package: no registry entry exists.");
    process.exit(1);
  }

  const hasGlobal = specs.some((s) =>
    s.zipPath.includes("third_extension_settings.json"),
  );
  const manifest = renderManifest(specs);
  const installDoc = renderInstallDoc({ hasGlobal });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-settings-"));
  try {
    for (const spec of specs) {
      const dest = path.join(stagingDir, spec.zipPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(spec.srcPath, dest);
    }
    fs.writeFileSync(
      path.join(stagingDir, "pi-kit-settings", "MANIFEST.txt"),
      manifest,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(stagingDir, "pi-kit-settings", "INSTALL.md"),
      installDoc,
      "utf-8",
    );
    runZip(stagingDir, outPath);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  console.log(`\n==> packaged: ${outPath}`);
  console.log(`\n${manifest}`);
  if (hasGlobal) {
    console.log(
      "⚠  agent/third_extension_settings.json may contain sensitive data " +
        "(e.g. remoteApproval botToken/chatId) — keep the zip private.",
    );
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
