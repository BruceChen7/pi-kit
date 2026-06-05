import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import {
  convertMarkdownToTelegramHtml,
  sendTelegramNotification,
} from "../../shared/telegram.ts";

const CHUNK_MAX_LENGTH = 3800;

/**
 * Split bookmark entries into chunks by complete entries.
 *
 * Splits on `## N.` headings so each chunk contains whole entries.
 * The first chunk always includes the summary header.
 */
function chunkByEntries(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    const isEntryStart = /^## \d+\.\s/.test(line);

    if (
      isEntryStart &&
      buffer.length > 0 &&
      buffer.length + line.length > maxLen
    ) {
      chunks.push(buffer.trim());
      buffer = line;
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim());
  }

  return chunks;
}

export default defineTask({
  id: "x-bookmarks-fetch",
  every: "24h",
  description: "Fetch X bookmarks daily via Pi agent",
  handler: async (exec) => {
    log.info("starting bookmarks fetch via subagent");

    const result = await exec.subagent({
      prompt: "/x-bookmarks 50 bookmarks",
      timeoutMs: 60_000,
    });

    log.info("subagent finished", {
      exitCode: result.exitCode,
      stderrLength: result.stderr.length,
      outputLength: result.stdout.length,
      summaryLength: result.summary?.length ?? 0,
    });

    const output = result.summary ?? result.stdout;
    log.info("sending to telegram", { outputLength: output.length });

    const chunks = chunkByEntries(output, CHUNK_MAX_LENGTH);
    const prefix = "📑 X Bookmarks\n\n";

    for (let i = 0; i < chunks.length; i++) {
      const text = i === 0 ? prefix + chunks[i] : chunks[i];
      const html = convertMarkdownToTelegramHtml(text);
      await sendTelegramNotification(html, undefined, true);
    }

    log.info("bookmarks fetch complete", { chunkCount: chunks.length });
  },
});
