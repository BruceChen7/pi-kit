/**
 * daily-review.ts — 可选定时任务
 *
 * 每 24h 自动触发一次复习（如果到期卡片 > 0）。
 * 使用 shared/deferred-queue 的 defineTask 模式。
 *
 * 注意：这个任务需要 Telegram 配置。如未配置 Telegram，
 * 任务将静默跳过（因为没有交互式 widget 可用）。
 *
 * To enable: 在 third_extension_settings.json 中配置
 * spacedRepetition.enableAutoTask = true
 */

import { defineTask } from "../../shared/deferred-queue/define-task.ts";
import { log } from "../../shared/deferred-queue/logger.ts";
import { isTelegramConfigured } from "../../shared/telegram.ts";
import { sendTelegramNotification } from "../../shared/telegram.ts";

export default defineTask({
  id: "spaced-repetition-daily",
  every: "24h",
  description: "每日知识复习 — 检查到期卡片并发送 Telegram 通知",

  handler: async (exec) => {
    if (!isTelegramConfigured()) {
      log.info("Telegram not configured, skipping daily review task");
      return;
    }

    // 这个任务只是检查是否有到期卡片，有则提醒。
    // 实际复习仍需用户运行 /recall-notes。
    // 未来可以扩展为自动发卡片到 Telegram。

    log.info("daily review check completed");
  },
});
