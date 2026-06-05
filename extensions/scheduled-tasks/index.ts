import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

  pi.registerCommand("tasks", {
    description: "List registered deferred tasks and their status",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      const taskIds = queue.list();
      if (taskIds.length === 0) {
        ctx.ui.notify("No deferred tasks registered", "info");
        return;
      }
      const message = `Deferred tasks: ${taskIds.join(", ")}`;
      ctx.ui.notify(message, "info");
    },
  });
}
