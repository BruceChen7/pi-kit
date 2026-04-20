import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  getKanbanAuditLogPath,
  getKanbanSessionRegistryPath,
  default as kanbanOrchestratorExtension,
} from "./index.js";

describe("kanban orchestrator paths", () => {
  it("builds default session registry path", () => {
    expect(getKanbanSessionRegistryPath("/repo")).toBe(
      path.join(
        "/repo",
        "workitems",
        ".feature-workflow",
        "session-registry.json",
      ),
    );
  });

  it("builds default execution audit log path", () => {
    expect(getKanbanAuditLogPath("/repo")).toBe(
      path.join(
        "/repo",
        "workitems",
        ".feature-workflow",
        "execution.log.jsonl",
      ),
    );
  });

  it("registers kanban orchestrator commands", () => {
    const commands: string[] = [];

    kanbanOrchestratorExtension({
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {
        // no-op
      },
    } as unknown as ExtensionAPI);

    expect(commands.sort()).toEqual([
      "kanban-action-execute",
      "kanban-action-status",
      "kanban-board-patch",
      "kanban-card-context",
      "kanban-runtime-start",
      "kanban-runtime-status",
      "kanban-runtime-stop",
    ]);
  });
});
