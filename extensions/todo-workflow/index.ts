import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { restoreTodoStatus } from "./interactions.js";

export default function todoWorkflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand("todo", {
    description: "Manage project TODO workflow",
    getArgumentCompletions: async (argumentPrefix) => {
      const { getTodoArgumentCompletions } = await import("./router.js");
      return getTodoArgumentCompletions(pi, argumentPrefix);
    },
    handler: async (args, ctx) => {
      const { handleTodoCommand } = await import("./router.js");
      return handleTodoCommand(pi, args, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreTodoStatus(ctx);
  });
}
