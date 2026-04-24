import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

export type AgentEndCodeSimplifierConfig = {
  enabled: boolean;
  extensions: string[];
  promptTemplate: string;
};

type AgentEndCodeSimplifierSettings = {
  enabled?: unknown;
  extensions?: unknown;
  extraExtensions?: unknown;
  promptTemplate?: unknown;
};

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".zig",
  ".rs",
  ".py",
] as const;

export const DEFAULT_PROMPT_TEMPLATE = [
  "/skill:code-simplifier 请只针对本轮刚修改的文件做一次行为不变的简化。",
  "",
  "修改文件：",
  "{{files}}",
  "",
  "要求：",
  "- 仅处理上面列出的文件",
  "- 保持行为、接口、错误语义和副作用不变",
  "- 如果没有必要的简化空间，直接说明无需修改",
].join("\n");

const SETTINGS_KEY = "agentEndCodeSimplifier";
const EXTENSION_SOURCE_TAG = "agent-end-code-simplifier";
const log = createLogger(EXTENSION_SOURCE_TAG, {
  minLevel: "debug",
  stderr: null,
});

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const normalizeExtensionList = (
  value: unknown,
  fallback: readonly string[] = [],
): string[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith(".") ? item : `.${item}`)),
    ),
  );

  return normalized.length > 0 ? normalized : [...fallback];
};

export const normalizeConfig = (
  settings: unknown,
): AgentEndCodeSimplifierConfig => {
  const raw =
    settings && typeof settings === "object"
      ? ((settings as Record<string, unknown>)[SETTINGS_KEY] as
          | AgentEndCodeSimplifierSettings
          | undefined)
      : undefined;

  const baseExtensions = normalizeExtensionList(
    raw?.extensions,
    DEFAULT_SUPPORTED_EXTENSIONS,
  );
  const extraExtensions = normalizeExtensionList(raw?.extraExtensions);
  const extensions = Array.from(
    new Set([...baseExtensions, ...extraExtensions]),
  );

  return {
    enabled: normalizeBoolean(raw?.enabled, true),
    extensions,
    promptTemplate: normalizeString(
      raw?.promptTemplate,
      DEFAULT_PROMPT_TEMPLATE,
    ),
  };
};

export const isSupportedCodePath = (
  filePath: string,
  config: Pick<AgentEndCodeSimplifierConfig, "extensions">,
): boolean => {
  const extension = path.extname(filePath).toLowerCase();
  return config.extensions.includes(extension);
};

export const collectSupportedPaths = (
  filePaths: Iterable<string>,
  config: Pick<AgentEndCodeSimplifierConfig, "extensions">,
): string[] =>
  Array.from(
    new Set(
      Array.from(filePaths).filter((filePath) =>
        isSupportedCodePath(filePath, config),
      ),
    ),
  ).sort();

export const buildCodeSimplifierPrompt = (
  filePaths: string[],
  promptTemplate = DEFAULT_PROMPT_TEMPLATE,
): string => {
  const files = filePaths.map((filePath) => `- ${filePath}`).join("\n");
  return promptTemplate.replace("{{files}}", files);
};

const extractToolPath = (toolName: string, input: unknown): string | null => {
  if (!input || typeof input !== "object") return null;
  if (toolName !== "edit" && toolName !== "write") return null;
  const filePath = (input as { path?: unknown }).path;
  return typeof filePath === "string" && filePath.trim().length > 0
    ? filePath
    : null;
};

const lastUserMessageLooksAutoTriggered = (
  messages: Array<{ role?: string; content?: unknown }>,
): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;

    const content = message.content;
    if (typeof content === "string") {
      return (
        content.includes(`/skill:code-simplifier`) ||
        content.includes(EXTENSION_SOURCE_TAG)
      );
    }

    if (Array.isArray(content)) {
      const text = content
        .filter((part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "text" &&
              "text" in part,
          ),
        )
        .map((part) => part.text)
        .join("\n");
      return (
        text.includes(`/skill:code-simplifier`) ||
        text.includes(EXTENSION_SOURCE_TAG)
      );
    }

    return false;
  }

  return false;
};

