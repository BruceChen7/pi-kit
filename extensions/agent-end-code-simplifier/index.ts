import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL,
  type PiKitAgentEndCodeSimplifierApprovalEvent,
} from "../shared/internal-events.ts";
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
  "/skill:code-simplifier",
  "<code_simplifier_request>",
  "  <scope>只针对本轮刚修改的文件做一次行为不变的简化</scope>",
  "  <modified_files>",
  "{{files}}",
  "  </modified_files>",
  "  <requirements>",
  "    <requirement>先遵循 code-simplifier、software-design-philosophy 与 push-ifs-up-fors-down skills 中定义的规则，再遵循以下附加约束</requirement>",
  "    <requirement>这是自动后处理任务，不要创建 plan</requirement>",
  "    <requirement>仅处理 modified_files 中列出的文件</requirement>",
  "    <requirement>先读取 modified_files 中每个文件的完整内容；不要只看 diff 或刚改动的片段</requirement>",
  "    <requirement>用 software-design-philosophy 的复杂度视角审查：降低 change amplification、cognitive load 和 unknown unknowns</requirement>",
  "    <requirement>优先保留或形成 deep module、information hiding 和不同层级的不同抽象</requirement>",
  "    <requirement>检查整个文件内的 shallow module、information leakage、temporal decomposition、浅封装/pass-through helper、无意义转发函数和可直接内联的局部抽象</requirement>",
  "    <requirement>将不可避免的复杂度向模块内部下沉；不要把特殊情况或错误处理负担推给调用方</requirement>",
  "    <requirement>用 push ifs up and fors down 视角检查控制流：在不改变语义时集中分支决策，并将重复标量处理下沉为批量处理</requirement>",
  "    <requirement>保持行为、接口、错误语义和副作用不变</requirement>",
  "    <requirement>如果没有必要的简化空间，直接说明无需修改</requirement>",
  "  </requirements>",
  "</code_simplifier_request>",
].join("\n");

const SETTINGS_KEY = "agentEndCodeSimplifier";
const EXTENSION_SOURCE_TAG = "agent-end-code-simplifier";
const MANUAL_TRIGGER_SHORTCUT = "ctrl+alt+y";
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

const escapeXmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const buildCodeSimplifierPrompt = (
  filePaths: string[],
  promptTemplate = DEFAULT_PROMPT_TEMPLATE,
): string => {
  const files = filePaths
    .map((filePath) => `  <file>${escapeXmlText(filePath)}</file>`)
    .join("\n");
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

const containsAutoTriggerMarker = (text: string): boolean =>
  text.includes("/skill:code-simplifier") ||
  text.includes(EXTENSION_SOURCE_TAG);

const lastUserMessageLooksAutoTriggered = (
  messages: Array<{ role?: string; content?: unknown }>,
): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;

    const content = message.content;
    if (typeof content === "string") {
      return containsAutoTriggerMarker(content);
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
      return containsAutoTriggerMarker(text);
    }

    return false;
  }

  return false;
};

type ApprovalRaceInput = {
  localDecision: Promise<boolean>;
  remoteDecisions: Array<Promise<boolean>>;
  localAbortController: AbortController;
};

const waitForApprovalDecision = async ({
  localDecision,
  remoteDecisions,
  localAbortController,
}: ApprovalRaceInput): Promise<boolean> => {
  if (remoteDecisions.length === 0) {
    return await localDecision;
  }

  const result = await Promise.race([
    localDecision.then((decision) => ({ decision, source: "local" as const })),
    Promise.race(remoteDecisions).then((decision) => ({
      decision,
      source: "remote" as const,
    })),
  ]);

  if (result.source === "remote") {
    localAbortController.abort();
  }

  return result.decision;
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

  const sendCodeSimplifierPrompt = (supportedPaths: string[]) => {
    suppressNextPrompt = true;
    pi.sendUserMessage(
      `${buildCodeSimplifierPrompt(supportedPaths, config.promptTemplate)}\n\n[${EXTENSION_SOURCE_TAG}]`,
      { deliverAs: "followUp" },
    );
  };

  pi.registerShortcut(MANUAL_TRIGGER_SHORTCUT, {
    description: "Manually trigger code-simplifier for files changed this turn",
    handler: async (ctx) => {
      refreshConfig(ctx.cwd);
      const supportedPaths = collectSupportedPaths(modifiedPaths, config);
      if (!config.enabled) {
        ctx.ui.notify("agent-end-code-simplifier is disabled.", "warning");
        return;
      }
      if (supportedPaths.length === 0) {
        ctx.ui.notify("No supported modified files to simplify.", "info");
        return;
      }

      log.info("manual_shortcut_sending_code_simplifier_prompt", {
        ...diagnostics(ctx),
        supportedPaths,
      });
      sendCodeSimplifierPrompt(supportedPaths);
    },
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
    const title = "Run code-simplifier?";
    const body = `本轮检测到以下代码文件被修改：\n${supportedPaths
      .map((filePath) => `- ${filePath}`)
      .join("\n")}\n\n是否触发 code-simplifier 做一次行为不变的简化？`;
    const localAbortController = new AbortController();
    const localDecision = ctx.ui.confirm(title, body, {
      signal: localAbortController.signal,
    });
    const remoteDecisions: Array<Promise<boolean>> = [];
    pi.events.emit(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL, {
      type: "agent-end-code-simplifier.approval",
      requestId: `agent_end_code_simplifier_${Date.now()}`,
      createdAt: Date.now(),
      title,
      body,
      filePaths: supportedPaths,
      contextPreview: [`${title}\n${body}`],
      fullContextLines: [`${title}\n${body}`],
      localDecision,
      attachRemoteDecision: (decision: Promise<boolean>) => {
        remoteDecisions.push(decision);
      },
      ctx,
    } satisfies PiKitAgentEndCodeSimplifierApprovalEvent);

    const ok = await waitForApprovalDecision({
      localDecision,
      remoteDecisions,
      localAbortController,
    });
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

    log.info("agent_end_sending_code_simplifier_prompt", {
      ...diagnostics(ctx),
      supportedPaths,
    });
    sendCodeSimplifierPrompt(supportedPaths);
  });
}
