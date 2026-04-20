import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

describe("kanban orchestrator dependency loading", () => {
  it("loads and registers commands without eager feature-workflow imports", async () => {
    vi.doMock("../feature-workflow/board.js", () => {
      throw new Error("feature-workflow board unavailable");
    });
    vi.doMock("../feature-workflow/board-sidecar.js", () => {
      throw new Error("feature-workflow board-sidecar unavailable");
    });
    vi.doMock("../feature-workflow/commands/feature-board.js", () => {
      throw new Error("feature-workflow feature-board unavailable");
    });
    vi.doMock("../feature-workflow/commands/feature-prune-merged.js", () => {
      throw new Error("feature-workflow prune unavailable");
    });
    vi.doMock("../feature-workflow/commands/feature-switch.js", () => {
      throw new Error("feature-workflow switch unavailable");
    });
    vi.doMock("../feature-workflow/commands/feature-validate.js", () => {
      throw new Error("feature-workflow validate unavailable");
    });

    const commands: string[] = [];
    const { default: extension } = await import("./index.js");

    expect(() =>
      extension({
        registerCommand(name: string) {
          commands.push(name);
        },
        on() {
          // no-op
        },
      } as unknown as ExtensionAPI),
    ).not.toThrow();

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
