import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  checkRepoDirty,
  createRepoGitRunner,
  DEFAULT_GIT_TIMEOUT_MS,
  getRepoRoot,
  listDirtyPaths,
  listLocalBranches,
  listPathsChangedSinceBranch,
  listPathsInLastCommit,
  listRemoteBranches,
} from "../shared/git.ts";
import {
  AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL,
  type PiKitAgentEndCodeSimplifierApprovalEvent,
} from "../shared/internal-events.ts";
import { createLogger } from "../shared/logger.ts";
import { loadSettings, updateSettings } from "../shared/settings.ts";

export type AgentEndCodeSimplifierAbortBehavior = "skip" | "confirm";

export type AgentEndCodeSimplifierConfig = {
  enabled: boolean;
  extensions: string[];
  promptTemplate: string;
  abortBehavior: AgentEndCodeSimplifierAbortBehavior;
  autoRun: boolean;
  confirmBeforeRun: boolean;
  skipExtensionPrompts: boolean;
};

type AgentEndCodeSimplifierSettings = {
  enabled?: unknown;
  extensions?: unknown;
  extraExtensions?: unknown;
  promptTemplate?: unknown;
  abortBehavior?: unknown;
  autoRun?: unknown;
  confirmBeforeRun?: unknown;
  skipExtensionPrompts?: unknown;
};

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".cjs",
  ".php",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".zig",
  ".rs",
  ".py",
  ".rb",
  ".sh",
  ".swift",
  ".lua",
] as const;

const DEFAULT_PROMPT_SKILLS = [
  "me-code-simplifier",
  "boundaries-refactor",
  "improve-codebase-architecture",
  "software-design-philosophy",
  "push-ifs-up-fors-down",
] as const;

const DEFAULT_PROMPT_REQUIREMENTS = [
  `先遵循 ${DEFAULT_PROMPT_SKILLS.join("、")} skills 中定义的规则，再遵循以下任务边界`,
  "这是自动后处理任务：直接做行为不变的简化；不要扩大范围",
  "仅处理 modified_files 中列出的文件；先读取每个文件的完整内容，不要只看 diff 或局部片段",
  "用 software-design-philosophy 的复杂度视角审查 change amplification、cognitive load 和 unknown unknowns",
  "按 improve-codebase-architecture 词汇审查 Module / Interface / Implementation / Depth / Seam / Adapter；优先保留或形成 deep module、information hiding 和不同层级的不同抽象",
  "测试以 Interface is the test surface 为准，优先 test seam/Adapter behavior，不测试 Implementation details",
  "检查并消除不必要的 shallow module、information leakage、temporal decomposition、浅封装/pass-through helper、无意义转发函数和可直接内联的局部抽象",
  "将不可避免的复杂度向模块内部下沉；用 push ifs up and fors down 视角在不改变语义时集中分支决策、下沉重复标量处理",
  "保持行为、接口、错误语义和副作用不变；如果没有必要的简化空间，直接说明无需修改",
];

export const DEFAULT_PROMPT_TEMPLATE = [
  "/skill:me-code-simplifier",
  "<code_simplifier_request>",
  "  <scope>只针对本轮刚修改的文件做一次行为不变的简化</scope>",
  "  <modified_files>",
  "{{files}}",
  "  </modified_files>",
  "  <requirements>",
  ...DEFAULT_PROMPT_REQUIREMENTS.map(
    (requirement) => `    <requirement>${requirement}</requirement>`,
  ),
  "  </requirements>",
  "</code_simplifier_request>",
].join("\n");

const SETTINGS_KEY = "agentEndCodeSimplifier";
const EXTENSION_SOURCE_TAG = "agent-end-code-simplifier";
const RUNNING_WIDGET_KEY = "agent-end-code-simplifier";
// Matches the hidden follow-up marker used to invalidate stale simplifier runs.
const RUN_ID_PATTERN = /\[agent-end-code-simplifier run_id=(\d+)\]/;
const MANUAL_TRIGGER_SHORTCUT = "ctrl+alt+y";
const AUTO_RUN_COMMAND = "agent-end-code-simplifier-auto";
const CONFIRM_BEFORE_RUN_COMMAND = "agent-end-code-simplifier-confirm";
const log = createLogger(EXTENSION_SOURCE_TAG, {
  minLevel: "debug",
  stderr: null,
});

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const normalizeAbortBehavior = (
  value: unknown,
): AgentEndCodeSimplifierAbortBehavior =>
  value === "confirm" || value === "skip" ? value : "skip";

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
    enabled: normalizeBoolean(raw?.enabled, false),
    extensions,
    promptTemplate: normalizeString(
      raw?.promptTemplate,
      DEFAULT_PROMPT_TEMPLATE,
    ),
    abortBehavior: normalizeAbortBehavior(raw?.abortBehavior),
    autoRun: normalizeBoolean(raw?.autoRun, true),
    confirmBeforeRun: normalizeBoolean(raw?.confirmBeforeRun, false),
    skipExtensionPrompts: normalizeBoolean(raw?.skipExtensionPrompts, true),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeToolPath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;

  const filePath = value.trim();
  return filePath.length > 0 ? filePath : null;
};

