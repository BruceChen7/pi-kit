/**
 * knowledge-wiki-daily.ts — Daily knowledge base maintenance task.
 *
 * Pipeline:
 *   Step 1-3: Pi subagent with --prompt-template prompts/wiki-summarize.md
 *             - Phase 1: list-stale
 *             - Phase 2: AI summary generation
 *             - Phase 3: concept linking + auto-create concept files
 *             - Phase 4: verify
 *   Step 4:   qmd update (full-text reindex)
 *   Step 5:   qmd embed (vector embeddings)
 *
 * Knowledge base root: ~/work/notes
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";

// ── Paths ──────────────────────────────────────────────────────────────────

const TASK_DIR = dirname(fileURLToPath(import.meta.url));
const PI_KIT_DIR = resolve(TASK_DIR, "..", "..", "..");
const HOME = homedir();
const KNOWLEDGE_DIR = join(HOME, "work", "notes");

const SUMMARY_SCRIPT = join(
  PI_KIT_DIR,
  "skills",
  "knowledge-wiki",
  "summary",
  "wiki-summary.mjs",
);
const CONCEPT_SCRIPT = join(
  PI_KIT_DIR,
  "skills",
  "knowledge-wiki",
  "concept",
  "wiki-concept.mjs",
);

const PROMPT_TEMPLATE_PATH = join(PI_KIT_DIR, "prompts", "wiki-summarize.md");

const QMD_EMBED_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

// ── Subagent prompt builder ───────────────────────────────────────────────

/**
 * Build the subagent user message (context only).
 *
 * The template itself is loaded by Pi's native --prompt-template mechanism.
 * This message provides the runtime configuration (KB path, script paths)
 * that the agent uses to replace <cwd>, <path-to-wiki-summary.mjs>, etc.
 */
export function buildSubagentPrompt(): string {
  return [
    `## Task Configuration`,
    "",
    `Knowledge base root: ${KNOWLEDGE_DIR}`,
    `wiki-summary.mjs path: ${SUMMARY_SCRIPT}`,
    `wiki-concept.mjs path: ${CONCEPT_SCRIPT}`,
    "",
    "Replace `<cwd>` with the knowledge base root above for all `--base-path` arguments.",
    "Replace `<path-to-wiki-summary.mjs>` with the absolute path above when running node commands.",
    "Replace `<path-to-wiki-concept.mjs>` with the absolute path above when running node commands.",
    "",
    "Proceed through all 4 phases (list-stale → generate summaries → link concepts → verify).",
    "",
    "When complete, output a JSON summary line matching this format:",
    `{"ok": true, "done": "Phase 1: N stale files. Phase 2: N summaries created. Phase 3: N concepts linked."}`,
    `On failure: {"ok": false, "done": "Phase X failed: <reason>"}`,
    "",
    "Begin.",
  ].join("\n");
}

// ── Pure: parse subagent result JSON ──────────────────────────────────────

/**
 * Extract a JSON result block from the subagent's final summary text.
 *
 * The prompt instructs the agent to end with:
 *   { "ok": bool, "done": "..." }
 *
 * Uses balanced brace matching to handle nested JSON if present.
 */
export function parseResultJson(
  summary: string | undefined,
): { ok: boolean; done?: string } | null {
  if (!summary) return null;

  for (let i = 0; i < summary.length; i++) {
    if (summary[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let isEscape = false;
    let j = i;

    for (; j < summary.length; j++) {
      const ch = summary[j];
      if (isEscape) {
        isEscape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        isEscape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) continue;

    try {
      const parsed = JSON.parse(summary.slice(i, j + 1));
      if (typeof parsed.ok === "boolean") {
        return { ok: parsed.ok, done: parsed.done };
      }
    } catch {
      // Not valid JSON, try next {
    }
  }

  return null;
}

// ── Pi agent notification ─────────────────────────────────────────────────

// Uses exec.notify() — the Pi-supported agent notification channel.

// ── Task handler ──────────────────────────────────────────────────────────

export default defineTask({
  id: "knowledge-wiki-daily",
  every: "24h",
  description:
    "每日知识库维护：过期摘要重新生成、概念自动链接、qmd 索引和向量嵌入更新",

  handler: async (exec) => {
    // ── Step 1-3: Pi subagent with wiki-summarize prompt template ──────
    log.info("Step 1-3: subagent — wiki-summarize full pipeline");

    try {
      const prompt = buildSubagentPrompt();
      log.info("subagent prompt", {
        templatePath: PROMPT_TEMPLATE_PATH,
        promptLength: prompt.length,
        knowledgeDir: KNOWLEDGE_DIR,
      });

      const result = await exec.subagent({
        prompt,
        promptTemplatePaths: [PROMPT_TEMPLATE_PATH],
        timeoutMs: 300_000,
      });

      const parsed = parseResultJson(result.summary);
      log.info("subagent completed", {
        exitCode: result.exitCode,
        parsedOk: parsed?.ok,
      });

      if (result.exitCode !== 0 || parsed?.ok === false) {
        const errorMsg =
          parsed?.done ?? result.stderr.slice(0, 500) ?? "unknown error";
        exec.notify("知识库维护失败", `摘要/概念处理出错：${errorMsg}`);
        log.warn("wiki-summarize subagent failed", {
          exitCode: result.exitCode,
          error: errorMsg,
        });
        return;
      }

      log.info("wiki-summarize pipeline completed", { summary: parsed?.done });
    } catch (err) {
      exec.notify(
        "知识库维护异常",
        `subagent 异常：${err instanceof Error ? err.message : String(err)}`,
      );
      log.warn("subagent call threw", { error: String(err) });
      return;
    }

    // ── Step 4: qmd update ──────────────────────────────────────────────
    log.info("Step 4: qmd update");

    try {
      const { code } = await exec.exec("qmd", ["update"]);
      if (code !== 0) {
        exec.notify("知识库维护失败", "qmd update 返回非零退出码");
        log.warn("qmd update failed", { exitCode: code });
        return;
      }
      log.info("qmd update completed");
    } catch (err) {
      exec.notify(
        "知识库维护失败",
        `qmd update 异常：${err instanceof Error ? err.message : String(err)}`,
      );
      log.warn("qmd update threw", { error: String(err) });
      return;
    }

    // ── Step 5: qmd embed ───────────────────────────────────────────────
    log.info("Step 5: qmd embed");

    const prevModel = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = QMD_EMBED_MODEL;

    try {
      const { code } = await exec.exec("qmd", ["embed"]);
      if (code !== 0) {
        exec.notify("知识库维护失败", "qmd embed 返回非零退出码");
        log.warn("qmd embed failed", { exitCode: code });
        return;
      }
      log.info("qmd embed completed");
    } catch (err) {
      exec.notify(
        "知识库维护失败",
        `qmd embed 异常：${err instanceof Error ? err.message : String(err)}`,
      );
      log.warn("qmd embed threw", { error: String(err) });
      return;
    } finally {
      if (prevModel === undefined) {
        delete process.env.QMD_EMBED_MODEL;
      } else {
        process.env.QMD_EMBED_MODEL = prevModel;
      }
    }

    log.info("knowledge-wiki-daily task completed successfully");
  },
});
