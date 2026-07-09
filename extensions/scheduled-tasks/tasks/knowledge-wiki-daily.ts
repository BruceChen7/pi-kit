/**
 * knowledge-wiki-daily.ts — Daily knowledge base maintenance task.
 *
 * Pipeline:
 *   Pre-step: run wiki-summary list-stale to get file list
 *   Step 1-3: Pi subagent with --prompt-template prompts/wiki-summarize.md
 *             - Phase 1: list-stale (from prompt)
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
import { sendTelegramNotification } from "../../shared/telegram.ts";

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
 * Maximum number of stale files to list individually in the prompt.
 * Beyond this, use a count summary to keep prompt length manageable.
 */
const STALE_FILES_PROMPT_LIMIT = 20;

/**
 * Build the subagent user message (context only).
 *
 * The template itself is loaded by Pi's native --prompt-template mechanism.
 * This message provides the runtime configuration (KB path, script paths, stale file list)
 * that the agent uses to replace <cwd>, <path-to-wiki-summary.mjs>, etc.
 *
 * @param staleFiles - List of stale file paths (relative to knowledge base root)
 *                     from the pre-step `list-stale` scan.
 */
export function buildSubagentPrompt(staleFiles: string[]): string {
  const fileList: string[] = [];

  if (staleFiles.length === 0) {
    fileList.push("No stale files found — nothing to update.");
  } else if (staleFiles.length <= STALE_FILES_PROMPT_LIMIT) {
    fileList.push(...staleFiles.map((f) => `  - ${f}`));
  } else {
    fileList.push(
      `  (${staleFiles.length} stale files — listing first ${STALE_FILES_PROMPT_LIMIT})`,
    );
    for (const f of staleFiles.slice(0, STALE_FILES_PROMPT_LIMIT)) {
      fileList.push(`  - ${f}`);
    }
  }

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
    `## Stale Files (${staleFiles.length} total)`,
    "",
    ...fileList,
    "",
    "Proceed through all 4 phases (list-stale → generate summaries → link concepts → verify).",
    "",
    "When complete, output a JSON summary line matching this format:",
    `{"ok": true, "done": "Phase 1: N stale files. Phase 2: N summaries created. Phase 3: N concepts linked.", "summaries": ["Wiki/Summaries/.../file.summary.md", "..."]}`,
    `On failure: {"ok": false, "done": "Phase X failed: <reason>"}`,
    `Include the "summaries" field with the actual relative paths of all summary files created/updated.`,
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
): { ok: boolean; done?: string; summaries?: string[] } | null {
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
        return {
          ok: parsed.ok,
          done: parsed.done,
          summaries: Array.isArray(parsed.summaries)
            ? parsed.summaries
            : undefined,
        };
      }
    } catch {
      // Not valid JSON, try next {
    }
  }

  return null;
}

// ── Stale file listing ────────────────────────────────────────────────────

/**
 * Run `wiki-summary.mjs list-stale` to get the list of stale source files.
 *
 * Returns an array of relative paths (e.g. `["Notes/Foo.md", "Notes/Bar.md"]`).
 * On failure, returns an empty array and logs the error.
 */
