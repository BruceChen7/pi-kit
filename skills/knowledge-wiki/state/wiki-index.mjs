/**
 * wiki-index.mjs
 *
 * Reads and writes the knowledge base index files:
 *   - Wiki/index.md             (main index: Archive + Concepts + Summaries)
 *   - Wiki/index-<year>.md      (per-year DailyNotes shards)
 *
 * DailyNotes summaries are routed by path year into their shard:
 *   Wiki/Summaries/Calendar/DailyNotes/<year>/... → Wiki/index-<year>.md
 * Everything else (Notes/, Concepts, non-year DailyNotes entries) → Wiki/index.md
 *
 * Skills should call this instead of reading the whole file and writing it back.
 *
 * Usage:
 *   node scripts/wiki/wiki-index.mjs sort
 *   node scripts/wiki/wiki-index.mjs read-concepts
 *   node scripts/wiki/wiki-index.mjs read-summaries [--all]
 *   node scripts/wiki/wiki-index.mjs upsert-concept <slug> "<display-name>" "<description>"
 *   node scripts/wiki/wiki-index.mjs delete-concept <slug>
 *   node scripts/wiki/wiki-index.mjs upsert-summary "<rel-path>" "<description>"
 *   node scripts/wiki/wiki-index.mjs delete-summary "<rel-path>"
 *   node scripts/wiki/wiki-index.mjs find-missing-summaries
 *   node scripts/wiki/wiki-index.mjs find-missing-concepts
 *   node scripts/wiki/wiki-index.mjs delete-dead-links
 *   node scripts/wiki/wiki-index.mjs split-daily-shards
 *
 * --base-path can be added at any position to override the KNOWLEDGE_DIR.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INDEX_PATH,
  KNOWLEDGE_DIR,
  SUMMARIES_DIR,
  WIKI_DIR,
} from "./lib/paths.mjs";
import { getBulletsFromSection } from "./lib/sections.mjs";

process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

const CONCEPT_RE = /^- \[\[Wiki\/Concepts\/([^|]+)\|([^\]]+)\]\] — (.+)$/;
const SUMMARY_RE = /^- \[\[Wiki\/Summaries\/((?:[^\]]|\](?!\]))+)\]\] — (.+)$/;

/** DailyNotes summary rel-paths that belong in a per-year shard. */
const DAILY_SHARD_RE = /^Calendar\/DailyNotes\/(\d{4})\//;

// ── Pure: shard routing & bullet editing ──────────────────────────────────

/**
 * Route a summary rel-path to its index target.
 *
 * Pure — value in / value out. Testable with table tests.
 *
 * @param relPath - Summary rel-path (e.g. `Calendar/DailyNotes/2026/2026-07-06`
 *                  or `Notes/redis`).
 * @returns `{ type: "shard", year }` for DailyNotes paths with a 4-digit year
 *          subdirectory; `{ type: "main" }` for everything else (Notes/,
 *          Concepts, or DailyNotes entries without a year subdirectory).
 */
export function resolveIndexTarget(relPath) {
  const m = DAILY_SHARD_RE.exec(relPath);
  return m ? { type: "shard", year: m[1] } : { type: "main" };
}

/**
 * Absolute path of a per-year shard index file.
 *
 * `wikiDir` defaults to the module-resolved Wiki/ directory; callers (and
 * tests) can pass an explicit wiki directory to avoid import-time
 * environment coupling.
 */
export function shardIndexPath(year, wikiDir = WIKI_DIR) {
  return path.join(wikiDir, `index-${year}.md`);
}

/**
 * Years of all existing shard files (`Wiki/index-<year>.md`), sorted ascending.
 * Used to render the Archive section and to iterate shards for lint/sort.
 */
export function listShardYears(wikiDir = WIKI_DIR) {
  if (!existsSync(wikiDir)) return [];
  const years = [];
  for (const entry of readdirSync(wikiDir, { withFileTypes: true })) {
    const m = /^index-(\d{4})\.md$/.exec(entry.name);
    if (entry.isFile() && m) years.push(m[1]);
  }
  return years.sort((a, b) => a - b);
}

/**
 * Partition summary bullets into per-year shard buckets and main-index kept lines.
 *
 * Pure — value in / value out, no IO. Testable with table tests.
 *
 * @param summaryLines - Summary bullets from the main index's `## Summaries` section.
 * @returns `{ shards: Map<year, bullet[]>, kept: bullet[] }`.
 */
export function partitionShardLines(summaryLines) {
  const shards = new Map();
  const kept = [];
  for (const line of summaryLines) {
    const m = DAILY_SHARD_RE.exec(SUMMARY_RE.exec(line)?.[1] ?? "");
    if (m) {
      if (!shards.has(m[1])) shards.set(m[1], []);
      shards.get(m[1]).push(line);
    } else {
      kept.push(line);
    }
  }
  return { shards, kept };
}

