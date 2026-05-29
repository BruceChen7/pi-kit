import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("cs-search", { stderr: null });

const TOOL_NAME = "cs_search";

const toolParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query for ranked structural code search.",
  }),
});

export default function csSearchExtension(pi: ExtensionAPI) {
  let toolRegistered = false;

  const registerTool = (): void => {
    if (toolRegistered) {
      return;
    }

    pi.registerTool({
      name: TOOL_NAME,
      label: "CS Search",
      description:
        "Run ranked structural code search via boyter/cs to find the most relevant implementation, declaration, usage, comment, or string match.",
      promptSnippet:
        "cs_search: ranked structural code search for implementations, definitions, usages, comments, and strings.",
      promptGuidelines: [
        "Use cs_search when you need to find the most relevant implementation, declaration, usage, comment, or string match in code.",
        "Use rg instead when you need exact text or regex line matches.",
      ],
      parameters: toolParameters,
      async execute() {
        return {
          content: [
            {
              type: "text" as const,
              text: "cs_search is not implemented yet.",
            },
          ],
          details: {},
        };
      },
    });

    toolRegistered = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    const shell = (ctx as { shell?: { which?: (name: string) => Promise<string | null> } }).shell;
    const which = shell?.which;

    if (!which) {
      log.warn("cs binary detection unavailable; skipping registration");
      return;
    }

    const csPath = await which("cs");
    if (!csPath) {
      log.info("cs binary not found; skipping registration");
      return;
    }

    log.info("cs binary found; registering tool", { csPath });
    registerTool();
  });
}
