import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import { sendTelegramNotification } from "../../shared/telegram.ts";

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

    await sendTelegramNotification(
      `📑 X Bookmarks\n\n${output.slice(0, 2000)}`,
    );

    log.info("bookmarks fetch complete");
  },
});
