// https://github.com/bxff/pi-deepseek-search
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";
import {
  getGlobalSettingsPath,
  loadGlobalSettings,
  writeSettingsFile,
} from "../shared/settings.ts";
import { provideWebSearchFallback } from "../shared/web-search-fallback.ts";
import {
  type DeepSeekSearchParams,
  formatSources,
  readErrorMessage,
  resolveDeepSeekApiKey,
  runDeepSeekWebSearch,
  SEARCH_MODEL,
  toFallbackSources,
} from "./search.ts";

const TOOL_NAME =
  process.env.DEEPSEEK_SEARCH_TOOL_NAME || "deepseek_web_search";

const log = createLogger("deepseek-search", { stderr: null });

const SETTINGS_KEY = "deepseekSearch";
const SETTINGS_FILE_PATH = getGlobalSettingsPath();

type ToolDetails = Record<string, unknown>;

type ToolErrorResult = AgentToolResult<ToolDetails> & { isError: true };

const webSearchParams = Type.Object({
  query: Type.String({
    minLength: 2,
    description: "The search query. Be specific and include relevant keywords.",
  }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict results to these domains (e.g. ['python.org']). Cannot combine with blocked_domains.",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude these domains from results. Cannot combine with allowed_domains.",
    }),
  ),
});

