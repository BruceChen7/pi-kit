import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import type { ExecContext } from "../../shared/deferred-queue/types.ts";
import {
  convertMarkdownToTelegramHtml,
  sendTelegramNotification,
} from "../../shared/telegram.ts";

// ── Types ──────────────────────────────────────────────

export interface TelegramMessage {
  id: string;
  content: string;
  timestamp: string;
  channel: string;
  channelUsername?: string;
  llmSummary?: string;
}

export interface MatchResult {
  matched: boolean;
  matchedKeywords: string[];
}

export interface SourceChannel {
  title: string;
  username: string;
}

export interface ForwardMessageHtml {
  html: string;
  link: string;
  truncated: boolean;
}

// ── Configuration ──────────────────────────────────────

export const KEYWORDS: string[] = [
  // 调试
  "debug",
  "pprof",
  "tracing",
  "strace",
  "rr",
  // eBPF
  "ebpf",
  "bpf",
  "cilium",
  "ringbuf",
  "xdp",
  // 底层原理
  "内存管理",
  "RSS",
  "VMA",
  "cgroup",
  "并发",
  "系统调用",
  // 性能优化
  "performance",
  "benchmark",
  "optimization",
  "逃逸分析",
  // 内核
  "kernel",
  "filesystem",
  "调度器",
  // Runtime
  "GC",
  "scheduler",
  "goroutine",
  "tokio",
  // Rust
  "rust",
  "unsafe",
  "borrow checker",
  "no_std",
];

export const SOURCE_CHANNELS: SourceChannel[] = [
  {
    title: "Welcome to the Black Parade",
    username: "TheB1ackParade",
  },
];

export const TELEGRAM_MAX_HTML_LENGTH = 4096;

export const CHECKPOINT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "telegram-filter-checkpoint.json",
);

// ── Pure core: keyword matching ────────────────────────

/**
 * Check if content matches any of the given keywords (case-insensitive).
 *
 * No IO — fully testable.
 */
export function matchKeywords(
  content: string,
  keywords: string[],
): MatchResult {
  if (!content || keywords.length === 0) {
    return { matched: false, matchedKeywords: [] };
  }

  const lowerContent = content.toLowerCase();
  const matchedKeywords = keywords.filter((kw) =>
    lowerContent.includes(kw.toLowerCase()),
  );

  return {
    matched: matchedKeywords.length > 0,
    matchedKeywords,
  };
}

// ── Pure core: relevance check from LLM summary ───────

/**
 * Check if an LLM-generated summary indicates relevance to our topics.
 *
 * No IO — fully testable.
 */
export function checkRelevanceFromSummary(
  summary: string,
  topics: string[],
): { relevant: boolean; matchedTopics: string[] } {
  if (!summary || topics.length === 0) {
    return { relevant: false, matchedTopics: [] };
  }

  const lowerSummary = summary.toLowerCase();
  const matchedTopics = topics.filter((topic) =>
    lowerSummary.includes(topic.toLowerCase()),
  );

  return {
    relevant: matchedTopics.length > 0,
    matchedTopics,
  };
}

// ── Pure core: build LLM prompt ───────────────────────

/**
 * Build a prompt for LLM to summarize a Telegram message and extract key topics.
 *
 * No IO — fully testable.
 */
export function buildSummaryPrompt(content: string): string {
  return `请用中文总结以下 Telegram 消息的核心内容，提取关键技术和主题。

要求：
1. 用 1-2 句话概括核心内容
2. 列出涉及的技术主题
3. 判断是否属于以下领域：调试(debug/pprof/tracing)、eBPF(bpf/cilium/ringbuf)、底层原理(内存管理/并发/系统调用)、性能优化(benchmark/optimization)、内核(kernel/filesystem)、Runtime(GC/scheduler/goroutine)、Rust

消息内容：
${content.slice(0, 2000)}

请严格用以下 JSON 格式回复，不要包含其他内容：
{"summary": "1-2句中文摘要", "topics": ["技术主题1", "技术主题2"], "relevant": true}`;
}

// ── Pure core: parse LLM response ─────────────────────

export interface LlmSummaryResult {
  summary: string;
  topics: string[];
  relevant: boolean;
}

/**
 * Parse LLM response into structured result.
 *
 * No IO — fully testable.
 */
export function selectSubagentLlmOutput(
  stdout: string,
  summary: string | undefined,
): string {
  return summary?.trim() ? summary : stdout;
}

export function parseLlmResponse(response: string): LlmSummaryResult {
  try {
    // Extract JSON from response (LLM may wrap in markdown code block)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { summary: "", topics: [], relevant: false };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      relevant: typeof parsed.relevant === "boolean" ? parsed.relevant : false,
    };
  } catch {
    return { summary: "", topics: [], relevant: false };
  }
}

// ── Pure core: forward message formatting ─────────────

export function buildTelegramMessageLink(
  source: SourceChannel,
  msgId: string,
): string {
  const username = source.username.replace(/^@/, "");
  return `https://t.me/${username}/${msgId}`;
}

function appendSourceLink(content: string, link: string): string {
  return `${content}\n\n🔗 ${link}`;
}

