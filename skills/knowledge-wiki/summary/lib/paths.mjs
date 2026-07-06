import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the knowledge base root directory.
 *
 * Priority:
 *   1. --base-path <dir> from process.argv (any position)
 *   2. Three levels up from this file (legacy default: scripts/wiki/lib/ → root)
 */
function resolveKnowledgeDir() {
  const argvBaseIdx = process.argv.indexOf("--base-path");
  if (argvBaseIdx !== -1 && process.argv[argvBaseIdx + 1]) {
    return path.resolve(process.argv[argvBaseIdx + 1]);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
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
