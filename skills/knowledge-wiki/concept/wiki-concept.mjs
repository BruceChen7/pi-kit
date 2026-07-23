/**
 * wiki-concept.mjs
 *
 * Mechanically manages wiki concept files so skills never have to construct
 * wikilinks containing file paths by hand.
 *
 * Usage:
 *   node scripts/wiki/wiki-concept.mjs create <slug> <display-name> [--type <Concept|Synthesis>] [--icon <note|notepad>] [--tags <JSON-array>]
 *     Pipe body content via stdin to create a fully populated concept file.
 *     Without stdin, creates a skeleton (frontmatter + title + empty Sources).
 *   node scripts/wiki/wiki-concept.mjs insert-source <slug> <summary-path>
 *   node scripts/wiki/wiki-concept.mjs delete-source <slug> <summary-path>
 *   node scripts/wiki/wiki-concept.mjs insert-connected-concept <slug> <linked-slug> <display-name>
 *   node scripts/wiki/wiki-concept.mjs delete-connected-concept <slug> <linked-slug>
 *
 * --base-path can be added at any position to override the KNOWLEDGE_DIR.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONCEPTS_DIR,
  conceptFullPath,
  conceptRelPath,
  KNOWLEDGE_DIR,
} from "./lib/paths.mjs";
import {
  deleteBulletFromSection,
  insertBulletInSection,
  sectionContains,
} from "./lib/sections.mjs";

process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

function readConcept(slug) {
  const filePath = conceptFullPath(slug);
  if (!fs.existsSync(filePath)) {
    console.error(`Concept file not found: ${filePath}`);
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeConcept(slug, content) {
  fs.writeFileSync(conceptFullPath(slug), content, "utf8");
}

// ── Pure: build concept file content ─────────────────────────────────────

/**
 * Build the full content of a concept markdown file.
 *
 * Pure function — no IO, no side effects. Returns the string that should
 * be written to the concept file. Can be tested without mocking the
 * filesystem or stdin.
 *
 * When `body` is empty, produces a skeleton (frontmatter + title + empty
 * Sources section). When `body` is provided, it is inserted between the
 * title and Sources.
 *
 * @param {object} params
 * @param {string} params.displayName - Human-readable concept name
 * @param {string} params.type - "Concept" or "Synthesis"
 * @param {string} params.icon - Frontmatter _icon value
 * @param {string} params.tags - JSON array string like '["tag1","tag2"]'
 * @param {string} params.body - Markdown body content (empty string for skeleton)
 * @returns {string} Full concept file content
 */
export function buildConceptContent({ displayName, type, icon, tags, body }) {
  const parts = [
    "---",
    `type: ${type}`,
    `_icon: ${icon}`,
    `tags: ${tags}`,
    "---",
    "",
    `# ${displayName}`,
  ];

  if (body) {
    parts.push("", body);
  }

  parts.push("", "## Sources", "");
  return parts.join("\n");
}

// --- Subcommands ---

function cmdCreate(args) {
  const slug = args[0];
  const displayName = args[1];
  if (!slug || !displayName) {
    console.error(
      "Usage: node scripts/wiki/wiki-concept.mjs create <slug> <display-name> [--type <Concept|Synthesis>] [--icon <note|notepad>] [--tags <JSON-array>]",
    );
    process.exit(1);
  }

  const typeIdx = args.indexOf("--type");
  const iconIdx = args.indexOf("--icon");
  const tagsIdx = args.indexOf("--tags");
  const type =
    typeIdx !== -1 && args[typeIdx + 1] ? args[typeIdx + 1] : "Concept";
  const icon = iconIdx !== -1 && args[iconIdx + 1] ? args[iconIdx + 1] : "note";
  const tags = tagsIdx !== -1 && args[tagsIdx + 1] ? args[tagsIdx + 1] : "[]";

  if (fs.existsSync(conceptFullPath(slug))) {
    console.error(`Concept file already exists: ${conceptRelPath(slug)}`);
    console.error(
      "Use insert-source / insert-connected-concept to modify existing concepts.",
    );
    process.exit(1);
  }

  fs.mkdirSync(CONCEPTS_DIR, { recursive: true });

  // Read body content from stdin when data is piped (non-TTY stdin).
  // This allows the caller to pipe body text: `echo "body" | node ... create ...`
  // or redirect from a temp file: `node ... create ... < temp-body-file`
  let body = "";
  if (!process.stdin.isTTY) {
    const piped = fs.readFileSync(0, "utf8").trimEnd();
    if (piped) body = piped;
  }

  const content = buildConceptContent({
    displayName,
    type,
    icon,
    tags,
    body,
  });

  fs.writeFileSync(conceptFullPath(slug), content, "utf8");
  console.log(conceptRelPath(slug));
}