function buildForwardHtml(content: string, link: string): string {
  return convertMarkdownToTelegramHtml(appendSourceLink(content, link));
}

export function buildForwardMessageHtml(input: {
  message: TelegramMessage;
  source: SourceChannel;
  maxHtmlLength?: number;
}): ForwardMessageHtml {
  const maxHtmlLength = input.maxHtmlLength ?? TELEGRAM_MAX_HTML_LENGTH;
  const link = buildTelegramMessageLink(input.source, input.message.id);
  const fullHtml = buildForwardHtml(input.message.content, link);

  if (fullHtml.length <= maxHtmlLength) {
    return { html: fullHtml, link, truncated: false };
  }

  const suffixOnlyHtml = buildForwardHtml("…", link);
  if (suffixOnlyHtml.length > maxHtmlLength) {
    throw new Error("Telegram message link exceeds max HTML length");
  }

  let low = 0;
  let high = input.message.content.length;
  let bestHtml = suffixOnlyHtml;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const html = buildForwardHtml(
      `${input.message.content.slice(0, mid)}…`,
      link,
    );

    if (html.length <= maxHtmlLength) {
      bestHtml = html;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { html: bestHtml, link, truncated: true };
}

export function shouldUpdateCheckpointAfterForward(
  hasForwardFailure: boolean,
): boolean {
  return !hasForwardFailure;
}

// ── Checkpoint (IO) ───────────────────────────────────

/**
 * Load checkpoint state from disk.
 * Returns empty Map when file doesn't exist or is corrupt.
 */
export function loadFilterCheckpoint(
  checkpointPath: string,
): Map<string, string> {
  try {
    const raw = readFileSync(checkpointPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/**
 * Persist checkpoint state to disk.
 */
export function saveFilterCheckpoint(
  state: Map<string, string>,
  checkpointPath: string,
): void {
  const dir = dirname(checkpointPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const obj = Object.fromEntries(state);
  writeFileSync(checkpointPath, JSON.stringify(obj, null, 2), "utf-8");
}

// ── JSON parsing ───────────────────────────────────────

/**
 * Select the stream that contains tg export JSON.
 * Some tg-cli versions write JSON to stderr even when the command succeeds.
 */
export function selectTgExportJsonOutput(
  stdout: string,
  stderr: string,
): string {
  return stdout.trim().length > 0 ? stdout : stderr;
}

/**
 * Escape raw control characters inside JSON string literals.
 * Some tg export output contains literal newlines in message content, which is
 * invalid JSON even though the surrounding array/object shape is otherwise valid.
 */
function escapeControlCharsInJsonStrings(jsonString: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of jsonString) {
    if (!inString) {
      result += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      result += "\\n";
    } else if (char === "\r") {
      result += "\\r";
    } else if (char === "\t") {
      result += "\\t";
    } else {
      result += char;
    }
  }

  return result;
}

function parseTgJson(jsonString: string): unknown {
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    const repaired = escapeControlCharsInJsonStrings(jsonString);
    if (repaired === jsonString) throw err;
    return JSON.parse(repaired);
  }
}

/**
 * Parse tg-cli JSON output into TelegramMessage array.
 * Handles both formats:
 *   - tg filter --json: { ok: true, data: [...] }
 *   - tg export --format json: raw array [...]
 */
export function parseTgFilterOutput(jsonString: string): TelegramMessage[] {
  const parsed = parseTgJson(jsonString);

  // Determine the data array from either wrapper or raw array format
  let data: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    // tg export returns a raw JSON array
    data = parsed as Record<string, unknown>[];
  } else if (parsed && typeof parsed === "object") {
    const parsedObj = parsed as Record<string, unknown>;

    // tg filter --json returns { ok: true, data: [...] }
    if (!parsedObj.ok) {
      const errMsg =
        typeof parsedObj.error === "string"
          ? parsedObj.error
          : JSON.stringify(parsedObj.error);
      throw new Error(`tg filter failed: ${errMsg}`);
    }
    if (!Array.isArray(parsedObj.data)) {
      throw new Error("Expected data array in tg filter output");
    }
    data = parsedObj.data as Record<string, unknown>[];
  } else {
    throw new Error("Unexpected tg output format: expected array or object");
  }

  return data.map((item) => ({
    id: String(item.msg_id ?? item.id),
    content: String(item.content ?? ""),
    timestamp: String(item.timestamp ?? ""),
    channel: String(item.chat_name ?? ""),
    channelUsername: item.chat_username
      ? String(item.chat_username)
      : undefined,
  }));
}

// ── Task handler ───────────────────────────────────────

export default defineTask({
  id: "telegram-channel-filter",
  every: "24h",
  description: "Filter and forward Telegram channel messages via LLM summary",
  handler: async (exec: ExecContext) => {
    const checkpoint = loadFilterCheckpoint(CHECKPOINT_PATH);

    for (const source of SOURCE_CHANNELS) {
      const channel = source.title;
      log.info("processing channel", { channel, username: source.username });

      // 1. Sync channel messages
      const syncResult = await exec.exec("tg", [
        "sync",
        channel,
        "--limit",
        "50",
      ]);
      if (syncResult.code !== 0) {
        log.warn("tg sync failed", {
          channel,
          stderr: syncResult.stderr.slice(0, 500),
        });
        continue;
      }

      // 2. Get recent messages (last 24h)
      const historyResult = await exec.exec("tg", [
        "export",
        channel,
        "--format",
        "json",
        "--hours",
        "24",
      ]);

      if (historyResult.code !== 0) {
        log.warn("tg export failed", {
          channel,
          stderr: historyResult.stderr.slice(0, 500),
        });
        continue;
      }

      // 3. Parse messages
      let messages: TelegramMessage[];
      try {
        const tgJsonOutput = selectTgExportJsonOutput(
          historyResult.stdout,
          historyResult.stderr,
        );
        log.debug("tg export output lengths", {
          channel,
          stdoutLength: historyResult.stdout.length,
          stderrLength: historyResult.stderr.length,
          selectedStream:
            tgJsonOutput === historyResult.stdout ? "stdout" : "stderr",
        });
        messages = parseTgFilterOutput(tgJsonOutput);
      } catch (err) {
        log.warn("failed to parse tg export output", {
          channel,
          error: String(err),
          stdoutSnippet: historyResult.stdout.slice(0, 200),
          stderrSnippet: historyResult.stderr.slice(0, 200),
        });
        continue;
      }

      log.info("parsed messages", {
        channel,
        count: messages.length,
        sampleIds: messages.slice(-3).map((m) => m.id),
      });

      if (messages.length === 0) {
        log.info("no messages in last 24h", { channel });
        continue;
      }

      // 4. Deduplicate against checkpoint
      const lastMsgId = checkpoint.get(channel);
      log.debug("checkpoint state", { channel, lastMsgId });
      const newMessages = lastMsgId
        ? messages.filter((m) => Number(m.id) > Number(lastMsgId))
        : messages;

      log.info("after dedup", {
        channel,
        total: messages.length,
        new: newMessages.length,
        lastCheckpointId: lastMsgId,
        newestMsgId: newMessages[newMessages.length - 1]?.id,
      });

      if (newMessages.length === 0) {
        log.info("no new messages since last checkpoint", { channel });
        continue;
      }

      // 5. For each message, use LLM to summarize and check relevance
      const relevantMessages: TelegramMessage[] = [];

      for (const msg of newMessages) {
        // Skip very short messages (likely not substantive)
        if (msg.content.length < 50) {
          log.debug("skipping short message", {
            id: msg.id,
            contentLength: msg.content.length,
            preview: msg.content.slice(0, 50),
          });
          continue;
        }

        log.debug("processing message", {
          id: msg.id,
          contentLength: msg.content.length,
          preview: msg.content.slice(0, 80),
        });

        const prompt = buildSummaryPrompt(msg.content);
        const result = await exec.subagent({
          prompt,
          timeoutMs: 30_000,
        });

        if (result.exitCode !== 0) {
          log.warn("LLM summarization failed", {
            msgId: msg.id,
            error: result.stderr.slice(0, 200),
          });
          continue;
        }

        const llmResult = parseLlmResponse(
          selectSubagentLlmOutput(result.stdout, result.summary),
        );

        log.debug("LLM result", {
          msgId: msg.id,
          relevant: llmResult.relevant,
          topics: llmResult.topics,
          summaryPreview: llmResult.summary?.slice(0, 100),
        });

        if (llmResult.relevant) {
          log.info("message relevant", {
            msgId: msg.id,
            topics: llmResult.topics,
          });
          relevantMessages.push({
            ...msg,
            llmSummary: llmResult.summary,
          });
        }
      }

      if (relevantMessages.length === 0) {
        log.info("no relevant messages found", { channel });
        // Still update checkpoint to avoid re-processing
        const newestMsgId = newMessages[newMessages.length - 1].id;
        checkpoint.set(channel, newestMsgId);
        saveFilterCheckpoint(checkpoint, CHECKPOINT_PATH);
        continue;
      }

      // 6. Forward original text with source message link.
      let hasForwardFailure = false;
      for (const msg of relevantMessages) {
        const forwardMessage = buildForwardMessageHtml({
          message: msg,
          source,
        });

        try {
          await sendTelegramNotification(forwardMessage.html, undefined, true);
          log.info("message forwarded", {
            msgId: msg.id,
            link: forwardMessage.link,
            truncated: forwardMessage.truncated,
          });
        } catch (err) {
          hasForwardFailure = true;
          log.warn("failed to forward message", {
            msgId: msg.id,
            error: String(err),
          });
        }
      }

      if (!shouldUpdateCheckpointAfterForward(hasForwardFailure)) {
        log.warn("checkpoint not updated because forwarding failed", {
          channel,
        });
        continue;
      }

      // 7. Update checkpoint
      const newestMsgId = newMessages[newMessages.length - 1].id;
      checkpoint.set(channel, newestMsgId);
      saveFilterCheckpoint(checkpoint, CHECKPOINT_PATH);
      log.info("checkpoint updated", { channel, lastMsgId: newestMsgId });
    }
  },
});
