/**
 * wiki-summary.mjs
 *
 * Mechanically manages wiki summary files so skills never have to construct
 * frontmatter or backlinks by hand.
 *
 * Usage:
 *   node scripts/wiki/wiki-summary.mjs list-stale
 *   node scripts/wiki/wiki-summary.mjs create <source-path> [--at <ISO timestamp>]
 *   node scripts/wiki/wiki-summary.mjs delete-concept <summary-rel-path> <concept-slug>
 *   node scripts/wiki/wiki-summary.mjs insert-concept <summary-rel-path> <concept-slug> <display-name> <description>
 *
 * --base-path can be added at any position to override the KNOWLEDGE_DIR.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBody } from "./lib/graph.mjs";
import { KNOWLEDGE_DIR } from "./lib/paths.mjs";
import {
  deleteBulletFromSection,
  insertBulletInSection,
} from "./lib/sections.mjs";

process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

const EXCLUDE = [
  "Wiki/",
  "Types/",
  "*/README.md",
  "*/README.zh-CN.md",
  "*/README.zh-TW.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/",
  ".codex/",
  ".planning/",
  ".clawpatch/",
  ".git/",
  "node_modules/",
  ".pi/",
  "TODO/",
];

function isExcluded(relPath, isDir) {
  const key = isDir ? `${relPath}/` : relPath;
  return EXCLUDE.some((pattern) => {
    if (pattern.startsWith("*/"))
      return path.basename(key) === pattern.slice(2);
    return key === pattern || key.startsWith(pattern);
  });
}

function parseFrontmatterField(content, field) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const frontmatter = content.slice(4, end);
  const match = frontmatter.match(
    new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"),
  );
  return match ? match[1].trim() : null;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function findMarkdownFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(KNOWLEDGE_DIR, fullPath);
    if (entry.isDirectory()) {
      if (isExcluded(relPath, true)) continue;
      findMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      if (isExcluded(relPath, false)) continue;
      results.push(relPath);
    }
  }
  return results;
}

function summaryRelFor(sourceRel) {
  return path.join(
    "Wiki",
    "Summaries",
    sourceRel.replace(/\.(md|markdown)$/i, ".summary.md"),
  );
}

function cmdListStale() {
  const sources = [];
  for (const relPath of findMarkdownFiles(KNOWLEDGE_DIR)) {
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, relPath), "utf8");
    const hash = sha256(extractBody(content));
    const summaryFull = path.join(KNOWLEDGE_DIR, summaryRelFor(relPath));

    let stale = false;
    if (!fs.existsSync(summaryFull)) {
      stale = true;
    } else {
      const storedHash = parseFrontmatterField(
        fs.readFileSync(summaryFull, "utf8"),
        "hash",
      );
      if (storedHash !== hash) stale = true;
    }
    if (stale) sources.push(relPath);
  }
  console.log(JSON.stringify({ sources }, null, 2));
}

function cmdCreate(args) {
  const sourceRel = args[0];
  if (!sourceRel) {
    console.error(
      "Usage: node scripts/wiki/wiki-summary.mjs create <source-path> [--at <ISO timestamp>]",
    );
    process.exit(1);
  }

  const atIdx = args.indexOf("--at");
  const timestamp =
    atIdx !== -1 && args[atIdx + 1]
      ? args[atIdx + 1]
      : new Date().toISOString();
  const tagsIdx = args.indexOf("--tags");
  const tags = tagsIdx !== -1 && args[tagsIdx + 1] ? args[tagsIdx + 1] : "[]";

  const srcFull = path.join(KNOWLEDGE_DIR, sourceRel);
  if (!fs.existsSync(srcFull)) {
    console.error(`Source file not found: ${srcFull}`);
    process.exit(1);
  }

  const hash = sha256(extractBody(fs.readFileSync(srcFull, "utf8")));
  const summaryRel = summaryRelFor(sourceRel);
  const summaryFull = path.join(KNOWLEDGE_DIR, summaryRel);

  fs.mkdirSync(path.dirname(summaryFull), { recursive: true });

  const backlinkTarget = sourceRel.replace(/\.(md|markdown)$/i, "");
  const backlinksSection = `## Backlinks\n\n- Source file: [[${backlinkTarget}]]\n`;

  const body = fs.readFileSync(0, "utf8").trimEnd();
  if (!body) {
    console.error("Body is required: pipe content via temp file");
    process.exit(1);
  }

  const content = [
    "---",
    `source: ${sourceRel}`,
    `hash: ${hash}`,
    `summarized_at: ${timestamp}`,
    "type: Summary",
    "_icon: gear",
    `tags: ${tags}`,
    "---",
    "",
    body,
    "",
    backlinksSection,
  ].join("\n");

  fs.writeFileSync(summaryFull, content, "utf8");
  console.log(summaryRel);
}