// Matches Codex apply_patch file headers for files whose final content exists.
const PATCH_PATH_HEADER_PATTERN = /^\*\*\* (?:Add|Update) File: (.+)$/;

const extractPatchPaths = (patch: unknown): string[] => {
  if (typeof patch !== "string") return [];

  return patch
    .split("\n")
    .map((line) =>
      normalizeToolPath(line.match(PATCH_PATH_HEADER_PATTERN)?.[1]),
    )
    .filter((filePath): filePath is string => Boolean(filePath));
};

const extractMultiPaths = (multi: unknown): string[] => {
  if (!Array.isArray(multi)) return [];

  return multi
    .map((item) => (isRecord(item) ? normalizeToolPath(item.path) : null))
    .filter((filePath): filePath is string => Boolean(filePath));
};

const extractToolPaths = (toolName: string, input: unknown): string[] => {
  if (!isRecord(input)) return [];
  if (toolName !== "edit" && toolName !== "write") return [];

  const paths = [
    normalizeToolPath(input.path),
    ...extractMultiPaths(input.multi),
    ...extractPatchPaths(input.patch),
  ].filter((filePath): filePath is string => Boolean(filePath));

  return Array.from(new Set(paths));
};

export type ToolResultPathInput = {
  isError: boolean;
  toolName: string;
  input: unknown;
};

export const collectToolResultPaths = ({
  isError,
  toolName,
  input,
}: ToolResultPathInput): string[] => {
  if (isError) {
    return [];
  }

  return extractToolPaths(toolName, input);
};

export const containsAutoTriggerMarker = (text: string): boolean =>
  text.includes("/skill:me-code-simplifier") || RUN_ID_PATTERN.test(text);

export const extractAutoTriggerRunId = (text: string): number | null => {
  const rawRunId = text.match(RUN_ID_PATTERN)?.[1];
  if (!rawRunId) return null;

  const runId = Number(rawRunId);
  return Number.isSafeInteger(runId) ? runId : null;
};

