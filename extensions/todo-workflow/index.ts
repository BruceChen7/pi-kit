import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { restoreTodoStatus } from "./interactions.js";
import { getTodoArgumentCompletions, handleTodoCommand } from "./router.js";

export default function todoWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("todo", {
    description: "Manage project TODO workflow",
    getArgumentCompletions: (argumentPrefix) =>
      getTodoArgumentCompletions(pi, argumentPrefix),
    handler: async (args, ctx) => handleTodoCommand(pi, args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreTodoStatus(ctx);
  });
}
