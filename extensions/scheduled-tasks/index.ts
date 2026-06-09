import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { createQueue } from "../shared/deferred-queue/index.ts";
import { log } from "../shared/deferred-queue/logger.ts";
import type { TaskDefinition } from "../shared/deferred-queue/types.ts";

const WIDGET_KEY = "deferred-queue";
const PERSIST_FILE = join(os.homedir(), ".pi", "agent", "deferred-queue.json");

type TaskModule = { default?: TaskDefinition };

/**
 * Auto-discover task files from the tasks/ directory sibling to this file.
 */
async function discoverTasks(tasksDir: string): Promise<TaskDefinition[]> {
  const tasks: TaskDefinition[] = [];

  try {
    const entries = readdirSync(tasksDir);
    for (const entry of entries) {
      const filePath = join(tasksDir, entry);
      if (statSync(filePath).isFile() && extname(entry) === ".ts") {
        try {
          const fileUrl = pathToFileURL(filePath).href;
          const mod = (await import(fileUrl)) as TaskModule;
          if (mod.default) {
            tasks.push(mod.default);
            log.info("discovered task file", {
              file: entry,
              id: mod.default.id,
            });
          }
        } catch (err) {
          log.warn("failed to load task file", {
            file: entry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    log.warn("failed to read tasks directory", {
      tasksDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return tasks;
}

/**
 * Format an epoch ms timestamp as a human-friendly relative time string.
 */
export function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function (pi: ExtensionAPI) {
  const tasksDir = new URL("tasks", import.meta.url).pathname;

  log.info("extension loading", { tasksDir });
  const discoveredTasks = await discoverTasks(tasksDir);

  if (discoveredTasks.length === 0) {
    log.info("no tasks discovered");
    return;
  }

  // Store a ctx reference for widget updates. Captured from the first event handler.
  let widgetCtx: ExtensionContext | undefined;

  const setWidgetLine = (text: string | undefined) => {
    if (!widgetCtx?.hasUI) return;
    if (text === undefined) {
      widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
    } else {
      const line = widgetCtx.ui.theme?.fg?.("accent", text) ?? text;
      widgetCtx.ui.setWidget(WIDGET_KEY, [line]);
    }
  };

  log.info("creating queue", { tasksFound: discoveredTasks.length });
  const queue = createQueue({
    persistPath: PERSIST_FILE,
    checkIntervalMs: 60_000,
    onTaskStatus: (taskId, status) => {
      if (status === "running") {
        log.info("task widget: running", { taskId });
        setWidgetLine(`⏳ deferred task running: ${taskId}`);
      } else {
        log.info("task widget: idle", { taskId, status });
        setWidgetLine(undefined);
      }
    },
  });

  for (const task of discoveredTasks) {
    try {
      queue.add(task);
      log.info("task registered to queue", { id: task.id });
    } catch (err) {
      log.warn("failed to register task", {
        id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Shared command handler for /tasks.
   * Shows interactive picker in TUI mode, falls back to notification.
   */
  const tasksHandler = async (_args: string, ctx: ExtensionContext) => {
    widgetCtx = ctx;
    const taskMetas = queue.listWithMeta();
    if (taskMetas.length === 0) {
      ctx.ui.notify("No deferred tasks registered", "info");
      return;
    }

    // ── Non-TUI fallback: plain text list ──────────────────
    if (!ctx.hasUI || ctx.mode !== "tui") {
      const lines = taskMetas.map((t) => {
        const status =
          t.lastResult === "ok" ? "✓" : t.lastResult === "error" ? "✗" : "·";
        return `${status} ${t.id} (${t.every})`;
      });
      ctx.ui.notify(`Deferred tasks:\n${lines.join("\n")}`, "info");
      return;
    }

    // ── TUI: interactive picker ────────────────────────────
    const items: SelectItem[] = taskMetas.map((t) => {
      let suffix = t.every;
      if (t.lastRunAt) {
        const ago = formatRelativeTime(t.lastRunAt);
        const trig = t.triggeredBy ? ` ${t.triggeredBy}` : "";
        suffix += ` • ${ago}${trig}`;
      } else {
        suffix += " • never run";
      }
      return {
        value: t.id,
        label: t.description ?? t.id,
        description: suffix,
      };
    });

    const selectedId = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold("Select a task to run manually")),
            1,
            0,
          ),
        );

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ navigate • enter to trigger • esc cancel"),
            1,
            0,
          ),
        );
        container.addChild(
          new DynamicBorder((s: string) => theme.fg("accent", s)),
        );

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (!selectedId) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    // ── Execute the selected task ──────────────────────────
    // Widget lifecycle (running → completed) is managed inside runNow
    // via onTaskStatus. Do NOT setWidgetLine here — the task may already
    // be done by the time await returns, leaving the widget stuck on "running".
    const result = await queue.runNow(selectedId);
    if (result.executed) {
      ctx.ui.notify(`Task "${selectedId}" triggered successfully`, "info");
    } else {
      ctx.ui.notify(`Cannot run "${selectedId}": ${result.reason}`, "warning");
    }
  };

  pi.registerCommand("tasks", {
    description: "List and manually trigger deferred tasks",
    handler: tasksHandler,
  });
}