/**
 * Insert or update a summary bullet in a list of summary lines.
 *
 * Pure — returns a new array, does not mutate the input.
 *
 * @param lines - Existing summary bullets.
 * @param relPath - Summary rel-path to match.
 * @param newLine - Bullet to insert or replace with.
 * @returns `{ lines, action: "inserted" | "updated" }`.
 */
export function upsertBullet(lines, relPath, newLine) {
  const idx = lines.findIndex((l) => SUMMARY_RE.exec(l)?.[1] === relPath);
  if (idx === -1) return { lines: [...lines, newLine], action: "inserted" };
  const next = [...lines];
  next[idx] = newLine;
  return { lines: next, action: "updated" };
}

/**
 * Remove a summary bullet by rel-path.
 *
 * Pure — returns a new array, does not mutate the input.
 *
 * @returns `{ lines, found: boolean }`; `lines` is the input when not found.
 */
export function deleteBullet(lines, relPath) {
  const idx = lines.findIndex((l) => SUMMARY_RE.exec(l)?.[1] === relPath);
  if (idx === -1) return { lines, found: false };
  const next = [...lines];
  next.splice(idx, 1);
  return { lines: next, found: true };
}

// ── Index file IO ─────────────────────────────────────────────────────────

/**
 * Read sections from an index file.
 *
 * The main index carries `## Concepts` + `## Summaries`; shard files carry
 * only `## Summaries`.
 *
 * @param filePath - Absolute path of the index file.
 * @param requireConcepts - True for the main index (must contain Concepts).
 */
function parseIndexFile(filePath, requireConcepts) {
  if (!existsSync(filePath)) {
    return requireConcepts
      ? { concepts: [], summaries: [] }
      : { summaries: [] };
  }

  const text = readFileSync(filePath, "utf8");
  const summaries = getBulletsFromSection(text, "Summaries");
  if (summaries === null)
    throw new Error(`## Summaries section not found in ${filePath}`);
  if (!requireConcepts) return { summaries };

  const concepts = getBulletsFromSection(text, "Concepts");
  if (concepts === null)
    throw new Error(`## Concepts section not found in ${filePath}`);
  return { concepts, summaries };
}

/** Read the main index (Concepts + Summaries). */
function parseIndex() {
  return parseIndexFile(INDEX_PATH, true);
}

/** Read the summary bullets of a shard (empty when the shard file does not exist yet). */
function readShardSummaries(year) {
  return parseIndexFile(shardIndexPath(year), false).summaries;
}

function conceptSortKey(line) {
  return (CONCEPT_RE.exec(line)?.[2] ?? line).toLowerCase();
}

function summarySortKey(line) {
  return (SUMMARY_RE.exec(line)?.[1] ?? line).toLowerCase();
}

/**
 * Render the main index content: title + Archive (per-year shard links) + Concepts + Summaries.
 * Pure — no IO.
 */
export function renderIndexContent(concepts, summaries, archiveYears) {
  const sortedConcepts = [...concepts].sort((a, b) =>
    conceptSortKey(a).localeCompare(conceptSortKey(b)),
  );
  const sortedSummaries = [...summaries].sort((a, b) =>
    summarySortKey(a).localeCompare(summarySortKey(b)),
  );
  const archiveLines = archiveYears.map((y) => `- [[Wiki/index-${y}|${y}]]`);

  return [
    "# Knowledge Base Index",
    "",
    "## Archive",
    "",
    ...archiveLines,
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
}

/** Render a per-year DailyNotes shard: title + Summaries. Pure — no IO. */
export function renderShardContent(year, summaries) {
  const sorted = [...summaries].sort((a, b) =>
    summarySortKey(a).localeCompare(summarySortKey(b)),
  );
  return [
    `# Daily Notes Index ${year}`,
    "",
    "## Summaries",
    "",
    ...sorted,
    "",
  ].join("\n");
}

/** Write the main index (render + IO). */
function writeIndex(concepts, summaries) {
  const content = renderIndexContent(concepts, summaries, listShardYears());
  mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, content, "utf8");
}

