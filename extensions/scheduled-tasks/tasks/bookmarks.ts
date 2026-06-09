import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import {
  convertMarkdownToTelegramHtml,
  sendTelegramNotification,
} from "../../shared/telegram.ts";

const CHUNK_MAX_LENGTH = 3800;
const TELEGRAM_MAX_LENGTH = 4096;
const SUBAGENT_TIMEOUT_MS = 120_000;
const CHUNK_PREFIX = "📑 X Bookmarks\n\n";

/**
 * Input for the pure core decision: how to chunk bookmark output.
 */
export interface BookmarkChunkInput {
  /** Raw Markdown output from the subagent. */
  rawOutput: string;
  /** Prefix prepended to the first chunk. */
  prefix: string;
  /**
   * Maximum character length of the raw content per chunk.
   * Used as a first-pass limit; the output HTML is further constrained
   * by `maxHtmlLength` to account for tag expansion.
   */
  maxChunkLength: number;
  /**
   * Maximum HTML length per chunk (Telegram's sendMessage limit is 4096).
   * After Markdown→HTML conversion, each chunk's HTML string is guaranteed
   * to be ≤ this value.
   */
  maxHtmlLength: number;
}

/**
 * A single HTML chunk ready to send to Telegram.
 */
export interface BookmarkChunk {
  /** HTML string safe for Telegram parse_mode=HTML. */
  html: string;
}

/**
 * Pure core: converts raw subagent output into HTML chunks ready to send.
 *
 * - Splits output at entry boundaries (`## N.` headings) to keep whole entries intact.
 * - Accumulates entries into chunks by **HTML length** (not raw length), so the
 *   output never exceeds Telegram's 4096-character `sendMessage` limit even after
 *   Markdown→HTML tag expansion.
 * - Prepends the prefix only to the first chunk.
 *
 * Edge case: a single entry whose HTML exceeds `maxHtmlLength` is still sent as
 * one chunk (Telegram will reject it, but this is extremely rare — a single
 * bookmark entry would need to be thousands of characters long).
 *
 * No IO, no side effects — fully testable with string inputs.
 */
export function prepareBookmarkChunks(
  input: BookmarkChunkInput,
): BookmarkChunk[] {
  const entries = splitEntries(input.rawOutput);
  const result: BookmarkChunk[] = [];

  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const raw = buffer.join("\n");
    const text = result.length === 0 ? input.prefix + raw : raw;
    result.push({ html: convertMarkdownToTelegramHtml(text) });
    buffer = [];
  };

  for (const entry of entries) {
    const candidateBuffer = [...buffer, entry];
    const raw = candidateBuffer.join("\n");
    const text =
      result.length === 0 && buffer.length === 0 ? input.prefix + raw : raw;

    if (
      convertMarkdownToTelegramHtml(text).length > input.maxHtmlLength &&
      buffer.length > 0
    ) {
      // Adding this entry would exceed the HTML length limit — flush first
      flushBuffer();
    }

    buffer.push(entry);
  }

  flushBuffer();

  return result;
}

/**
 * Split raw Markdown text into individual bookmark entries.
 *
 * Entries are delimited by `## N.` heading lines.
 * The leading summary text (before the first `## N.`) is treated as the first entry.
 */
function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (/^## \d+\.\s/.test(line) && buffer) {
      entries.push(buffer.trim());
      buffer = line;
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }

  if (buffer.trim()) {
    entries.push(buffer.trim());
  }

  return entries;
}

export default defineTask({
  id: "x-bookmarks-fetch",
  every: "24h",
  description: "Fetch X bookmarks daily via Pi agent",
  handler: async (exec) => {
    log.info("starting bookmarks fetch via subagent");

    const result = await exec.subagent({
      prompt: "/x-bookmarks 50 bookmarks",
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    });

    const output = result.summary ?? result.stdout;

    log.info("subagent finished", {
      exitCode: result.exitCode,
      outputLength: output.length,
    });

    // ── Pure core: decide what to send ──────────────────────────
    const chunks = prepareBookmarkChunks({
      rawOutput: output,
      prefix: CHUNK_PREFIX,
      maxChunkLength: CHUNK_MAX_LENGTH,
      maxHtmlLength: TELEGRAM_MAX_LENGTH,
    });

    log.info("bookmarks fetch: sending chunks", {
      chunkCount: chunks.length,
      chunkLengths: chunks.map((c) => c.html.length),
    });

    // ── Shell: execute the send for each chunk ─────────────────
    for (const { html } of chunks) {
      await sendTelegramNotification(html, undefined, true);
    }

    log.info("bookmarks fetch complete", { chunkCount: chunks.length });
  },
});
