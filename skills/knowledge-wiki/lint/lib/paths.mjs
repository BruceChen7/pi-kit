import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the knowledge base root directory.
 *
 * Priority:
 *   1. --base-path <dir> from process.argv (any position)
 *   2. If CWD has a Wiki/ directory, use CWD (common when invoked from the KB repo)
 *   3. Otherwise throw a descriptive error
 */
function resolveKnowledgeDir() {
  const argvBaseIdx = process.argv.indexOf("--base-path");
  if (argvBaseIdx !== -1 && process.argv[argvBaseIdx + 1]) {
    return path.resolve(process.argv[argvBaseIdx + 1]);
  }

  // Fallback: check if CWD looks like a knowledge base root (has Wiki/)
  const cwd = process.cwd();
  try {
    if (
      fs.existsSync(path.join(cwd, "Wiki")) &&
      fs.statSync(path.join(cwd, "Wiki")).isDirectory()
    ) {
      return cwd;
    }
  } catch {
    // ignore – fall through to error
  }

  console.error(
    "Error: Could not determine knowledge base root directory.\n" +
      "  Provide --base-path <dir> pointing to the Git repository root\n" +
      "  that contains the Wiki/ directory (e.g. your notes repo).\n",
  );
  process.exit(1);
}

export const KNOWLEDGE_DIR = resolveKnowledgeDir();
export const WIKI_DIR = path.join(KNOWLEDGE_DIR, "Wiki");
export const CONCEPTS_DIR = path.join(WIKI_DIR, "Concepts");
export const SUMMARIES_DIR = path.join(WIKI_DIR, "Summaries");
export const INDEX_PATH = path.join(WIKI_DIR, "index.md");
export const STATE_FILE = path.join(WIKI_DIR, ".state.json");

export function toPosixPath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

export function relToKnowledge(fullPath) {
  return toPosixPath(path.relative(KNOWLEDGE_DIR, fullPath));
}

export function conceptRelPath(slug) {
  return `Wiki/Concepts/${slug}.md`;
}

export function conceptFullPath(slug) {
  return path.join(CONCEPTS_DIR, `${slug}.md`);
}

export function summaryFullPath(relPathWithoutMd) {
  return path.join(SUMMARIES_DIR, `${relPathWithoutMd}.md`);
}