/** Write a per-year DailyNotes shard (render + IO). */
function writeShard(year, summaries) {
  const filePath = shardIndexPath(year);
  const content = renderShardContent(year, summaries);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
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
      let summaryTotal = summaries.length;
      for (const year of listShardYears()) {
        const { summaries: shardSummaries } = parseIndexFile(
          shardIndexPath(year),
          false,
        );
        writeShard(year, shardSummaries);
        summaryTotal += shardSummaries.length;
      }
      console.log(
        `Sorted ${concepts.length} concepts and ${summaryTotal} summaries.`,
      );
      break;
    }

    case "read-concepts": {
      const { concepts } = parseIndex();
      if (concepts.length > 0) process.stdout.write(`${concepts.join("\n")}\n`);
      break;
    }

    case "read-summaries": {
      const all = args.includes("--all");
      const { summaries } = parseIndex();
      if (all) {
        for (const year of listShardYears()) {
          summaries.push(...readShardSummaries(year));
        }
        summaries.sort((a, b) =>
          summarySortKey(a).localeCompare(summarySortKey(b)),
        );
      }
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

      const newLine = `- [[Wiki/Summaries/${relPath}]] — ${truncated}`;
      const target = resolveIndexTarget(relPath);

      if (target.type === "shard") {
        // ── Per-year shard (DailyNotes) ──
        const shardPath = shardIndexPath(target.year);
        const isNewShard = !existsSync(shardPath);
        const { lines, action } = upsertBullet(
          readShardSummaries(target.year),
          relPath,
          newLine,
        );
        writeShard(target.year, lines);
        if (isNewShard) {
          // First entry for this year: the main index's Archive section is
          // rendered from listShardYears() at the last writeIndex, so a
          // brand-new shard is not yet linked. Refresh the main index.
          const { concepts, summaries } = parseIndex();
          writeIndex(concepts, summaries);
        }
        console.log(
          `${action === "inserted" ? "Inserted" : "Updated"} summary '${relPath}' in Wiki/index-${target.year}.md.`,
        );
      } else {
        // ── Main index ──
        const { concepts, summaries } = parseIndex();
        const { lines, action } = upsertBullet(summaries, relPath, newLine);
        writeIndex(concepts, lines);
        console.log(
          `${action === "inserted" ? "Inserted" : "Updated"} summary '${relPath}'.`,
        );
      }
      break;
    }

    case "delete-summary": {
      const [relPath] = args;
      if (!relPath) {
        console.error("Usage: delete-summary <rel-path>");
        process.exit(1);
      }
      const target = resolveIndexTarget(relPath);

      if (target.type === "shard") {
        const { lines, found } = deleteBullet(
          readShardSummaries(target.year),
          relPath,
        );
        if (!found) {
          console.error(`Error: summary '${relPath}' not found.`);
          process.exit(1);
        }
        writeShard(target.year, lines);
        console.log(
          `Deleted summary '${relPath}' from Wiki/index-${target.year}.md.`,
        );
      } else {
        const { concepts, summaries } = parseIndex();
        const { lines, found } = deleteBullet(summaries, relPath);
        if (!found) {
          console.error(`Error: summary '${relPath}' not found.`);
          process.exit(1);
        }
        writeIndex(concepts, lines);
        console.log(`Deleted summary '${relPath}'.`);
      }
      break;
    }

    case "find-missing-summaries": {
      const summariesDir = path.join(KNOWLEDGE_DIR, "Wiki", "Summaries");
      const indexed = new Set();

      const { summaries } = parseIndex();
      for (const l of summaries) {
        const relPath = SUMMARY_RE.exec(l)?.[1];
        if (relPath) indexed.add(relPath);
      }
      for (const year of listShardYears()) {
        const { summaries: shardSummaries } = parseIndexFile(
          shardIndexPath(year),
          false,
        );
        for (const l of shardSummaries) {
          const relPath = SUMMARY_RE.exec(l)?.[1];
          if (relPath) indexed.add(relPath);
        }
      }

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
      const deletedConcepts = [];
      const deletedSummaries = [];

      // ── Main index ──
      const { concepts, summaries } = parseIndex();

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

      // ── Per-year shards ──
      for (const year of listShardYears()) {
        const { summaries: shardSummaries } = parseIndexFile(
          shardIndexPath(year),
          false,
        );
        const keptShard = shardSummaries.filter((l) => {
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
        if (keptShard.length !== shardSummaries.length) {
          writeShard(year, keptShard);
        }
      }

      console.log(
        JSON.stringify({
          concepts: deletedConcepts.length,
          summaries: deletedSummaries.length,
        }),
      );
      break;
    }

    case "split-daily-shards": {
      // ── One-time migration: split DailyNotes entries out of the main index ──
      const { concepts, summaries } = parseIndex();
      const { shards, kept } = partitionShardLines(summaries);

      if (shards.size === 0) {
        console.log("no-op: no DailyNotes entries in the index.");
        break;
      }

      // Backup the original main index before mutating anything. Include the
      // time in the name so a same-day re-run cannot overwrite the
      // pre-migration copy (index.md.bak-YYYYMMDDTHHMMSS).
      const backupName = `index.md.bak-${new Date()
        .toISOString()
        .slice(0, 19)
        .replaceAll("-", "")
        .replaceAll(":", "")}`;
      copyFileSync(INDEX_PATH, path.join(WIKI_DIR, backupName));

      for (const [year, lines] of shards) {
        writeShard(year, lines);
      }
      writeIndex(concepts, kept);

      console.log(
        JSON.stringify({
          years: Object.fromEntries([...shards].map(([y, l]) => [y, l.length])),
          kept: kept.length,
          backup: backupName,
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
          "  split-daily-shards",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
}