export default function agentEndCodeSimplifierExtension(
  pi: ExtensionAPI,
): void {
  let config = normalizeConfig(
    loadSettings(process.cwd(), { forceReload: true }).merged,
  );
  let modifiedPaths = new Set<string>();
  let suppressNextPrompt = false;

  const refreshConfig = (cwd: string) => {
    config = normalizeConfig(loadSettings(cwd, { forceReload: true }).merged);
    log.debug("config_refreshed", {
      cwd,
      enabled: config.enabled,
      extensions: config.extensions,
      promptTemplateLength: config.promptTemplate.length,
    });
  };

  const diagnostics = (ctx: { cwd?: string; hasUI?: boolean }) => ({
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    enabled: config.enabled,
    modifiedPaths: [...modifiedPaths].sort(),
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx.cwd);
    modifiedPaths = new Set();
    log.debug("session_start_reset", diagnostics(ctx));
  });

  pi.on("agent_start", async (_event, ctx) => {
    refreshConfig(ctx.cwd);
    modifiedPaths = new Set();
    log.debug("agent_start_reset", diagnostics(ctx));
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) {
      log.debug("tool_result_skipped_error", {
        toolName: event.toolName,
      });
      return;
    }
    const filePath = extractToolPath(event.toolName, event.input);
    if (!filePath) {
      log.debug("tool_result_skipped_no_supported_input_path", {
        toolName: event.toolName,
      });
      return;
    }
    modifiedPaths.add(filePath);
    log.debug("tool_result_tracked_path", {
      toolName: event.toolName,
      filePath,
      modifiedPaths: [...modifiedPaths].sort(),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    log.debug("agent_end_received", diagnostics(ctx));
    if (!config.enabled) {
      log.debug("agent_end_skipped_disabled", diagnostics(ctx));
      return;
    }
    if (!ctx.hasUI) {
      log.debug("agent_end_skipped_no_ui", diagnostics(ctx));
      return;
    }

    if (suppressNextPrompt) {
      suppressNextPrompt = false;
      log.debug("agent_end_skipped_suppressed_next_prompt", diagnostics(ctx));
      return;
    }

    if (lastUserMessageLooksAutoTriggered(event.messages ?? [])) {
      log.debug("agent_end_skipped_auto_triggered_message", diagnostics(ctx));
      return;
    }

    const supportedPaths = collectSupportedPaths(modifiedPaths, config);
    if (supportedPaths.length === 0) {
      log.debug("agent_end_skipped_no_supported_paths", diagnostics(ctx));
      return;
    }

    log.debug("agent_end_confirm_requested", {
      ...diagnostics(ctx),
      supportedPaths,
    });
    const ok = await ctx.ui.confirm(
      "Run code-simplifier?",
      `本轮检测到以下代码文件被修改：\n${supportedPaths
        .map((filePath) => `- ${filePath}`)
        .join("\n")}\n\n是否触发 code-simplifier 做一次行为不变的简化？`,
    );
    log.debug("agent_end_confirm_resolved", {
      ...diagnostics(ctx),
      supportedPaths,
      ok,
    });
    if (!ok) {
      log.debug("agent_end_skipped_confirm_denied", {
        ...diagnostics(ctx),
        supportedPaths,
      });
      return;
    }

    suppressNextPrompt = true;
    log.info("agent_end_sending_code_simplifier_prompt", {
      ...diagnostics(ctx),
      supportedPaths,
    });
    pi.sendUserMessage(
      `${buildCodeSimplifierPrompt(supportedPaths, config.promptTemplate)}\n\n[${EXTENSION_SOURCE_TAG}]`,
    );
  });
}