function textResult(
  text: string,
  details: ToolDetails = {},
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(text: string): ToolErrorResult {
  return {
    ...textResult(text),
    isError: true,
  };
}

function notifyProgress(
  onUpdate: AgentToolUpdateCallback<ToolDetails> | undefined,
  text: string,
): void {
  onUpdate?.(textResult(text));
}

const citationReminder =
  "\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

type DeepSeekSearchSettings = {
  enabled: boolean;
};

export function loadDeepSeekSearchSettings(): DeepSeekSearchSettings {
  const { global } = loadGlobalSettings();
  const ext = global[SETTINGS_KEY];
  if (isRecord(ext) && typeof ext.enabled === "boolean") {
    return { enabled: ext.enabled };
  }
  return { enabled: false };
}

export function saveDeepSeekSearchSettings(
  settings: DeepSeekSearchSettings,
): void {
  const { global } = loadGlobalSettings();
  writeSettingsFile(SETTINGS_FILE_PATH, {
    ...global,
    [SETTINGS_KEY]: settings,
  });
}

export type DeepSeekSearchStatus = {
  message: string;
  severity: "info" | "warning";
};

export function formatDeepSeekSearchStatus(
  active: boolean,
  savedEnabled: boolean,
  model: string,
): DeepSeekSearchStatus {
  let message = active
    ? `DeepSeek search: enabled | Model: ${model}`
    : `DeepSeek search: disabled`;
  if (savedEnabled && !active) {
    message += ` (saved: enabled — run \`on\` to activate for this session)`;
  }
  return { message, severity: active ? "info" : "warning" };
}

export default function deepseekSearchExtension(pi: ExtensionAPI) {
  log.info("deepseek-search extension loaded", {
    toolName: TOOL_NAME,
    searchModel: SEARCH_MODEL,
  });

  let toolRegistered = false;
  let lastContext: ExtensionContext | undefined;

  // 只有 web_search 失败后才会有人往总线发请求，这里回不回应取决于用户是否启用。
  provideWebSearchFallback({
    events: pi.events,
    provider: "deepseek",
    isAvailable: () => loadDeepSeekSearchSettings().enabled,
    runSearch: async ({ query, maxSources }) => {
      if (!lastContext) {
        throw new Error("DeepSeek search is not ready in this session yet");
      }
      const apiKey = await resolveDeepSeekApiKey(lastContext);
      const result = await runDeepSeekWebSearch({ apiKey, params: { query } });
      log.info("DeepSeek fallback search completed", {
        query,
        sourceCount: result.sources.length,
      });
      return {
        ok: true,
        provider: "deepseek",
        summary: result.answerParts.join("\n\n") || `No results for: ${query}`,
        sources: toFallbackSources(result.sources, maxSources),
      };
    },
  });

  const registerSearchTool = (): void => {
    if (toolRegistered) {
      log.debug("deepseek-search tool already registered", {
        toolName: TOOL_NAME,
      });
      return;
    }

    pi.registerTool({
      name: TOOL_NAME,
      label: "DeepSeek Web Search",
      description: `Fallback web search via DeepSeek server-side search. Use it only after the web_search tool failed or is unavailable. Returns results with titles, URLs, and a brief summary. The current date is ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })} — use the current year for recent queries.`,
      promptSnippet: `${TOOL_NAME}: fallback web search via DeepSeek, only after web_search fails.`,
      promptGuidelines: [
        `Use ${TOOL_NAME} only when web_search failed or web_search is unavailable. It is not a replacement for web_search.`,
        `After receiving ${TOOL_NAME} results, synthesize a clear answer and cite sources with markdown hyperlinks.`,
      ],
      parameters: webSearchParams,
      renderCall(args, theme) {
        const params = args as DeepSeekSearchParams;
        let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
        text += theme.fg("accent", `"${params.query || "..."}"`);

        const tags: string[] = [];
        if (params.allowed_domains?.length) {
          tags.push(`+${params.allowed_domains.length}d`);
        }
        if (params.blocked_domains?.length) {
          tags.push(`-${params.blocked_domains.length}d`);
        }
        if (tags.length) {
          text += ` ${theme.fg("dim", tags.join(" "))}`;
        }

        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const first = result.content[0];
        const body = first?.type === "text" ? first.text : "";
        const clean = body.replace(/\n*REMINDER:.*$/s, "");
        const lines = clean.split("\n");

        if (!expanded) {
          const preview = lines.slice(0, 6);
          if (lines.length > 6) {
            preview.push(
              theme.fg(
                "dim",
                `... ${lines.length - 6} more lines · ctrl+o to expand`,
              ),
            );
          }
          return new Text(preview.join("\n"), 0, 0);
        }

        return new Text(clean, 0, 0);
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const searchParams = params as DeepSeekSearchParams;
        const query = searchParams.query?.trim();
        if (!query) {
          log.warn("DeepSeek search rejected empty query");
          return errorResult("Error: query is required.");
        }

        notifyProgress(onUpdate, "Searching DeepSeek…");
        log.info("DeepSeek search tool execution started", {
          query,
          allowedDomains: searchParams.allowed_domains?.length ?? 0,
          blockedDomains: searchParams.blocked_domains?.length ?? 0,
        });

        let firstProgress = true;
        const onProgress = (message: string): void => {
          if (!firstProgress) {
            return;
          }
          notifyProgress(onUpdate, message);
          firstProgress = false;
        };

        try {
          const apiKey = await resolveDeepSeekApiKey(ctx);
          const result = await runDeepSeekWebSearch({
            apiKey,
            params: { ...searchParams, query },
            signal,
            onProgress,
          });

          const answer =
            result.answerParts.join("\n\n") || `No results for: ${query}`;
          const sourceText =
            answer + formatSources(result.sources) + citationReminder;
          const footer = `\n\n*${result.tokens.toLocaleString()} tokens · ${result.model}*`;

          log.info("DeepSeek search tool execution completed", {
            query,
            sourceCount: result.sources.length,
            tokens: result.tokens,
            model: result.model,
          });

          return textResult(sourceText + footer, { sources: result.sources });
        } catch (error) {
          const message = readErrorMessage(error);
          log.warn("DeepSeek search tool execution failed", {
            query,
            error: message,
          });
          return errorResult(`Search failed: ${message}`);
        }
      },
    });
    toolRegistered = true;
    log.info("deepseek-search tool registered", {
      toolName: TOOL_NAME,
      searchModel: SEARCH_MODEL,
    });
  };

  const isToolActive = (): boolean => pi.getActiveTools().includes(TOOL_NAME);

  const activateTool = (): void => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME)) return;
    pi.setActiveTools([...active, TOOL_NAME]);
  };

  const deactivateTool = (): void => {
    const active = pi.getActiveTools();
    if (!active.includes(TOOL_NAME)) return;
    pi.setActiveTools(active.filter((n) => n !== TOOL_NAME));
  };

  pi.registerCommand("deepseek-search-toggle", {
    description: "Toggle DeepSeek web search tool on/off or show status",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      if (!arg || arg === "status") {
        const active = isToolActive();
        const savedEnabled = loadDeepSeekSearchSettings().enabled;
        const { message, severity } = formatDeepSeekSearchStatus(
          active,
          savedEnabled,
          SEARCH_MODEL,
        );
        ctx.ui.notify(message, severity);
        return;
      }

      if (arg === "on") {
        if (isToolActive()) {
          ctx.ui.notify("DeepSeek search already enabled", "info");
          return;
        }

        try {
          await resolveDeepSeekApiKey(ctx);
          registerSearchTool();
          activateTool();
          saveDeepSeekSearchSettings({ enabled: true });
          ctx.ui.notify(
            "DeepSeek search enabled — web_search now falls back to it after failing",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`Cannot enable: ${readErrorMessage(error)}`, "error");
        }
        return;
      }

      if (arg === "off") {
        if (!isToolActive()) {
          ctx.ui.notify("DeepSeek search already disabled", "info");
          return;
        }

        deactivateTool();
        saveDeepSeekSearchSettings({ enabled: false });
        ctx.ui.notify("DeepSeek search disabled", "info");
        return;
      }

      ctx.ui.notify("Usage: /deepseek-search-toggle [on|off|status]", "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    lastContext = ctx;
    try {
      const settings = loadDeepSeekSearchSettings();
      log.info("deepseek-search session ready", {
        reason: event.reason,
        cwd: ctx.cwd,
        savedEnabled: settings.enabled,
        toolName: TOOL_NAME,
        searchModel: SEARCH_MODEL,
      });
    } catch (error) {
      log.warn("deepseek-search settings load failed", {
        error: readErrorMessage(error),
      });
    }
  });
}
