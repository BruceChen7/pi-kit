/**
 * Tasks — Linear-style task tracker for pi.
 *
 * Replaces the legacy todos/kanban/feature-workflow systems. Provides:
 *  - Custom tools (task_create/list/show/update/comment/project_list)
 *  - /issue CLI commands
 *  - Glimpse board/list/detail UI (方案 A layout)
 *  - Agent skill (skills/tasks/SKILL.md)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./cli.ts";
import { getDefaultProjectRoot } from "./paths.ts";
import { registerTools } from "./tools.ts";

export default function tasksExtension(pi: ExtensionAPI): void {
  registerTools(pi, getDefaultProjectRoot);
  registerCommands(pi);
}
