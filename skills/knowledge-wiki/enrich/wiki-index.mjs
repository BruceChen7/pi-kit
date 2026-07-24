/**
 * wiki-index.mjs
 *
 * Reads and writes Wiki/index.md.
 * Skills should call this instead of reading the whole file and writing it back.
 *
 * Usage:
 *   node scripts/wiki/wiki-index.mjs sort
 *   node scripts/wiki/wiki-index.mjs read-concepts
 *   node scripts/wiki/wiki-index.mjs read-summaries
 *   node scripts/wiki/wiki-index.mjs upsert-concept <slug> "<display-name>" "<description>"
 *   node scripts/wiki/wiki-index.mjs delete-concept <slug>
 *   node scripts/wiki/wiki-index.mjs upsert-summary "<rel-path>" "<description>"
 *   node scripts/wiki/wiki-index.mjs delete-summary "<rel-path>"
 *   node scripts/wiki/wiki-index.mjs find-missing-summaries
 *   node scripts/wiki/wiki-index.mjs find-missing-concepts
 *   node scripts/wiki/wiki-index.mjs delete-dead-links
 *
 * --base-path can be added at any position to override the KNOWLEDGE_DIR.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_PATH, KNOWLEDGE_DIR, SUMMARIES_DIR } from "./lib/paths.mjs";
import { getBulletsFromSection } from "./lib/sections.mjs";

process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

const CONCEPT_RE = /^- \[\[Wiki\/Concepts\/([^|]+)\|([^\]]+)\]\] — (.+)$/;
const SUMMARY_RE = /^- \[\[Wiki\/Summaries\/((?:[^\]]|\](?!\]))+)\]\] — (.+)$/;

function parseIndex() {
  if (!existsSync(INDEX_PATH)) {
    return { concepts: [], summaries: [] };
  }

  const text = readFileSync(INDEX_PATH, "utf8");
  const concepts = getBulletsFromSection(text, "Concepts");
  const summaries = getBulletsFromSection(text, "Summaries");

  if (concepts === null)
    throw new Error("## Concepts section not found in Wiki/index.md");
  if (summaries === null)
    throw new Error("## Summaries section not found in Wiki/index.md");

  return { concepts, summaries };
}

function conceptSortKey(line) {
  return (CONCEPT_RE.exec(line)?.[2] ?? line).toLowerCase();
}

function summarySortKey(line) {
  return (SUMMARY_RE.exec(line)?.[1] ?? line).toLowerCase();
}

function writeIndex(concepts, summaries) {
  const sortedConcepts = [...concepts].sort((a, b) =>
    conceptSortKey(a).localeCompare(conceptSortKey(b)),
  );
  const sortedSummaries = [...summaries].sort((a, b) =>
    summarySortKey(a).localeCompare(summarySortKey(b)),
  );

  const content = [
    "# Knowledge Base Index",
    "",
    "## Concepts",
    "",
    ...sortedConcepts,
    "",
    "## Summaries",
    "",
    ...sortedSummaries,
    "",
  ].join("\n");

  mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, content, "utf8");
}

// ── Dispatch (guarded: runs only when this file is the entry point) ─────

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "sort": {
      const { concepts, summaries } = parseIndex();
      writeIndex(concepts, summaries);
      console.log(
        `Sorted ${concepts.length} concepts and ${summaries.length} summaries.`,
      );
      break;
    }

    case "read-concepts": {
      const { concepts } = parseIndex();
      if (concepts.length > 0) process.stdout.write(`${concepts.join("\n")}\n`);
      break;
    }

    case "read-summaries": {
      const { summaries } = parseIndex();
      if (summaries.length > 0)
        process.stdout.write(`${summaries.join("\n")}\n`);
      break;
    }

    case "upsert-concept": {
      const [slug, displayName, ...descParts] = args;
      // Filter out --base-path <value> leaked into trailing description args
      const description = descParts
        .filter(
          (_, i, a) => !(a[i] === "--base-path" || a[i - 1] === "--base-path"),
        )
        .join(" ");
      if (!slug || !displayName || !description) {
        console.error(
          'Usage: upsert-concept <slug> "<display-name>" "<description>"',
        );
        process.exit(1);
      }
      const { concepts, summaries } = parseIndex();
      const idx = concepts.findIndex((l) => CONCEPT_RE.exec(l)?.[1] === slug);
      // Truncate description to prevent ultra-long lines in the index
      const truncated =
        description.length <= 200
          ? description
          : `${description.slice(0, description.lastIndexOf(" ", 197))} …`;
      const newLine = `- [[Wiki/Concepts/${slug}|${displayName}]] — ${truncated}`;
      if (idx === -1) {
        concepts.push(newLine);
        writeIndex(concepts, summaries);
        console.log(`Inserted concept '${slug}'.`);
      } else {
        concepts[idx] = newLine;
        writeIndex(concepts, summaries);
        console.log(`Updated concept '${slug}'.`);
      }
      break;
    }

    case "delete-concept": {
      const [slug] = args;
      if (!slug) {
        console.error("Usage: delete-concept <slug>");
        process.exit(1);
      }
      const { concepts, summaries } = parseIndex();
      const idx = concepts.findIndex((l) => CONCEPT_RE.exec(l)?.[1] === slug);
      if (idx === -1) {
        console.error(`Error: concept '${slug}' not found.`);
        process.exit(1);
      }
      concepts.splice(idx, 1);
      writeIndex(concepts, summaries);
      console.log(`Deleted concept '${slug}'.`);
      break;
    }

    case "upsert-summary": {
      const [relPath, ...descParts] = args;
      // Filter out --base-path <value> leaked into trailing description args
      const description = descParts
        .filter(
          (_, i, a) => !(a[i] === "--base-path" || a[i - 1] === "--base-path"),
        )
        .join(" ");
      if (!relPath || !description) {
        console.error('Usage: upsert-summary "<rel-path>" "<description>"');
        process.exit(1);
      }
      const summaryFile = path.join(SUMMARIES_DIR, `${relPath}.md`);
      if (!existsSync(summaryFile)) {
        console.error(
          `Error: summary file not found: Wiki/Summaries/${relPath}.md`,
        );
        process.exit(1);
      }
      // Truncate description to prevent ultra-long lines in the index.
      // Truncate at 200 chars at word boundary, appending "…" if truncated.
      const truncated =
        description.length <= 200
          ? description
          : `${description.slice(0, description.lastIndexOf(" ", 197))} …`;

      const { concepts, summaries } = parseIndex();
      const idx = summaries.findIndex(
        (l) => SUMMARY_RE.exec(l)?.[1] === relPath,
      );
      const newLine = `- [[Wiki/Summaries/${relPath}]] — ${truncated}`;
      if (idx === -1) {
        summaries.push(newLine);
        writeIndex(concepts, summaries);
        console.log(`Inserted summary '${relPath}'.`);
      } else {
        summaries[idx] = newLine;
        writeIndex(concepts, summaries);
        console.log(`Updated summary '${relPath}'.`);
      }
      break;
    }

    case "delete-summary": {
      const [relPath] = args;
      if (!relPath) {
        console.error('Usage: delete-summary "<rel-path>"');
        process.exit(1);
      }
      const { concepts, summaries } = parseIndex();
      const idx = summaries.findIndex(
        (l) => SUMMARY_RE.exec(l)?.[1] === relPath,
      );
      if (idx === -1) {
        console.error(`Error: summary '${relPath}' not found.`);
        process.exit(1);
      }
      summaries.splice(idx, 1);
      writeIndex(concepts, summaries);
      console.log(`Deleted summary '${relPath}'.`);
      break;
    }

    case "find-missing-summaries": {
      const summariesDir = path.join(KNOWLEDGE_DIR, "Wiki", "Summaries");
      const { summaries } = parseIndex();
      const indexed = new Set(
        summaries.map((l) => SUMMARY_RE.exec(l)?.[1]).filter(Boolean),
      );
      const missing = [];
      if (existsSync(summariesDir)) {
        for (const file of readdirSync(summariesDir, { recursive: true })) {
          if (!file.endsWith(".summary.md")) continue;
          const relPath = file.replaceAll("\\", "/").slice(0, -".md".length);
          if (!indexed.has(relPath)) missing.push(relPath);
        }
      }
      missing.sort();
      console.log(JSON.stringify(missing, null, 2));
      break;
    }

    case "find-missing-concepts": {
      const conceptsDir = path.join(KNOWLEDGE_DIR, "Wiki", "Concepts");
      const { concepts } = parseIndex();
      const indexed = new Set(
        concepts.map((l) => CONCEPT_RE.exec(l)?.[1]).filter(Boolean),
      );
      const missing = [];
      if (existsSync(conceptsDir)) {
        for (const file of readdirSync(conceptsDir)) {
          if (!file.endsWith(".md")) continue;
          const slug = file.slice(0, -".md".length);
          if (!indexed.has(slug)) missing.push(slug);
        }
      }
      missing.sort();
      console.log(JSON.stringify(missing, null, 2));
      break;
    }

    case "delete-dead-links": {
      const { concepts, summaries } = parseIndex();

      const deletedConcepts = [];
      const keptConcepts = concepts.filter((l) => {
        const slug = CONCEPT_RE.exec(l)?.[1];
        if (!slug) return true;
        if (
          existsSync(path.join(KNOWLEDGE_DIR, "Wiki", "Concepts", `${slug}.md`))
        )
          return true;
        deletedConcepts.push(l);
        return false;
      });

      const deletedSummaries = [];
      const keptSummaries = summaries.filter((l) => {
        const relPath = SUMMARY_RE.exec(l)?.[1];
        if (!relPath) return true;
        if (
          existsSync(
            path.join(KNOWLEDGE_DIR, "Wiki", "Summaries", `${relPath}.md`),
          )
        )
          return true;
        deletedSummaries.push(l);
        return false;
      });

      if (deletedConcepts.length > 0 || deletedSummaries.length > 0) {
        writeIndex(keptConcepts, keptSummaries);
      }

      console.log(
        JSON.stringify({
          concepts: deletedConcepts.length,
          summaries: deletedSummaries.length,
        }),
      );
      break;
    }

    default: {
      console.error(
        [
          `Unknown command: ${cmd ?? "(none)"}`,
          "",
          "Commands:",
          "  sort",
          "  read-concepts",
          "  read-summaries",
          '  upsert-concept <slug> "<display-name>" "<description>"',
          "  delete-concept <slug>",
          '  upsert-summary "<rel-path>" "<description>"',
          '  delete-summary "<rel-path>"',
          "  find-missing-summaries",
          "  find-missing-concepts",
          "  delete-dead-links",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
}
