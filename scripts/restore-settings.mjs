#!/usr/bin/env node
/**
 * Restore extension settings + plugin data + teach data from a
 * package-settings zip (inverse of scripts/package-settings.mjs).
 *
 * Usage: node scripts/restore-settings.mjs   (or `make restore-settings`)
 *
 * Env overrides:
 *   ZIP               input: a package-settings zip, or a directory that
 *                     already contains pi-kit-settings/ (default: newest
 *                     pi-kit-settings-*.zip in the repo root)
 *   PI_AGENT_DIR      agent settings dir (default ~/.pi/agent)
 *   TEACH_ROOT        work root for teach data (default ~/work; empty string
 *                     disables teach restore)
 *   DRY_RUN=1         print the restore plan only, write nothing
 *   NO_BACKUP=1       skip .bak.<ts> backups before overwriting
 *
 * Restore mapping (by zip prefix, independent of MANIFEST source paths):
 *   pi-kit-settings/agent/<rel>          → <PI_AGENT_DIR>/<rel>
 *   pi-kit-settings/project/<rel>        → <repoRoot>/<rel>
 *   pi-kit-settings/teach/<project>/<rel>→ <TEACH_ROOT>/<project>/.pi/teach/<rel>
 *   MANIFEST.txt / INSTALL.md            → skipped (reference only)
 *
 * Functional Core / Imperative Shell: classifyEntry / planRestore /
 * renderRestorePlan / backupName are pure (value in / value out, exported
 * for tests); main() is the thin IO shell.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Functional Core (pure, value in / value out) ────────────────────────────
export const classifyEntry = (zipPath) => {
  if (typeof zipPath !== "string" || zipPath === "") {
    return { status: "skip", reason: "empty entry" };
  }
  const norm = zipPath.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
    return { status: "skip", reason: "absolute path" };
  }
  const parts = norm.split("/").filter(Boolean);
  if (parts[0] !== "pi-kit-settings") {
    return { status: "skip", reason: "not under pi-kit-settings/" };
  }
  if (parts.some((p) => p === "..")) {
    return { status: "skip", reason: "unsafe path segment (..)" };
  }
  const base = parts[1];
  if (base === "MANIFEST.txt" || base === "INSTALL.md") {
    return { status: "skip", reason: "meta file (reference only)" };
  }
  const relParts = parts.slice(2);
  if (relParts.length === 0) {
    return { status: "skip", reason: "top-level entry without content" };
  }
  switch (base) {
    case "agent":
      return { status: "ok", kind: "agent", rel: relParts.join("/") };
    case "project":
      return { status: "ok", kind: "project", rel: relParts.join("/") };
    case "teach":
      return {
        status: "ok",
        kind: "teach",
        project: relParts[0],
        rel: relParts.slice(1).join("/"),
      };
    default:
      return { status: "skip", reason: `unknown top-level prefix '${base}'` };
  }
};

export const planRestore = ({ entries, agentDir, repoRoot, teachRoot }) => {
  const plans = [];
  const skipped = [];
  for (const zipPath of entries) {
    const entry = classifyEntry(zipPath);
    if (entry.status === "skip") {
      skipped.push({ zipPath, reason: entry.reason });
      continue;
    }
    if (entry.kind === "teach" && !teachRoot) {
      skipped.push({
        zipPath,
        reason: "teach restore disabled (TEACH_ROOT empty)",
      });
      continue;
    }
    let destPath;
    switch (entry.kind) {
      case "agent":
        destPath = path.join(agentDir, entry.rel);
        break;
      case "project":
        destPath = path.join(repoRoot, entry.rel);
        break;
      case "teach":
        destPath = path.join(
          teachRoot,
          entry.project,
          ".pi",
          "teach",
          entry.rel,
        );
        break;
    }
    plans.push({ zipPath, destPath, kind: entry.kind });
  }
  return { plans, skipped };
};

export const backupName = (destPath, ts) => `${destPath}.bak.${ts}`;

export const renderRestorePlan = ({ plans, skipped }) => {
  const lines = ["目标路径 ← zip 内路径", "---"];
  for (const plan of plans) {
    lines.push(`${plan.destPath} ← ${plan.zipPath}`);
  }
  if (skipped.length > 0) {
    lines.push("", "跳过:");
    for (const skip of skipped) {
      lines.push(`  ${skip.zipPath} (${skip.reason})`);
    }
  }
  return `${lines.join("\n")}\n`;
};

// ── Imperative Shell (thin IO) ──────────────────────────────────────────────
const formatTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Resolve the input: explicit ZIP (file or already-extracted dir), or the
// newest pi-kit-settings-*.zip in the repo root.
const resolveInput = (input, repoRoot) => {
  if (input) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) {
      fail(`ZIP path not found: ${input}`);
    }
    return { kind: fs.statSync(abs).isDirectory() ? "dir" : "zip", path: abs };
  }
  const candidates = fs
    .readdirSync(repoRoot)
    .filter((name) => /^pi-kit-settings-.*\.zip$/.test(name))
    .map((name) => path.join(repoRoot, name))
    .filter((p) => fs.statSync(p).isFile());
  if (candidates.length === 0) {
    fail(
      "No pi-kit-settings-*.zip found in repo root. Run `make package-settings` first, or pass ZIP=<path>.",
    );
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return { kind: "zip", path: candidates[0] };
};

const listZipEntries = (zipPath) => {
  const out = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  return out.split("\n").filter((line) => line && !line.endsWith("/"));
};

const walkRel = (root, relPrefix) => {
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const rel = relPrefix === "" ? name : `${relPrefix}/${name}`;
    const stats = fs.statSync(full);
    if (stats.isDirectory()) {
      out.push(...walkRel(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
};

const listDirEntries = (dir) => {
  const settingsRoot = path.join(dir, "pi-kit-settings");
  if (!fs.existsSync(settingsRoot)) {
    fail(
      `Directory ${dir} contains no pi-kit-settings/ prefix (not a package-settings artifact).`,
    );
  }
  return walkRel(settingsRoot, "pi-kit-settings");
};

const applyPlan = (plans, sourceRoot, { noBackup, ts }) => {
  const backups = [];
  for (const plan of plans) {
    fs.mkdirSync(path.dirname(plan.destPath), { recursive: true });
    if (!noBackup && fs.existsSync(plan.destPath)) {
      const bak = backupName(plan.destPath, ts);
      fs.copyFileSync(plan.destPath, bak);
      backups.push({ destPath: plan.destPath, backupPath: bak });
    }
    fs.copyFileSync(path.join(sourceRoot, plan.zipPath), plan.destPath);
  }
  return backups;
};

const main = () => {
  const repoRoot = process.cwd();
  const agentDir = path.resolve(
    process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  );
  const teachRoot =
    process.env.TEACH_ROOT === undefined
      ? path.join(os.homedir(), "work")
      : process.env.TEACH_ROOT === ""
        ? ""
        : path.resolve(process.env.TEACH_ROOT);
  const dryRun = process.env.DRY_RUN === "1";
  const noBackup = process.env.NO_BACKUP === "1";

  const input = resolveInput(process.env.ZIP, repoRoot);
  let entries;
  if (input.kind === "zip") {
    entries = listZipEntries(input.path);
    if (!entries.some((e) => e.startsWith("pi-kit-settings/"))) {
      fail(
        `${input.path} contains no pi-kit-settings/ entries (not a package-settings artifact).`,
      );
    }
  } else {
    entries = listDirEntries(input.path);
  }

  const { plans, skipped } = planRestore({
    entries,
    agentDir,
    repoRoot,
    teachRoot,
  });
  console.log(renderRestorePlan({ plans, skipped }));

  if (dryRun) {
    console.log("[dry-run] nothing written.");
    return;
  }

  if (plans.length === 0) {
    fail(
      "No restorable files found in the input (only meta files / skipped entries). Nothing to do.",
    );
  }

  const ts = formatTimestamp();
  const tempDir =
    input.kind === "zip"
      ? fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-restore-"))
      : null;
  try {
    if (tempDir) {
      execFileSync("unzip", ["-q", input.path], {
        cwd: tempDir,
        stdio: "inherit",
      });
    }
    const backups = applyPlan(plans, tempDir ?? input.path, { noBackup, ts });

    console.log(`==> restored ${plans.length} file(s)`);
    if (backups.length > 0) {
      console.log(
        `==> backups: ${backups.length} (e.g. ${backups[0].backupPath})`,
      );
    }
    if (
      plans.some((p) => p.zipPath.includes("third_extension_settings.json"))
    ) {
      console.log(
        "⚠  restored third_extension_settings.json may contain sensitive data " +
          "(e.g. remoteApproval botToken/chatId) — keep the zip private.",
      );
    }
    console.log(
      "==> activate with /reload inside pi, or restart the pi session.",
    );
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
