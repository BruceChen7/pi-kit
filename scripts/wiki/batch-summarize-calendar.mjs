#!/usr/bin/env node
/**
 * batch-summarize-calendar.mjs
 *
 * Batch-create summaries for all Calendar/Daily Notes files.
 * Usage: node scripts/wiki/batch-summarize-calendar.mjs --base-path /path/to/knowledge-base
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KNOWLEDGE_DIR = (() => {
  const argvBaseIdx = process.argv.indexOf("--base-path");
  if (argvBaseIdx !== -1 && process.argv[argvBaseIdx + 1]) {
    return path.resolve(process.argv[argvBaseIdx + 1]);
  }
  console.error("Usage: --base-path <knowledge-dir>");
  process.exit(1);
})();

const CALENDAR_DIR = path.join(KNOWLEDGE_DIR, "Calendar", "Daily Notes");
const SUMMARIES_BASE = path.join(
  KNOWLEDGE_DIR,
  "Wiki",
  "Summaries",
  "Calendar",
  "Daily Notes",
);

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function extractBody(content) {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end !== -1) return content.slice(end + 5);
  }
  return content;
}

function parseFrontmatterTags(content) {
  if (!content.startsWith("---\n")) return [];
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return [];
  const frontmatter = content.slice(4, end);

  // Inline format: tags: ["ai/develop", "go/memory"]
  const inlineMatch = frontmatter.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  // List format:
  // tags:
  //   - ai/develop
  //   - go/memory
  const lines = frontmatter.split("\n");
  let inTags = false;
  const tags = [];
  for (const line of lines) {
    if (line.trim() === "tags:") {
      inTags = true;
      continue;
    }
    if (inTags) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        tags.push(trimmed.slice(2).trim());
      } else {
        break;
      }
    }
  }
  return tags;
}

function extractHeadings(body) {
  const headings = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^## (.+)/);
    if (m) headings.push(m[1].trim());
  }
  return headings;
}

function summarizeBody(body, tags, headings) {
  const lines = body
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("---"));
  const meaningfulLines = lines.filter(
    (l) => !l.startsWith("[") && !l.startsWith("!") && !l.match(/^https?:\/\//),
  );
  const firstContent = meaningfulLines
    .slice(0, 20)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

  const parts = [];
  if (tags.length > 0) {
    parts.push(`**Tags:** ${tags.join(", ")}`);
  }
  if (headings.length > 0) {
    parts.push(
      `**Topics:** ${headings.slice(0, 8).join(", ")}${headings.length > 8 ? "..." : ""}`,
    );
  }
  if (firstContent) {
    parts.push(`\n${firstContent}${firstContent.length >= 300 ? "…" : ""}`);
  } else if (lines.length === 0) {
    parts.push("*(Empty daily note)*");
  }
  return parts.join("\n\n");
}

function processFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const relPath = path.relative(KNOWLEDGE_DIR, filePath);
  const body = extractBody(content);
  const hash = sha256(body);
  const tags = parseFrontmatterTags(content);
  const headings = extractHeadings(body);

  // Build summary body
  const summaryBody = summarizeBody(body, tags, headings);

  // Summary relative path (e.g., Calendar/Daily Notes/2026/2026-07-01.summary.md)
  const sourceName = path.basename(filePath).replace(/\.(md|markdown)$/i, "");
  const yearDir = path.basename(path.dirname(filePath));
  const summaryRel = path.join(
    "Calendar",
    "Daily Notes",
    yearDir,
    `${sourceName}.summary.md`,
  );
  const summaryFull = path.join(
    SUMMARIES_BASE,
    yearDir,
    `${sourceName}.summary.md`,
  );

  // Skip if already exists and hash matches
  if (fs.existsSync(summaryFull)) {
    const existing = fs.readFileSync(summaryFull, "utf8");
    const existingHash = (() => {
      if (!existing.startsWith("---\n")) return null;
      const end = existing.indexOf("\n---\n", 4);
      if (end === -1) return null;
      const fm = existing.slice(4, end);
      const m2 = fm.match(/^hash:\s*(.+)$/m);
      return m2 ? m2[1].trim() : null;
    })();
    if (existingHash === hash) {
      return { relPath, status: "skipped (unchanged)" };
    }
  }

  const timestamp = new Date().toISOString();
  const escapedSourceRel = relPath;

  const content_out = [
    "---",
    `source: ${escapedSourceRel}`,
    `hash: ${hash}`,
    `summarized_at: ${timestamp}`,
    "type: Summary",
    "_icon: gear",
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    summaryBody,
    "",
    "## Backlinks",
    "",
    `- Source file: [[Calendar/Daily Notes/${yearDir}/${sourceName}]]`,
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(summaryFull), { recursive: true });
  fs.writeFileSync(summaryFull, content_out, "utf8");
  return { relPath: summaryRel, status: "created" };
}

// Main
if (!fs.existsSync(CALENDAR_DIR)) {
  console.error(`Calendar directory not found: ${CALENDAR_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(CALENDAR_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((yearDir) => {
    const yearPath = path.join(CALENDAR_DIR, yearDir.name);
    return fs
      .readdirSync(yearPath)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(yearPath, f));
  })
  .sort();

let created = 0;
let skipped = 0;
let errors = 0;

for (const filePath of files) {
  try {
    const result = processFile(filePath);
    if (result.status === "created") {
      created++;
    } else {
      skipped++;
    }
  } catch (err) {
    console.error(`Error processing ${filePath}: ${err.message}`);
    errors++;
  }
}

console.log(`Done: ${created} created, ${skipped} skipped, ${errors} errors`);