function cmdDeleteConcept(args) {
  let relPath, slug;
  if (args[0] === "-") {
    const lines = fs
      .readFileSync(0, "utf8")
      .split("\n")
      .map((l) => l.trimEnd());
    [relPath, slug] = lines;
  } else {
    [relPath, slug] = args;
  }
  if (!relPath || !slug) {
    console.error(
      "Usage: node scripts/wiki/wiki-summary.mjs delete-concept - | <summary-rel-path> <concept-slug>",
    );
    process.exit(1);
  }

  const summaryFull = path.join(KNOWLEDGE_DIR, relPath);
  if (!fs.existsSync(summaryFull)) {
    console.error(`Summary file not found: ${summaryFull}`);
    process.exit(1);
  }

  const content = fs.readFileSync(summaryFull, "utf8");
  const entryRe = /^- \[\[Wiki\/Concepts\/([^\]|]+)(?:\|[^\]]+)?\]\]/;
  const { content: updated, found } = deleteBulletFromSection(
    content,
    "Key Concepts",
    (line) => {
      const m = entryRe.exec(line);
      return m !== null && m[1] === slug;
    },
  );

  if (!found) {
    console.log(`Not found in ${relPath}: ${slug}`);
    return;
  }

  fs.writeFileSync(summaryFull, updated, "utf8");
  console.log(`Deleted concept from ${relPath}: ${slug}`);
}

function cmdInsertConcept(args) {
  let relPath, slug, displayName, description;

  if (args[0] === "-") {
    const lines = fs
      .readFileSync(0, "utf8")
      .split("\n")
      .map((l) => l.trimEnd());
    relPath = lines[0];
    slug = lines[1];
    displayName = lines[2];
    description = lines.slice(3).filter(Boolean).join(" ").trim();
  } else {
    [relPath, slug, displayName] = args;
    const rawDescription = args[3];
    description =
      rawDescription === "-"
        ? fs.readFileSync(0, "utf8").replace(/\r?\n/g, " ").trim()
        : rawDescription;
  }

  if (!relPath || !slug || !displayName || !description) {
    console.error(
      "Usage: node scripts/wiki/wiki-summary.mjs insert-concept - | <summary-rel-path> <concept-slug> <display-name> <description|->\n  Use - as first arg to read all fields from stdin; or pass - as 4th arg to read only the description.",
    );
    process.exit(1);
  }

  const summaryFull = path.join(KNOWLEDGE_DIR, relPath);
  if (!fs.existsSync(summaryFull)) {
    console.error(`Summary file not found: ${summaryFull}`);
    process.exit(1);
  }

  const content = fs.readFileSync(summaryFull, "utf8");
  const entryRe = /^- \[\[Wiki\/Concepts\/([^\]|]+)(?:\|[^\]]+)?\]\]/;
  let inKeyC = false;
  let alreadyPresent = false;
  for (const line of content.split("\n")) {
    if (line === "## Key Concepts") {
      inKeyC = true;
      continue;
    }
    if (inKeyC && line.startsWith("## ")) break;
    if (!inKeyC) continue;
    const m = entryRe.exec(line);
    if (m && m[1] === slug) {
      alreadyPresent = true;
      break;
    }
  }

  if (alreadyPresent) {
    console.log(`Already present in ${relPath}: ${slug}`);
    return;
  }

  const bullet = `- [[Wiki/Concepts/${slug}|${displayName}]] — ${description}`;
  const updated = insertBulletInSection(content, "Key Concepts", bullet);
  fs.writeFileSync(summaryFull, updated, "utf8");
  console.log(`Inserted concept into ${relPath}: ${slug}`);
}

// ── Dispatch (guarded: runs only when this file is the entry point) ─────

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , subcommand, ...rest] = process.argv;

  switch (subcommand) {
    case "list-stale":
      cmdListStale();
      break;
    case "create":
      cmdCreate(rest);
      break;
    case "delete-concept":
      cmdDeleteConcept(rest);
      break;
    case "insert-concept":
      cmdInsertConcept(rest);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error(
        "Subcommands: list-stale, create, delete-concept, insert-concept",
      );
      process.exit(1);
  }
}
