import { createLogger } from "../shared/logger.ts";

type LoggerOptions = Parameters<typeof createLogger>[1];

export type KanbanLogger = Pick<
  ReturnType<typeof createLogger>,
  "info" | "error"
>;

export const consoleLogger: KanbanLogger = createKanbanLogger();

export function createKanbanLogger(
  scope?: string,
  options: LoggerOptions = {},
): KanbanLogger {
  return createLogger(scope ? `kanban-worktree:${scope}` : "kanban-worktree", {
    ...options,
    stderr: null,
  });
}