export const lastUserMessageLooksAutoTriggered = (
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

export const containsAbortedMessage = (messages: readonly unknown[]): boolean =>
  messages.some(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      "stopReason" in message &&
      message.stopReason === "aborted",
  );

export const turnWasAborted = (
  event: { messages?: readonly unknown[] },
  ctx: { signal?: AbortSignal },
): boolean =>
  Boolean(ctx.signal?.aborted) || containsAbortedMessage(event.messages ?? []);

export const normalizeAgentEndInputSource = (
  value: unknown,
): AgentEndInputSource => {
  if (value === "extension") {
    return "extension";
  }

  if (value === "user") {
    return "user";
  }

  return "unknown";
};

const buildApprovalRequestText = (
  supportedPaths: readonly string[],
): { title: string; body: string } => {
  const title = "Run me-code-simplifier?";
  const body = `本轮检测到以下代码文件被修改：\n${supportedPaths
    .map((filePath) => `- ${filePath}`)
    .join("\n")}\n\n是否触发 me-code-simplifier 做一次行为不变的简化？`;

  return { title, body };
};

export const buildManualFallbackOptions = (
  branchCandidates: readonly string[],
): string[] => [
  ...branchCandidates.slice(0, 12),
  ...(branchCandidates.length > 12 ? [OTHER_BRANCH_OPTION] : []),
];

export const decideManualFallbackChoice = (
  choice: string | undefined,
): ManualFallbackChoice | "cancelled" => {
  if (choice === undefined) {
    return "cancelled";
  }

  if (choice === MANUAL_FALLBACK_LAST_COMMIT) {
    return "last_commit";
  }

  if (choice === MANUAL_FALLBACK_BRANCH_DIFF) {
    return "branch_diff";
  }

  return "workspace";
};

export const resolveManualSupportedPathResolution = (
  source: ManualPathSource,
  supportedPaths: string[],
): ManualSupportedPathResolution =>
  supportedPaths.length > 0
    ? { kind: "resolved", source, supportedPaths }
    : { kind: "empty" };

export const decideBranchBaseSelection = ({
  selectedOption,
  typedValue,
}: {
  selectedOption?: string;
  typedValue?: string;
}): BranchBaseSelection => {
  if (selectedOption === undefined) {
    return { kind: "cancelled" };
  }

  if (selectedOption !== OTHER_BRANCH_OPTION) {
    const normalized = selectedOption.trim();
    return normalized.length > 0
      ? { kind: "selected", baseBranch: normalized }
      : { kind: "unavailable" };
  }

  if (typedValue === undefined) {
    return { kind: "cancelled" };
  }

  const normalized = typedValue.trim();
  return normalized.length > 0
    ? { kind: "selected", baseBranch: normalized }
    : { kind: "unavailable" };
};

type ApprovalRaceInput = {
  localDecision: Promise<boolean>;
  remoteDecisions: Array<Promise<boolean>>;
  localAbortController: AbortController;
};

type BooleanConfigField = "autoRun" | "confirmBeforeRun";

export type ManualPathSource =
  | "turn"
  | "workspace"
  | "last_commit"
  | "branch_diff";

type ManualSupportedPathResolution =
  | { kind: "resolved"; source: ManualPathSource; supportedPaths: string[] }
  | { kind: "empty" }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export type AgentEndInputSource = "extension" | "user" | "unknown";

export type ManualFallbackChoice = "workspace" | "last_commit" | "branch_diff";

export type BranchBaseSelection =
  | { kind: "selected"; baseBranch: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

const MANUAL_FALLBACK_WORKSPACE = "工作区未提交变更";
const MANUAL_FALLBACK_LAST_COMMIT = "last commit";
const MANUAL_FALLBACK_BRANCH_DIFF = "与某个分支 diff";
const MANUAL_FALLBACK_OPTIONS = [
  MANUAL_FALLBACK_WORKSPACE,
  MANUAL_FALLBACK_LAST_COMMIT,
  MANUAL_FALLBACK_BRANCH_DIFF,
] as const;
const MANUAL_DIFF_SOURCE_CANCELLED =
  "Cancelled manual simplifier diff source selection.";
const OTHER_BRANCH_OPTION = "Other...";

type ManualShortcutContext = NotificationContext &
  WidgetContext & {
    hasUI: boolean;
    ui: NotificationContext["ui"] & {
      input?: (
        title: string,
        initialValue?: string,
      ) => Promise<string | undefined>;
      select?: (
        title: string,
        options: string[],
      ) => Promise<string | undefined>;
    } & NonNullable<WidgetContext["ui"]>;
  };

export type AgentEndSimplifierDecisionInput = {
  enabled: boolean;
  hasUI: boolean;
  suppressNextPrompt: boolean;
  lastUserMessageAutoTriggered: boolean;
  supportedPaths: string[];
  abortBehavior: AgentEndCodeSimplifierAbortBehavior;
  turnAborted: boolean;
  autoRun: boolean;
  confirmBeforeRun: boolean;
  inputSource: AgentEndInputSource;
  skipExtensionPrompts: boolean;
};

export type AgentEndSimplifierDecision =
  | { kind: "skip"; logEvent: string; clearRunningWidget?: boolean }
  | {
      kind: "skip_suppressed";
      logEvent: string;
      clearRunningWidget: boolean;
      resetSuppressNextPrompt: boolean;
    }
  | {
      kind: "notify_manual_available";
      logEvent: string;
      reason: string;
      supportedPaths: string[];
    }
  | { kind: "send"; supportedPaths: string[] }
  | {
      kind: "confirm";
      supportedPaths: string[];
      title: string;
      body: string;
    };

export const decideAgentEndSimplifierAction = ({
  enabled,
  hasUI,
  suppressNextPrompt,
  lastUserMessageAutoTriggered,
  supportedPaths,
  abortBehavior,
  turnAborted,
  autoRun,
  confirmBeforeRun,
  inputSource,
  skipExtensionPrompts,
}: AgentEndSimplifierDecisionInput): AgentEndSimplifierDecision => {
  if (!enabled) {
    return { kind: "skip", logEvent: "agent_end_skipped_disabled" };
  }
  if (!hasUI) {
    return { kind: "skip", logEvent: "agent_end_skipped_no_ui" };
  }

  if (suppressNextPrompt) {
    return {
      kind: "skip_suppressed",
      logEvent: "agent_end_skipped_suppressed_next_prompt",
      clearRunningWidget: true,
      resetSuppressNextPrompt: true,
    };
  }

  if (lastUserMessageAutoTriggered) {
    return {
      kind: "skip",
      logEvent: "agent_end_skipped_auto_triggered_message",
      clearRunningWidget: true,
    };
  }

  if (supportedPaths.length === 0) {
    return { kind: "skip", logEvent: "agent_end_skipped_no_supported_paths" };
  }

  if (skipExtensionPrompts && inputSource === "extension") {
    return {
      kind: "notify_manual_available",
      logEvent: "agent_end_skipped_extension_prompt",
      reason: "this turn was started by an extension prompt",
      supportedPaths,
    };
  }

  if (abortBehavior === "skip" && turnAborted) {
    return {
      kind: "notify_manual_available",
      logEvent: "agent_end_skipped_aborted_turn",
      reason: "this turn was aborted",
      supportedPaths,
    };
  }

  if (!autoRun) {
    return {
      kind: "notify_manual_available",
      logEvent: "agent_end_skipped_auto_run_disabled",
      reason: "automatic runs are disabled",
      supportedPaths,
    };
  }

  if (!confirmBeforeRun) {
    return { kind: "send", supportedPaths };
  }

  return {
    kind: "confirm",
    supportedPaths,
    ...buildApprovalRequestText(supportedPaths),
  };
};

type NotificationContext = {
  cwd: string;
  ui: { notify: (message: string, type: string) => void };
};

type WidgetContext = {
  hasUI?: boolean;
  isIdle?: () => boolean;
  ui?: {
    setWidget?: (key: string, content?: unknown) => void;
    theme?: { fg?: (tone: string, text: string) => string };
  };
};

type PreparedCodeSimplifierPrompt = {
  prompt: string;
  runId: number;
};

export type AgentEndCodeSimplifierLifecycleState = {
  modifiedPaths: string[];
  suppressNextPrompt: boolean;
  runGeneration: number;
  currentInputSource: AgentEndInputSource;
};

export type AgentEndCodeSimplifierInputEvent = {
  source?: string;
  text?: string;
};

export type AgentEndCodeSimplifierInputTransition = {
  state: AgentEndCodeSimplifierLifecycleState;
  action: "continue" | "handled";
  clearRunningWidget: boolean;
  logEvent?: string;
  staleRunId?: number;
};

export const createAgentEndCodeSimplifierLifecycleState =
  (): AgentEndCodeSimplifierLifecycleState => ({
    modifiedPaths: [],
    suppressNextPrompt: false,
    runGeneration: 0,
    currentInputSource: "unknown",
  });

export const resetLifecycleForNewSession = (
  state: AgentEndCodeSimplifierLifecycleState,
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  modifiedPaths: [],
  suppressNextPrompt: false,
  currentInputSource: "unknown",
});

export const resetLifecycleForAgentStart = (
  state: AgentEndCodeSimplifierLifecycleState,
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  modifiedPaths: [],
});