async function listStaleFiles(exec: {
  exec: (
    cmd: string,
    args?: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<string[]> {
  try {
    const result = await exec.exec("node", [
      SUMMARY_SCRIPT,
      "list-stale",
      "--base-path",
      KNOWLEDGE_DIR,
    ]);

    if (result.code !== 0) {
      log.warn("list-stale failed", {
        exitCode: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return [];
    }

    const parsed = JSON.parse(result.stdout) as { sources?: string[] };
    if (!Array.isArray(parsed?.sources)) {
      log.warn("list-stale returned unexpected format", {
        stdout: result.stdout.slice(0, 500),
      });
      return [];
    }

    return parsed.sources;
  } catch (err) {
    log.warn("list-stale threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── Telegram message builders ─────────────────────────────────────────────

/**
 * Build a Telegram-safe HTML message for the final success notification.
 *
 * Uses the subagent's `summaries` as the authoritative data source for
 * created/updated summary files. The pre-step `staleFiles` is shown as
 * supplementary context when available.
 *
 * @param staleFiles - Source files that were stale (from pre-step list-stale;
 *                     may be empty if pre-step failed).
 * @param summaries - Summary files actually created/updated (from subagent
 *                    output; authoritative when present).
 * @param wikiSummary - Human-readable summary string from subagent.
 * @param qmdUpdateOk - Whether qmd update succeeded.
 * @param qmdEmbedOk - Whether qmd embed succeeded.
 */
function buildTelegramSuccessMessage(
  staleFiles: string[],
  summaries: string[] | undefined,
  wikiSummary: string,
  qmdUpdateOk: boolean,
  qmdEmbedOk: boolean,
): string {
  const lines: string[] = ["✅ 知识库维护完成", ""];
  const maxFiles = 10;

  // ── Section: created summary files (authoritative, from subagent) ────
  if (summaries && summaries.length > 0) {
    lines.push(`<b>📄 已创建 / 更新（${summaries.length} 个 summary）</b>`);
    const displayed = summaries.slice(0, maxFiles);
    for (const s of displayed) {
      lines.push(`  <code>${escapeTelegramHtml(s)}</code>`);
    }
    if (summaries.length > maxFiles) {
      lines.push(`  <code>... 还有 ${summaries.length - maxFiles} 个</code>`);
    }
    lines.push("");
  }

  // ── Section: stale source files (supplementary, from pre-step) ───────
  if (staleFiles.length > 0) {
    lines.push(`<b>📄 源文件（${staleFiles.length} 个 stale 文件）</b>`);
    const displayed = staleFiles.slice(0, maxFiles);
    for (const f of displayed) {
      lines.push(`  <code>${escapeTelegramHtml(f)}</code>`);
    }
    if (staleFiles.length > maxFiles) {
      lines.push(`  <code>... 还有 ${staleFiles.length - maxFiles} 个</code>`);
    }
    lines.push("");
  }

  lines.push(`📝 wiki-summarize：${wikiSummary}`);
  lines.push(`🔍 qmd update：${qmdUpdateOk ? "✓" : "✗"}`);
  lines.push(`🧠 qmd embed：${qmdEmbedOk ? "✓" : "✗"}`);

  return lines.join("\n");
}

/**
 * Build a Telegram-safe HTML message for failure notifications.
 */
function buildTelegramFailureMessage(
  step: string,
  error: string,
  extra?: { exitCode?: number; stderr?: string },
): string {
  const lines: string[] = [
    `❌ 知识库维护失败 — ${step}`,
    "",
    `错误：${escapeTelegramHtml(error)}`,
  ];

  if (extra?.exitCode !== undefined) {
    lines.push(`exitCode：${extra.exitCode}`);
  }
  if (extra?.stderr) {
    const snippet = extra.stderr.slice(0, 500);
    lines.push(`stderr：${escapeTelegramHtml(snippet)}`);
  }

  return lines.join("\n");
}

/**
 * Escape text for Telegram HTML (only & < > ").
 */
function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── Task handler ──────────────────────────────────────────────────────────

export default defineTask({
  id: "knowledge-wiki-daily",
  every: "24h",
  description:
    "每日知识库维护：过期摘要重新生成、概念自动链接、qmd 索引和向量嵌入更新",

  handler: async (exec) => {
    // ── Pre-step: list stale files ──────────────────────────────────────
    log.info("Pre-step: list-stale");
    const staleFiles = await listStaleFiles(exec);
    log.info("stale files found", { count: staleFiles.length });

    // ── Step 1-3: Pi subagent with wiki-summarize prompt template ──────
    log.info("Step 1-3: subagent — wiki-summarize full pipeline");

    let wikiSummaryDone = "unknown";
    let qmdUpdateOk = false;
    let qmdEmbedOk = false;
    let createdSummaries: string[] | undefined;

    try {
      const prompt = buildSubagentPrompt(staleFiles);
      log.info("subagent prompt", {
        templatePath: PROMPT_TEMPLATE_PATH,
        promptLength: prompt.length,
        knowledgeDir: KNOWLEDGE_DIR,
        staleFileCount: staleFiles.length,
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
        log.warn("wiki-summarize subagent failed", {
          exitCode: result.exitCode,
          error: errorMsg,
        });

        await sendTelegramNotification(
          buildTelegramFailureMessage("Step 1-3 (wiki-summarize)", errorMsg, {
            exitCode: result.exitCode,
            stderr: result.stderr,
          }),
        ).catch((e) =>
          log.warn("telegram notify failed", { error: String(e) }),
        );
        return;
      }

      wikiSummaryDone = parsed?.done ?? "completed";
      createdSummaries = parsed?.summaries;
      log.info("wiki-summarize pipeline completed", {
        summary: wikiSummaryDone,
        summariesCount: createdSummaries?.length ?? 0,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn("subagent call threw", { error: errorMsg });

      await sendTelegramNotification(
        buildTelegramFailureMessage("Step 1-3 (wiki-summarize)", errorMsg),
      ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
      return;
    }

    // ── Step 4: qmd update ──────────────────────────────────────────────
    log.info("Step 4: qmd update");

    try {
      const { code } = await exec.exec("qmd", ["update"]);
      if (code !== 0) {
        log.warn("qmd update failed", { exitCode: code });

        await sendTelegramNotification(
          buildTelegramFailureMessage(
            "Step 4 (qmd update)",
            "qmd update 返回非零退出码",
            {
              exitCode: code,
            },
          ),
        ).catch((e) =>
          log.warn("telegram notify failed", { error: String(e) }),
        );
        return;
      }
      qmdUpdateOk = true;
      log.info("qmd update completed");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn("qmd update threw", { error: errorMsg });

      await sendTelegramNotification(
        buildTelegramFailureMessage("Step 4 (qmd update)", errorMsg),
      ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
      return;
    }

    // ── Step 5: qmd embed ───────────────────────────────────────────────
    log.info("Step 5: qmd embed");

    const prevModel = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = QMD_EMBED_MODEL;

    try {
      const { code } = await exec.exec("qmd", ["embed"]);
      if (code !== 0) {
        log.warn("qmd embed failed", { exitCode: code });

        await sendTelegramNotification(
          buildTelegramFailureMessage(
            "Step 5 (qmd embed)",
            "qmd embed 返回非零退出码",
            {
              exitCode: code,
            },
          ),
        ).catch((e) =>
          log.warn("telegram notify failed", { error: String(e) }),
        );
        return;
      }
      qmdEmbedOk = true;
      log.info("qmd embed completed");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn("qmd embed threw", { error: errorMsg });

      await sendTelegramNotification(
        buildTelegramFailureMessage("Step 5 (qmd embed)", errorMsg),
      ).catch((e) => log.warn("telegram notify failed", { error: String(e) }));
      return;
    } finally {
      if (prevModel === undefined) {
        delete process.env.QMD_EMBED_MODEL;
      } else {
        process.env.QMD_EMBED_MODEL = prevModel;
      }
    }

    // ── Success: send Telegram notification ─────────────────────────────
    const successMsg = buildTelegramSuccessMessage(
      staleFiles,
      createdSummaries,
      wikiSummaryDone,
      qmdUpdateOk,
      qmdEmbedOk,
    );
    log.info("knowledge-wiki-daily task completed successfully");

    await sendTelegramNotification(successMsg, undefined, true).catch((e) =>
      log.warn("telegram notify failed", { error: String(e) }),
    );
  },
});
