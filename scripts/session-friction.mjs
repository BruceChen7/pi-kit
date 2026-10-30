#!/usr/bin/env node
/**
 * Count pi-kit friction signatures across local pi session logs.
 *
 * The count that matters is `marked errors`: tool results that carry
 * `"isError":true`. A signature with many lines but few marked errors is a
 * failure the model was never told about (see
 * `.pi/research/2026-10-30-extensions-friction-retro.md`, F4).
 *
 * Usage:
 *   node scripts/session-friction.mjs [--days 7] [--sessions DIR] [--by-repo] [--json]
 *
 * Exit: 0 always when the scan ran, 2 on a usage/IO error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Owned by extensions/; `read the file first` is a subset of `plan-mode blocked`. */
const SIGNATURES = [
  "plan-mode blocked",
  "read the file first",
  "current phase is read-only",
  "Could not find the exact text in",
  "Plan Mode artifact policy blocked",
  "拦住原因",
  "no pending Plannotator review draft",
  "pass either id or updates",
  "No API key found for",
  "User blocked destructive command",
];

const ERROR_MARKER = '"isError":true';

const parseArgs = (argv) => {
  const options = {
    days: 7,
    sessions: path.join(os.homedir(), ".pi", "agent", "sessions"),
    byRepo: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--by-repo") options.byRepo = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--days") {
      index += 1;
      options.days = Number(argv[index]);
    } else if (arg === "--sessions") {
      index += 1;
      options.sessions = argv[index];
    } else return { error: `unknown argument: ${arg}` };
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    return { error: "--days needs a positive number" };
  }
  if (typeof options.sessions !== "string" || options.sessions === "") {
    return { error: "--sessions needs a directory" };
  }
  return { options };
};

const sessionFiles = (root, cutoffMs) => {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      let stats;
      try {
        stats = fs.statSync(full);
      } catch {
        continue;
      }
      if (stats.mtimeMs >= cutoffMs) found.push(full);
    }
  };
  walk(root);
  return found.sort();
};

/** `--Users-ming.chen-work-pi-kit--` → `pi-kit`; anything else → `(other)`. */
const repoOf = (file) => {
  const match = path.basename(path.dirname(file)).match(/^--(.*)--$/);
  if (!match) return "(other)";
  const parts = match[1].split("-");
  const workIndex = parts.indexOf("work");
  return parts.slice(workIndex + 1).join("-") || "(home)";
};

const collect = (files) => {
  const marked = new Map(SIGNATURES.map((signature) => [signature, 0]));
  const mentioned = new Map(SIGNATURES.map((signature) => [signature, 0]));
  const byRepo = new Map();
  let errorResults = 0;
  let unmarkedErrorResults = 0;

  for (const file of files) {
    const repo = repoOf(file);
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const markedError = line.includes(ERROR_MARKER);
      const hits = SIGNATURES.filter((signature) => line.includes(signature));
      if (markedError) {
        errorResults += 1;
        if (hits.length === 0) unmarkedErrorResults += 1;
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1);
      }
      for (const signature of hits) {
        mentioned.set(signature, (mentioned.get(signature) ?? 0) + 1);
        if (markedError) {
          marked.set(signature, (marked.get(signature) ?? 0) + 1);
        }
      }
    }
  }

  return { marked, mentioned, byRepo, errorResults, unmarkedErrorResults };
};

const formatTable = (rows) => {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(
      ([label, first, second]) =>
        `${label.padEnd(width)}  ${String(first).padStart(6)}  ${String(second).padStart(6)}`,
    )
    .join("\n");
};

const { error, options } = parseArgs(process.argv.slice(2));
if (error) {
  console.error(
    `usage: node scripts/session-friction.mjs [--days N] [--sessions DIR] [--by-repo] [--json]\n${error}`,
  );
  process.exit(2);
}

const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
const files = sessionFiles(options.sessions, cutoff);
const { marked, mentioned, byRepo, errorResults, unmarkedErrorResults } =
  collect(files);

const rows = SIGNATURES.map((signature) => [
  signature,
  marked.get(signature) ?? 0,
  mentioned.get(signature) ?? 0,
]).sort((left, right) => right[1] - left[1] || right[2] - left[2]);

if (options.json) {
  console.log(
    JSON.stringify(
      {
        sessions: files.length,
        days: options.days,
        errorResults,
        errorResultsWithoutSignature: unmarkedErrorResults,
        signatures: rows.map(([signature, markedCount, mentionedCount]) => ({
          signature,
          marked: markedCount,
          mentioned: mentionedCount,
        })),
        byRepo: Object.fromEntries(
          [...byRepo].sort((left, right) => right[1] - left[1]),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  `scanned ${files.length} session file(s) from the last ${options.days} day(s) in ${options.sessions}`,
);
console.log(`error-marked tool results: ${errorResults}`);
console.log("");
console.log(formatTable([["signature", "marked", "any line"], ...rows]));
console.log("");
console.log(
  "marked = result carried isError:true; any line = every line that mentions it",
);

if (options.byRepo) {
  const repoRows = [...byRepo]
    .sort((left, right) => right[1] - left[1])
    .map(([repo, count]) => [repo, count, ""]);
  console.log("");
  console.log(formatTable([["repo", "errors", ""], ...repoRows]));
}