function cmdInsertSource(args) {
  const [slug, summaryPath] = args;
  if (!slug || !summaryPath) {
    console.error(
      "Usage: node scripts/wiki/wiki-concept.mjs insert-source <slug> <summary-path>",
    );
    process.exit(1);
  }

  const summaryFile = path.join(KNOWLEDGE_DIR, `${summaryPath}.md`);
  if (!fs.existsSync(summaryFile)) {
    console.error(`Error: summary file not found: ${summaryPath}.md`);
    process.exit(1);
  }

  const link = `[[${summaryPath}]]`;
  const content = readConcept(slug);

  if (sectionContains(content, "Sources", link)) {
    console.log(`Already present in ${slug}: ${summaryPath}`);
    return;
  }

  const updated = insertBulletInSection(content, "Sources", `- ${link}`);
  writeConcept(slug, updated);
  console.log(`Inserted source into ${slug}.`);
}

function cmdDeleteSource(args) {
  const [slug, summaryPath] = args;
  if (!slug || !summaryPath) {
    console.error(
      "Usage: node scripts/wiki/wiki-concept.mjs delete-source <slug> <summary-path>",
    );
    process.exit(1);
  }

  const link = `[[${summaryPath}]]`;
  const content = readConcept(slug);
  const { content: updated, found } = deleteBulletFromSection(
    content,
    "Sources",
    (line) => line.includes(link),
  );

  if (!found) {
    console.log(`Not found in ${slug}: ${summaryPath}`);
    return;
  }

  writeConcept(slug, updated);
  console.log(`Deleted source from ${slug}.`);
}

function cmdInsertConnectedConcept(args) {
  const [slug, linkedSlug, displayName] = args;
  if (!slug || !linkedSlug || !displayName) {
    console.error(
      "Usage: node scripts/wiki/wiki-concept.mjs insert-connected-concept <slug> <linked-slug> <display-name>",
    );
    process.exit(1);
  }

  if (linkedSlug === slug) {
    console.log(`Self-reference skipped: ${slug} → ${linkedSlug}`);
    return;
  }

  const link = `[[Wiki/Concepts/${linkedSlug}|${displayName}]]`;
  const content = readConcept(slug);

  if (
    sectionContains(
      content,
      "Connected Concepts",
      `[[Wiki/Concepts/${linkedSlug}|`,
    )
  ) {
    console.log(`Already present in ${slug}: ${linkedSlug}`);
    return;
  }

  const updated = insertBulletInSection(
    content,
    "Connected Concepts",
    `- ${link}`,
    { insertBefore: "Sources" },
  );
  writeConcept(slug, updated);
  console.log(`Inserted connected concept into ${slug}.`);
}

function cmdDeleteConnectedConcept(args) {
  const [slug, linkedSlug] = args;
  if (!slug || !linkedSlug) {
    console.error(
      "Usage: node scripts/wiki/wiki-concept.mjs delete-connected-concept <slug> <linked-slug>",
    );
    process.exit(1);
  }

  const linkWithAlias = `[[Wiki/Concepts/${linkedSlug}|`;
  const linkBare = `[[Wiki/Concepts/${linkedSlug}]]`;
  const content = readConcept(slug);
  const { content: updated, found } = deleteBulletFromSection(
    content,
    "Connected Concepts",
    (line) => line.includes(linkWithAlias) || line.includes(linkBare),
  );

  if (!found) {
    console.log(`Not found in ${slug}: ${linkedSlug}`);
    return;
  }

  writeConcept(slug, updated);
  console.log(`Deleted connected concept from ${slug}.`);
}

// --- Dispatch ---

// ── Dispatch (guarded: runs only when this file is the entry point) ─────

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , subcommand, ...rest] = process.argv;

  switch (subcommand) {
    case "create":
      cmdCreate(rest);
      break;
    case "insert-source":
      cmdInsertSource(rest);
      break;
    case "delete-source":
      cmdDeleteSource(rest);
      break;
    case "insert-connected-concept":
      cmdInsertConnectedConcept(rest);
      break;
    case "delete-connected-concept":
      cmdDeleteConnectedConcept(rest);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error(
        "Subcommands: create, insert-source, delete-source, insert-connected-concept, delete-connected-concept",
      );
      process.exit(1);
  }
}