export const trackModifiedPaths = (
  state: AgentEndCodeSimplifierLifecycleState,
  filePaths: readonly string[],
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  modifiedPaths: Array.from(
    new Set([...state.modifiedPaths, ...filePaths]),
  ).sort(),
});

export const startSimplifierRun = (
  state: AgentEndCodeSimplifierLifecycleState,
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  suppressNextPrompt: true,
  runGeneration: state.runGeneration + 1,
});

export const markSimplifierPromptStale = (
  state: AgentEndCodeSimplifierLifecycleState,
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  suppressNextPrompt: false,
});

export const consumeSuppressedAgentEnd = (
  state: AgentEndCodeSimplifierLifecycleState,
): AgentEndCodeSimplifierLifecycleState => ({
  ...state,
  suppressNextPrompt: false,
});

export const decideInputLifecycleTransition = (
  state: AgentEndCodeSimplifierLifecycleState,
  event: AgentEndCodeSimplifierInputEvent,
): AgentEndCodeSimplifierInputTransition => {
  const currentInputSource = normalizeAgentEndInputSource(event.source);
  const stateWithInputSource = {
    ...state,
    currentInputSource,
  };

  if (currentInputSource === "extension") {
    const runId = extractAutoTriggerRunId(event.text ?? "");
    if (runId !== null && runId !== state.runGeneration) {
      return {
        state: markSimplifierPromptStale(stateWithInputSource),
        action: "handled",
        clearRunningWidget: true,
        logEvent: "input_handled_stale_code_simplifier_prompt",
        staleRunId: runId,
      };
    }

    return {
      state: stateWithInputSource,
      action: "continue",
      clearRunningWidget: false,
    };
  }

  return {
    state: {
      ...stateWithInputSource,
      suppressNextPrompt: false,
      runGeneration: state.runGeneration + 1,
    },
    action: "continue",
    clearRunningWidget: true,
    logEvent: "input_cleared_running_widget",
  };
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

type BooleanCommandAction =
  | { kind: "set"; value: boolean }
  | { kind: "status" }
  | { kind: "invalid"; raw: string };

const parseBooleanCommandAction = (
  args: string,
  current: boolean,
): BooleanCommandAction => {
  const action = args.trim().toLowerCase();
  if (action === "" || action === "toggle") {
    return { kind: "set", value: !current };
  }
  if (action === "on" || action === "true" || action === "enable") {
    return { kind: "set", value: true };
  }
  if (action === "off" || action === "false" || action === "disable") {
    return { kind: "set", value: false };
  }
  if (action === "status") {
    return { kind: "status" };
  }
  return { kind: "invalid", raw: args.trim() };
};

const setConfigBooleanField = (
  cwd: string,
  field: BooleanConfigField,
  value: boolean,
): AgentEndCodeSimplifierConfig => {
  const result = updateSettings(cwd, "project", (settings) => {
    const raw = settings[SETTINGS_KEY];
    const current = isRecord(raw) ? raw : {};
    return {
      ...settings,
      [SETTINGS_KEY]: {
        ...current,
        [field]: value,
      },
    };
  });

  return normalizeConfig(result.settings);
};

export default function agentEndCodeSimplifierExtension(
  pi: ExtensionAPI,
): void {
  let config = normalizeConfig(
    loadSettings(process.cwd(), { forceReload: false }).merged,
  );
  let lifecycle = createAgentEndCodeSimplifierLifecycleState();

  const refreshConfig = (cwd: string) => {
    config = normalizeConfig(loadSettings(cwd, { forceReload: false }).merged);
    log.debug("config_refreshed", {
      cwd,
      enabled: config.enabled,
      extensions: config.extensions,
      promptTemplateLength: config.promptTemplate.length,
      abortBehavior: config.abortBehavior,
      autoRun: config.autoRun,
      confirmBeforeRun: config.confirmBeforeRun,
      skipExtensionPrompts: config.skipExtensionPrompts,
    });
  };

  const diagnostics = (ctx: { cwd?: string; hasUI?: boolean }) => ({
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    enabled: config.enabled,
    abortBehavior: config.abortBehavior,
    autoRun: config.autoRun,
    confirmBeforeRun: config.confirmBeforeRun,
    skipExtensionPrompts: config.skipExtensionPrompts,
    currentInputSource: lifecycle.currentInputSource,
    modifiedPaths: lifecycle.modifiedPaths,
  });

  const showRunningWidget = (
    ctx: WidgetContext,
    supportedPaths: readonly string[],
  ): void => {
    if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") {
      return;
    }

    const message = `🧹 me-code-simplifier running for ${supportedPaths.length} file(s)...`;
    const line = ctx.ui.theme?.fg?.("accent", message) ?? message;
    ctx.ui.setWidget(RUNNING_WIDGET_KEY, [line]);
  };

  const clearRunningWidget = (ctx: WidgetContext): void => {
    if (!ctx.hasUI || typeof ctx.ui?.setWidget !== "function") {
      return;
    }

    ctx.ui.setWidget(RUNNING_WIDGET_KEY, undefined);
  };

  const sendCodeSimplifierPromptWhenIdle = (
    ctx: WidgetContext,
    preparedPrompt: PreparedCodeSimplifierPrompt,
  ): void => {
    if (preparedPrompt.runId !== lifecycle.runGeneration) {
      lifecycle = markSimplifierPromptStale(lifecycle);
      clearRunningWidget(ctx);
      log.debug("code_simplifier_prompt_skipped_stale_before_send", {
        ...diagnostics(ctx),
        runId: preparedPrompt.runId,
        simplifierRunGeneration: lifecycle.runGeneration,
      });
      return;
    }

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      setTimeout(
        () => sendCodeSimplifierPromptWhenIdle(ctx, preparedPrompt),
        25,
      );
      return;
    }

    pi.sendUserMessage(preparedPrompt.prompt);
  };

  const prepareCodeSimplifierPrompt = (
    ctx: WidgetContext,
    supportedPaths: string[],
  ): PreparedCodeSimplifierPrompt => {
    lifecycle = startSimplifierRun(lifecycle);
    const runId = lifecycle.runGeneration;
    const prompt = [
      buildCodeSimplifierPrompt(supportedPaths, config.promptTemplate),
      `[${EXTENSION_SOURCE_TAG} run_id=${runId}]`,
    ].join("\n\n");

    showRunningWidget(ctx, supportedPaths);
    return { prompt, runId };
  };

  const sendCodeSimplifierPrompt = (
    ctx: WidgetContext,
    supportedPaths: string[],
  ) => {
    sendCodeSimplifierPromptWhenIdle(
      ctx,
      prepareCodeSimplifierPrompt(ctx, supportedPaths),
    );
  };

  const sendCodeSimplifierPromptAfterIdle = (
    ctx: WidgetContext,
    supportedPaths: string[],
  ) => {
    const preparedPrompt = prepareCodeSimplifierPrompt(ctx, supportedPaths);
    setTimeout(() => sendCodeSimplifierPromptWhenIdle(ctx, preparedPrompt), 0);
  };

  const sendLoggedCodeSimplifierPrompt = (
    ctx: { cwd?: string; hasUI?: boolean } & WidgetContext,
    supportedPaths: string[],
  ) => {
    log.info("agent_end_sending_code_simplifier_prompt", {
      ...diagnostics(ctx),
      supportedPaths,
    });
    sendCodeSimplifierPromptAfterIdle(ctx, supportedPaths);
  };

  const createRepoRunner = (cwd: string) => {
    const repoRoot = getRepoRoot(cwd, DEFAULT_GIT_TIMEOUT_MS);
    if (!repoRoot) {
      return null;
    }

    return createRepoGitRunner(repoRoot, DEFAULT_GIT_TIMEOUT_MS);
  };

  const collectRepoDirtySupportedPaths = (cwd: string): string[] => {
    const repoRoot = getRepoRoot(cwd, DEFAULT_GIT_TIMEOUT_MS);
    if (!repoRoot) {
      return [];
    }

    const dirty = checkRepoDirty(repoRoot, DEFAULT_GIT_TIMEOUT_MS);
    if (!dirty) {
      return [];
    }

    return collectSupportedPaths(listDirtyPaths(dirty.porcelain), config);
  };

  const collectLastCommitSupportedPaths = (cwd: string): string[] => {
    const runGit = createRepoRunner(cwd);
    if (!runGit) {
      return [];
    }

    return collectSupportedPaths(listPathsInLastCommit(runGit), config);
  };

  const resolveBranchDiffBase = async (
    ctx: ManualShortcutContext,
    cwd: string,
  ): Promise<BranchBaseSelection> => {
    const runGit = createRepoRunner(cwd);
    if (!runGit) {
      return { kind: "unavailable" };
    }

    const branchCandidates = Array.from(
      new Set([...listLocalBranches(runGit), ...listRemoteBranches(runGit)]),
    );
    const options = buildManualFallbackOptions(branchCandidates);

    if (typeof ctx.ui.select === "function") {
      const choice = await ctx.ui.select("Base branch:", options);
      if (choice !== OTHER_BRANCH_OPTION) {
        const selection = decideBranchBaseSelection({ selectedOption: choice });
        if (selection.kind === "cancelled") {
          ctx.ui.notify(MANUAL_DIFF_SOURCE_CANCELLED, "info");
        }
        return selection;
      }
    }

    if (typeof ctx.ui.input !== "function") {
      return { kind: "unavailable" };
    }

    const value = await ctx.ui.input("Base branch:", "main");
    const selection = decideBranchBaseSelection({
      selectedOption: OTHER_BRANCH_OPTION,
      typedValue: value,
    });
    if (selection.kind === "cancelled") {
      ctx.ui.notify(MANUAL_DIFF_SOURCE_CANCELLED, "info");
    }
    return selection;
  };

  const collectBranchDiffSupportedPaths = async (
    ctx: ManualShortcutContext,
    cwd: string,
  ): Promise<ManualSupportedPathResolution> => {
    const runGit = createRepoRunner(cwd);
    if (!runGit) {
      return { kind: "unavailable" };
    }

    const baseBranch = await resolveBranchDiffBase(ctx, cwd);
    if (baseBranch.kind !== "selected") {
      return baseBranch;
    }

    return resolveManualSupportedPathResolution(
      "branch_diff",
      collectSupportedPaths(
        listPathsChangedSinceBranch(runGit, baseBranch.baseBranch),
        config,
      ),
    );
  };

  const resolveManualFallbackSupportedPaths = async (
    ctx: ManualShortcutContext,
    cwd: string,
  ): Promise<ManualSupportedPathResolution> => {
    if (typeof ctx.ui.select !== "function") {
      return resolveManualSupportedPathResolution(
        "workspace",
        collectRepoDirtySupportedPaths(cwd),
      );
    }

    const choice = decideManualFallbackChoice(
      await ctx.ui.select("Choose diff source:", [...MANUAL_FALLBACK_OPTIONS]),
    );
    if (choice === "cancelled") {
      ctx.ui.notify(MANUAL_DIFF_SOURCE_CANCELLED, "info");
      return { kind: "cancelled" };
    }

    if (choice === "last_commit") {
      return resolveManualSupportedPathResolution(
        "last_commit",
        collectLastCommitSupportedPaths(cwd),
      );
    }

    if (choice === "branch_diff") {
      return await collectBranchDiffSupportedPaths(ctx, cwd);
    }

    return resolveManualSupportedPathResolution(
      "workspace",
      collectRepoDirtySupportedPaths(cwd),
    );
  };

  const resolveManualSupportedPaths = (): ManualSupportedPathResolution => {
    return resolveManualSupportedPathResolution(
      "turn",
      collectSupportedPaths(lifecycle.modifiedPaths, config),
    );
  };

  const handleBooleanConfigCommand = (
    args: string,
    ctx: NotificationContext,
    field: BooleanConfigField,
    label: string,
  ) => {
    refreshConfig(ctx.cwd);
    const action = parseBooleanCommandAction(args, config[field]);
    if (action.kind === "invalid") {
      ctx.ui.notify(
        `${label}: unknown action '${action.raw}'. Use on, off, toggle, or status.`,
        "warning",
      );
      return;
    }

    if (action.kind === "status") {
      ctx.ui.notify(`${label} is ${config[field] ? "on" : "off"}.`, "info");
      return;
    }

    config = setConfigBooleanField(ctx.cwd, field, action.value);
    ctx.ui.notify(`${label} is now ${config[field] ? "on" : "off"}.`, "info");
  };

  const notifyManualRunAvailable = (
    ctx: NotificationContext,
    reason: string,
    supportedPathCount: number,
  ): void => {
    const message = [
      `Skipped me-code-simplifier because ${reason}.`,
      `Press Ctrl+Alt+Y to run it for ${supportedPathCount} modified file(s).`,
    ].join(" ");
    ctx.ui.notify(message, "info");
  };

  pi.registerCommand(AUTO_RUN_COMMAND, {
    description:
      "Toggle automatic me-code-simplifier follow-ups after agent turns",
    handler: async (args, ctx) => {
      handleBooleanConfigCommand(
        args,
        ctx,
        "autoRun",
        "agent-end-code-simplifier auto-run",
      );
    },
  });

  pi.registerCommand(CONFIRM_BEFORE_RUN_COMMAND, {
    description:
      "Toggle confirmation before automatic me-code-simplifier follow-ups",
    handler: async (args, ctx) => {
      handleBooleanConfigCommand(
        args,
        ctx,
        "confirmBeforeRun",
        "agent-end-code-simplifier confirmation",
      );
    },
  });

  pi.registerShortcut(MANUAL_TRIGGER_SHORTCUT, {
    description:
      "Manually trigger me-code-simplifier for files changed this turn",
    handler: async (ctx) => {
      refreshConfig(ctx.cwd);

      const turnResolution = resolveManualSupportedPaths();
      const resolution =
        turnResolution.kind === "resolved"
          ? turnResolution
          : await resolveManualFallbackSupportedPaths(
              ctx as ManualShortcutContext,
              ctx.cwd,
            );
      if (resolution.kind === "cancelled") {
        return;
      }

      if (resolution.kind !== "resolved") {
        ctx.ui.notify("No supported modified files to simplify.", "info");
        return;
      }

      const { supportedPaths, source } = resolution;

      log.info("manual_shortcut_sending_code_simplifier_prompt", {
        ...diagnostics(ctx),
        supportedPaths,
        source,
      });
      sendCodeSimplifierPrompt(ctx, supportedPaths);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx.cwd);
    lifecycle = resetLifecycleForNewSession(lifecycle);
    clearRunningWidget(ctx);
    log.debug("session_start_reset", diagnostics(ctx));
  });

  pi.on("agent_start", async (_event, ctx) => {
    refreshConfig(ctx.cwd);
    const shouldClearRunningWidget = !lifecycle.suppressNextPrompt;
    lifecycle = resetLifecycleForAgentStart(lifecycle);
    if (shouldClearRunningWidget) {
      clearRunningWidget(ctx);
    }
    log.debug("agent_start_reset", diagnostics(ctx));
  });

  pi.on("input", (event, ctx) => {
    const transition = decideInputLifecycleTransition(lifecycle, event);
    lifecycle = transition.state;

    if (transition.clearRunningWidget) {
      clearRunningWidget(ctx);
    }

    if (transition.logEvent) {
      log.debug(transition.logEvent, {
        ...diagnostics(ctx),
        runId: transition.staleRunId,
        simplifierRunGeneration: lifecycle.runGeneration,
      });
    }

    return { action: transition.action };
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) {
      log.debug("tool_result_skipped_error", {
        toolName: event.toolName,
      });
      return;
    }
    const filePaths = collectToolResultPaths(event);
    if (filePaths.length === 0) {
      log.debug("tool_result_skipped_no_supported_input_path", {
        toolName: event.toolName,
      });
      return;
    }
    lifecycle = trackModifiedPaths(lifecycle, filePaths);
    log.debug("tool_result_tracked_paths", {
      toolName: event.toolName,
      filePaths,
      modifiedPaths: lifecycle.modifiedPaths,
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    log.debug("agent_end_received", diagnostics(ctx));

    const decision = decideAgentEndSimplifierAction({
      enabled: config.enabled,
      hasUI: Boolean(ctx.hasUI),
      suppressNextPrompt: lifecycle.suppressNextPrompt,
      lastUserMessageAutoTriggered: lastUserMessageLooksAutoTriggered(
        event.messages ?? [],
      ),
      supportedPaths: collectSupportedPaths(lifecycle.modifiedPaths, config),
      abortBehavior: config.abortBehavior,
      turnAborted: turnWasAborted(event, ctx),
      autoRun: config.autoRun,
      confirmBeforeRun: config.confirmBeforeRun,
      inputSource: lifecycle.currentInputSource,
      skipExtensionPrompts: config.skipExtensionPrompts,
    });

    if (decision.kind === "skip_suppressed") {
      if (decision.resetSuppressNextPrompt) {
        lifecycle = consumeSuppressedAgentEnd(lifecycle);
      }
      clearRunningWidget(ctx);
      log.debug(decision.logEvent, diagnostics(ctx));
      return;
    }

    if (decision.kind === "skip") {
      if (decision.clearRunningWidget) {
        clearRunningWidget(ctx);
      }
      log.debug(decision.logEvent, diagnostics(ctx));
      return;
    }

    if (decision.kind === "notify_manual_available") {
      log.debug(decision.logEvent, {
        ...diagnostics(ctx),
        supportedPaths: decision.supportedPaths,
      });
      notifyManualRunAvailable(
        ctx,
        decision.reason,
        decision.supportedPaths.length,
      );
      return;
    }

    if (decision.kind === "send") {
      sendLoggedCodeSimplifierPrompt(ctx, decision.supportedPaths);
      return;
    }

    log.debug("agent_end_confirm_requested", {
      ...diagnostics(ctx),
      supportedPaths: decision.supportedPaths,
    });
    const localAbortController = new AbortController();
    const localDecision = ctx.ui.confirm(decision.title, decision.body, {
      signal: localAbortController.signal,
    });
    const remoteDecisions: Array<Promise<boolean>> = [];
    pi.events.emit(AGENT_END_CODE_SIMPLIFIER_APPROVAL_CHANNEL, {
      type: "agent-end-code-simplifier.approval",
      requestId: `agent_end_code_simplifier_${Date.now()}`,
      createdAt: Date.now(),
      title: decision.title,
      body: decision.body,
      filePaths: decision.supportedPaths,
      contextPreview: [`${decision.title}\n${decision.body}`],
      fullContextLines: [`${decision.title}\n${decision.body}`],
      localDecision,
      attachRemoteDecision: (remoteDecision: Promise<boolean>) => {
        remoteDecisions.push(remoteDecision);
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
      supportedPaths: decision.supportedPaths,
      ok,
    });
    if (!ok) {
      log.debug("agent_end_skipped_confirm_denied", {
        ...diagnostics(ctx),
        supportedPaths: decision.supportedPaths,
      });
      return;
    }

    sendLoggedCodeSimplifierPrompt(ctx, decision.supportedPaths);
  });
}
