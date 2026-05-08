import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadSettings } from "../shared/settings.ts";
import {
  type ArtifactPolicyConfig,
  formatArtifactPolicyFailure,
  getDefaultArtifactPolicyConfig,
  isStandardPlanArtifactPath,
  validateArtifactPolicy,
} from "./artifact-policy.ts";

type PlanMode = "plan" | "act" | "auto" | "fast";
type PlanPhase = "plan" | "act";
type TodoStatus = "todo" | "in_progress" | "done" | "blocked";
type TodoStatusInput = TodoStatus | "pending";

type TodoInput = {
  text: string;
  status?: TodoStatusInput;
  notes?: string;
};

type TodoPatch = {
  text?: string;
  status?: TodoStatusInput;
  notes?: string;
};

type TodoItem = {
  id: number;
  text: string;
  status: TodoStatus;
  notes?: string;
};

type PlanModeSnapshot = {
  mode: PlanMode;
  phase: PlanPhase;
  todos: TodoItem[];
  nextTodoId: number;
  readFiles: string[];
  activePlanPath: string | null;
  latestReviewArtifactPath: string | null;
  reviewApprovedPlanPaths: string[];
  endConversationRequested: boolean;
};

type PlanModeConfig = {
  defaultMode: PlanMode;
  preserveExternalTools: boolean;
  requireReview: boolean;
  guards: {
    cwdOnly: boolean;
    allowedPaths: string[];
    readBeforeWrite: boolean;
  };
  artifactPolicy: ArtifactPolicyConfig;
};

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const TODO_WIDGET_KEY = "plan-mode-todos";
const TODO_TOOL_NAME = "plan_mode_todo";
const PLANNOTATOR_SUBMIT_TOOL_NAME = "plannotator_auto_submit_review";
const REVIEW_ARTIFACT_LOCATION =
  ".pi/plans/<repo>/plan/ or .pi/plans/<repo>/specs/";

const DEFAULT_CONFIG: PlanModeConfig = {
  defaultMode: "auto",
  preserveExternalTools: true,
  requireReview: true,
  guards: {
    cwdOnly: true,
    allowedPaths: [],
    readBeforeWrite: true,
  },
  artifactPolicy: getDefaultArtifactPolicyConfig(),
};

const BUILTIN_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
];
const PLAN_MODE_TOOL_NAMES = new Set([...BUILTIN_TOOL_NAMES, TODO_TOOL_NAME]);
const WRITE_TOOL_NAMES = new Set(["edit", "write"]);
const PATH_GUARDED_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "rg",
  "fd",
]);
const OUTSIDE_CWD_ALLOWED_TOOL_NAMES = new Set(["read"]);
const PLAN_INSPECTION_TOOL_NAMES = [...PATH_GUARDED_TOOL_NAMES].filter(
  (toolName) => !WRITE_TOOL_NAMES.has(toolName),
);
const PLAN_INSPECTION_TOOL_SLASH_LIST = PLAN_INSPECTION_TOOL_NAMES.join("/");
const PLAN_INSPECTION_TOOL_COMMA_LIST = PLAN_INSPECTION_TOOL_NAMES.join(", ");

const todoStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);

const todoInputSchema = Type.Object({
  text: Type.String({ description: "TODO text" }),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String({ description: "Optional note" })),
});

const todoParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("set"),
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("clear"),
  ]),
  items: Type.Optional(Type.Array(todoInputSchema)),
  id: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  status: Type.Optional(todoStatusSchema),
  notes: Type.Optional(Type.String()),
});

type TodoParams = Static<typeof todoParamsSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringProperty = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const property = value[key];
  return typeof property === "string" ? property : null;
};

const isPlanMode = (value: unknown): value is PlanMode =>
  value === "plan" || value === "act" || value === "auto" || value === "fast";

const isPhaseValue = (value: unknown): value is PlanPhase =>
  value === "plan" || value === "act";

const isTodoStatus = (value: unknown): value is TodoStatus =>
  value === "todo" ||
  value === "in_progress" ||
  value === "done" ||
  value === "blocked";

const normalizeTodoStatus = (status: TodoStatusInput): TodoStatus =>
  status === "pending" ? "todo" : status;

const sanitizeStringArray = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const applyBooleanOverride = <T extends string>(
  target: Record<T, boolean>,
  raw: Record<string, unknown>,
  key: T,
): void => {
  if (typeof raw[key] === "boolean") {
    target[key] = raw[key];
  }
};

const finiteNumberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const phaseForMode = (mode: PlanMode): PlanPhase =>
  mode === "act" ? "act" : "plan";

const todoFromSnapshot = (value: unknown): TodoItem | null => {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !isTodoStatus(value.status)
  ) {
    return null;
  }

  const id = finiteNumberOr(value.id, 0);
  if (id <= 0) {
    return null;
  }

  return {
    id,
    text: value.text,
    status: value.status,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
  };
};

const loadPlanModeConfig = (cwd: string): PlanModeConfig => {
  const { merged } = loadSettings(cwd);
  const raw = isRecord(merged.planMode) ? merged.planMode : {};
  const config: PlanModeConfig = {
    defaultMode: DEFAULT_CONFIG.defaultMode,
    preserveExternalTools: DEFAULT_CONFIG.preserveExternalTools,
    requireReview: DEFAULT_CONFIG.requireReview,
    guards: { ...DEFAULT_CONFIG.guards },
    artifactPolicy: { ...DEFAULT_CONFIG.artifactPolicy },
  };

  if (isPlanMode(raw.defaultMode)) {
    config.defaultMode = raw.defaultMode;
  }
  if (typeof raw.preserveExternalTools === "boolean") {
    config.preserveExternalTools = raw.preserveExternalTools;
  }
  if (typeof raw.requireReview === "boolean") {
    config.requireReview = raw.requireReview;
  }
  if (isRecord(raw.guards)) {
    applyBooleanOverride(config.guards, raw.guards, "cwdOnly");
    applyBooleanOverride(config.guards, raw.guards, "readBeforeWrite");
    config.guards.allowedPaths = sanitizeStringArray(
      raw.guards.allowedPaths,
      config.guards.allowedPaths,
    );
  }
  if (isRecord(raw.artifactPolicy)) {
    const artifactPolicy = raw.artifactPolicy;
    applyBooleanOverride(config.artifactPolicy, artifactPolicy, "enabled");
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "allowExtraSections",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireSectionOrder",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireChinese",
    );
    applyBooleanOverride(
      config.artifactPolicy,
      artifactPolicy,
      "requireReviewDetails",
    );
    if (artifactPolicy.planFormat === "pi-standard") {
      config.artifactPolicy.planFormat = artifactPolicy.planFormat;
    }
  }

  return config;
};

const snapshotFromEntry = (entry: unknown): PlanModeSnapshot | null => {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== STATE_ENTRY_TYPE
  ) {
    return null;
  }
  const data = entry.data;
  if (!isRecord(data) || !isPlanMode(data.mode) || !isPhaseValue(data.phase)) {
    return null;
  }

  const todos = Array.isArray(data.todos)
    ? data.todos.flatMap((todo): TodoItem[] => {
        const parsed = todoFromSnapshot(todo);
        return parsed ? [parsed] : [];
      })
    : [];

  return {
    mode: data.mode,
    phase: data.phase,
    todos,
    nextTodoId: finiteNumberOr(data.nextTodoId, todos.length + 1),
    readFiles: sanitizeStringArray(data.readFiles, []),
    activePlanPath:
      typeof data.activePlanPath === "string" ? data.activePlanPath : null,
    latestReviewArtifactPath:
      typeof data.latestReviewArtifactPath === "string"
        ? data.latestReviewArtifactPath
        : null,
    reviewApprovedPlanPaths: sanitizeStringArray(
      data.reviewApprovedPlanPaths,
      [],
    ),
    endConversationRequested: data.endConversationRequested === true,
  };
};

const latestSnapshot = (entries: unknown[]): PlanModeSnapshot | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotFromEntry(entries[index]);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
};

class PlanModeState {
  mode: PlanMode;
  phase: PlanPhase = "plan";
  todos: TodoItem[] = [];
  nextTodoId = 1;
  readFiles = new Set<string>();
  activePlanPath: string | null = null;
  latestReviewArtifactPath: string | null = null;
  reviewApprovedPlanPaths = new Set<string>();
  endConversationRequested = false;

  constructor(defaultMode: PlanMode) {
    this.mode = defaultMode;
    this.phase = phaseForMode(defaultMode);
  }

  reset(defaultMode: PlanMode): void {
    this.mode = defaultMode;
    this.phase = phaseForMode(defaultMode);
    this.todos = [];
    this.nextTodoId = 1;
    this.readFiles = new Set();
    this.activePlanPath = null;
    this.latestReviewArtifactPath = null;
    this.reviewApprovedPlanPaths = new Set();
    this.endConversationRequested = false;
  }

  restore(snapshot: PlanModeSnapshot | null, defaultMode: PlanMode): void {
    if (!snapshot) {
      this.reset(defaultMode);
      return;
    }

    this.mode = snapshot.mode;
    this.phase = snapshot.phase;
    this.todos = snapshot.todos.map((todo) => ({ ...todo }));
    this.nextTodoId = snapshot.nextTodoId;
    this.readFiles = new Set(snapshot.readFiles);
    this.activePlanPath = snapshot.activePlanPath;
    this.latestReviewArtifactPath = snapshot.latestReviewArtifactPath;
    this.reviewApprovedPlanPaths = new Set(snapshot.reviewApprovedPlanPaths);
    this.endConversationRequested = snapshot.endConversationRequested;
  }

  setMode(mode: PlanMode): void {
    this.mode = mode;
    this.phase = phaseForMode(mode);
    this.endConversationRequested = false;
  }

  switchAutoToAct(): void {
    if (this.mode === "auto") {
      this.phase = "act";
    }
  }

  isPlanPhase(): boolean {
    return (
      this.mode === "plan" || (this.mode === "auto" && this.phase === "plan")
    );
  }

  replaceTodos(items: TodoInput[]): void {
    this.todos = [];
    this.nextTodoId = 1;
    for (const item of items) {
      this.addTodo(item.text, item.status ?? "todo", item.notes);
    }
  }

  addTodo(
    text: string,
    status: TodoStatusInput = "todo",
    notes?: string,
  ): TodoItem {
    const todo: TodoItem = {
      id: this.nextTodoId,
      text,
      status: normalizeTodoStatus(status),
      ...(notes ? { notes } : {}),
    };
    this.nextTodoId += 1;
    this.todos.push(todo);
    return todo;
  }

  updateTodo(id: number, patch: TodoPatch): boolean {
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) {
      return false;
    }
    if (patch.text !== undefined) {
      todo.text = patch.text;
    }
    if (patch.status !== undefined) {
      todo.status = normalizeTodoStatus(patch.status);
    }
    if (patch.notes !== undefined) {
      if (patch.notes) {
        todo.notes = patch.notes;
      } else {
        delete todo.notes;
      }
    }
    return true;
  }

  removeTodo(id: number): boolean {
    const before = this.todos.length;
    this.todos = this.todos.filter((item) => item.id !== id);
    return before !== this.todos.length;
  }

  clearTodos(): void {
    this.todos = [];
    this.nextTodoId = 1;
  }

  snapshot(): PlanModeSnapshot {
    return {
      mode: this.mode,
      phase: this.phase,
      todos: this.todos.map((todo) => ({ ...todo })),
      nextTodoId: this.nextTodoId,
      readFiles: [...this.readFiles],
      activePlanPath: this.activePlanPath,
      latestReviewArtifactPath: this.latestReviewArtifactPath,
      reviewApprovedPlanPaths: [...this.reviewApprovedPlanPaths],
      endConversationRequested: this.endConversationRequested,
    };
  }
}

const getModeLabel = (state: PlanModeState): string => {
  if (state.mode === "auto") {
    return `auto:${state.phase}`;
  }
  return state.mode;
};

const symbolForStatus = (status: TodoStatus): string => {
  switch (status) {
    case "done":
      return "✓";
    case "in_progress":
      return "~";
    case "blocked":
      return "!";
    case "todo":
      return " ";
  }
};

const findCurrentTodo = (todos: TodoItem[]): TodoItem | undefined =>
  todos.find((todo) => todo.status === "in_progress") ??
  todos.find((todo) => todo.status === "todo") ??
  todos.find((todo) => todo.status === "blocked");

const formatTodoWidgetLines = (state: PlanModeState): string[] => {
  if (state.todos.length === 0) {
    return [];
  }

  const total = state.todos.length;
  const done = state.todos.filter((todo) => todo.status === "done").length;
  const current = findCurrentTodo(state.todos);
  const lines: string[] = [];

  if (current) {
    lines.push(`当前 #${current.id}/${total}: ${current.text}`);
  } else {
    lines.push(`完成 ${done}/${total} done`);
  }
  lines.push(`${done}/${total} done • ${total - done} remaining`);

  for (const todo of state.todos) {
    const marker = todo === current ? "→" : " ";
    const notes = todo.notes ? ` (${todo.notes})` : "";
    lines.push(
      `${marker} #${todo.id} [${symbolForStatus(todo.status)}] ${todo.text}${notes}`,
    );
  }

  return lines;
};

const pathFromToolCall = (event: ToolCallEvent): string | null =>
  stringProperty(event.input, "path");

const normalizeToolPath = (cwd: string, rawPath: string): string => {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return path.resolve(cwd, withoutAt);
};

const relativeToolPath = (cwd: string, rawPath: string): string => {
  const absolutePath = normalizeToolPath(cwd, rawPath);
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath.split(path.sep).join("/");
};

const isReviewArtifactPath = (cwd: string, rawPath: string): boolean => {
  const absolutePath = normalizeToolPath(cwd, rawPath);
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  if (isStandardPlanArtifactPath(normalizedRelativePath)) {
    return true;
  }

  const parts = normalizedRelativePath.split("/");
  const [dotPi, plans, repoSlug, artifactDir, fileName] = parts;
  if (
    parts.length !== 5 ||
    dotPi !== ".pi" ||
    plans !== "plans" ||
    !repoSlug ||
    !fileName
  ) {
    return false;
  }

  if (artifactDir === "specs") {
    return /^\d{4}-\d{2}-\d{2}-.+-design\.md$/.test(fileName);
  }
  return false;
};

const isInsideDir = (targetPath: string, dirPath: string): boolean => {
  const relative = path.relative(
    path.resolve(dirPath),
    path.resolve(targetPath),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const isAllowedPath = (
  targetPath: string,
  cwd: string,
  allowedPaths: string[],
): boolean =>
  isInsideDir(targetPath, cwd) ||
  allowedPaths.some((allowedPath) =>
    isInsideDir(targetPath, path.resolve(cwd, allowedPath)),
  );

const extractTextContent = (event: ToolResultEvent): string => {
  const rawContent = (event as { content?: unknown }).content;
  if (!Array.isArray(rawContent)) {
    return "";
  }
  return rawContent
    .flatMap((entry) => {
      if (
        isRecord(entry) &&
        entry.type === "text" &&
        typeof entry.text === "string"
      ) {
        return [entry.text];
      }
      return [];
    })
    .join("\n");
};

const extractApprovedPath = (text: string): string | null => {
  const match = text.match(/Review approved for\s+(.+?\.md)\.?/i);
  return match?.[1]?.trim() ?? null;
};

const turnWasAborted = (
  event: { messages?: readonly unknown[] },
  ctx: { signal?: AbortSignal },
): boolean => {
  if (ctx.signal?.aborted) {
    return true;
  }
  return (event.messages ?? []).some(
    (message) =>
      isRecord(message) &&
      message.role === "assistant" &&
      message.stopReason === "aborted",
  );
};

class PlanModeController {
  config: PlanModeConfig = DEFAULT_CONFIG;
  state = new PlanModeState(DEFAULT_CONFIG.defaultMode);

  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext): void {
    this.config = loadPlanModeConfig(ctx.cwd);
    const entries = ctx.sessionManager.getEntries() as unknown[];
    this.state.restore(latestSnapshot(entries), this.config.defaultMode);
  }

  persist(): void {
    this.pi.appendEntry(STATE_ENTRY_TYPE, this.state.snapshot());
  }

  applyMode(ctx: ExtensionContext): void {
    this.pi.setActiveTools(this.getToolsForCurrentMode());
    this.updateUi(ctx);
  }

  getToolsForCurrentMode(): string[] {
    const stableTools = [...BUILTIN_TOOL_NAMES, TODO_TOOL_NAME];
    if (!this.config.preserveExternalTools) {
      return stableTools;
    }

    const externalTools = this.pi
      .getActiveTools()
      .filter((toolName) => !PLAN_MODE_TOOL_NAMES.has(toolName));
    return [...new Set([...stableTools, ...externalTools])];
  }

  setMode(ctx: ExtensionContext, mode: PlanMode): void {
    this.state.setMode(mode);
    this.applyMode(ctx);
    this.persist();
    ctx.ui.notify(`Plan mode: ${getModeLabel(this.state)}`, "info");
  }

  updateUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);

    const widgetLines = formatTodoWidgetLines(this.state);
    if (widgetLines.length === 0) {
      ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(TODO_WIDGET_KEY, widgetLines, {
      placement: "aboveEditor",
    });
  }

  buildModePrompt(): string {
    return [
      "## Plan Mode Extension",
      "",
      `Current mode: ${getModeLabel(this.state)}.`,
      "",
      `- In plan phases, inspect with ${PLAN_INSPECTION_TOOL_SLASH_LIST}. ` +
        "Runtime guards block bash and source-code edits.",
      `- Use ${TODO_TOOL_NAME} to maintain the concrete TODO list.`,
      "- For implementation tasks, write only reviewable plan/spec artifacts under " +
        `${REVIEW_ARTIFACT_LOCATION} and submit them with ` +
        `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
      "- Standard plan artifacts must use ## Context, ## Steps, " +
        "## Verification, and ## Review with Chinese checkbox steps.",
      "- If Plannotator denies the plan, revise the same file and submit again.",
      "- In act phases, execute the approved plan and update " +
        `${TODO_TOOL_NAME} statuses to in_progress and done so the widget shows the current step.`,
    ].join("\n");
  }

  validateArtifactPolicyForPath(
    ctx: ExtensionContext,
    rawPath: string,
  ): string | null {
    const policyPath = relativeToolPath(ctx.cwd, rawPath);
    if (!isStandardPlanArtifactPath(policyPath)) {
      return null;
    }

    const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return [
        "Plan Mode artifact policy blocked review submission.",
        `Path: ${policyPath}`,
        "",
        "Fix: create or rewrite the plan artifact before submitting review.",
      ].join("\n");
    }

    const result = validateArtifactPolicy({
      path: policyPath,
      content,
      config: this.config.artifactPolicy,
    });
    if (result.approved) {
      return null;
    }

    return formatArtifactPolicyFailure(policyPath, result.issues);
  }

  maybeBlockTool(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined {
    if (event.toolName === PLANNOTATOR_SUBMIT_TOOL_NAME) {
      const rawPath = pathFromToolCall(event);
      if (rawPath) {
        const absolutePath = normalizeToolPath(ctx.cwd, rawPath);
        if (
          this.config.guards.cwdOnly &&
          !isAllowedPath(absolutePath, ctx.cwd, this.config.guards.allowedPaths)
        ) {
          return {
            block: true,
            reason:
              `plan-mode blocked ${event.toolName}: path is outside cwd and ` +
              `allowed paths: ${rawPath}`,
          };
        }

        const policyFailure = this.validateArtifactPolicyForPath(ctx, rawPath);
        if (policyFailure) {
          return {
            block: true,
            reason: policyFailure,
          };
        }
      }
    }

    if (this.state.isPlanPhase() && event.toolName === "bash") {
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: current phase is read-only. ` +
          `Use ${PLAN_INSPECTION_TOOL_COMMA_LIST}, and ${TODO_TOOL_NAME}.`,
      };
    }

    if (this.state.isPlanPhase() && WRITE_TOOL_NAMES.has(event.toolName)) {
      const rawPath = pathFromToolCall(event);
      if (rawPath && isReviewArtifactPath(ctx.cwd, rawPath)) {
        return undefined;
      }
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: current phase can only write ` +
          `reviewable plan/spec artifacts under ${REVIEW_ARTIFACT_LOCATION}.`,
      };
    }

    if (!this.config.guards.cwdOnly && !this.config.guards.readBeforeWrite) {
      return undefined;
    }

    if (!PATH_GUARDED_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }

    const rawPath = pathFromToolCall(event) ?? ".";
    const absolutePath = normalizeToolPath(ctx.cwd, rawPath);

    if (
      !OUTSIDE_CWD_ALLOWED_TOOL_NAMES.has(event.toolName) &&
      this.config.guards.cwdOnly &&
      !isAllowedPath(absolutePath, ctx.cwd, this.config.guards.allowedPaths)
    ) {
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: path is outside cwd and ` +
          `allowed paths: ${rawPath}`,
      };
    }

    if (
      this.config.guards.readBeforeWrite &&
      WRITE_TOOL_NAMES.has(event.toolName) &&
      fs.existsSync(absolutePath) &&
      !this.state.readFiles.has(absolutePath)
    ) {
      return {
        block: true,
        reason:
          `plan-mode blocked ${event.toolName}: read the file first before ` +
          `modifying it: ${rawPath}`,
      };
    }

    return undefined;
  }

  handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
    if (event.toolName === "read" && !event.isError) {
      const rawPath = stringProperty(event.input, "path");
      if (rawPath) {
        this.state.readFiles.add(normalizeToolPath(ctx.cwd, rawPath));
        this.persist();
      }
      return;
    }

    if (WRITE_TOOL_NAMES.has(event.toolName) && !event.isError) {
      const rawPath = stringProperty(event.input, "path");
      if (rawPath && isReviewArtifactPath(ctx.cwd, rawPath)) {
        this.state.latestReviewArtifactPath = relativeToolPath(
          ctx.cwd,
          rawPath,
        );
        this.persist();
      }
      return;
    }

    if (event.toolName !== PLANNOTATOR_SUBMIT_TOOL_NAME || event.isError) {
      return;
    }

    const approvedPath = extractApprovedPath(extractTextContent(event));
    if (!approvedPath) {
      return;
    }

    this.state.activePlanPath = approvedPath;
    this.state.reviewApprovedPlanPaths.add(approvedPath);
    this.state.switchAutoToAct();
    this.applyMode(ctx);
    this.persist();
  }
}

const formatTodoResult = (state: PlanModeState): string => {
  if (state.todos.length === 0) {
    return "Current Plan Mode TODO list: empty.";
  }
  return `Current Plan Mode TODO list:\n${state.todos
    .map((todo) => `#${todo.id} [${symbolForStatus(todo.status)}] ${todo.text}`)
    .join("\n")}`;
};

const todoToolError = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export default function planModeExtension(pi: ExtensionAPI): void {
  const controller = new PlanModeController(pi);

  pi.registerFlag?.("plan-mode", {
    description: "Start with plan-mode auto workflow enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan-mode", {
    description: "Switch Plan Mode workflow: plan, act, auto, fast, status",
    getArgumentCompletions: (prefix: string) =>
      ["plan", "act", "auto", "fast", "status"]
        .filter((mode) => mode.startsWith(prefix))
        .map((mode) => ({ label: mode, value: mode })),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "status" || requested.length === 0) {
        ctx.ui.notify(`Plan mode: ${getModeLabel(controller.state)}`, "info");
        controller.updateUi(ctx);
        return;
      }
      if (!isPlanMode(requested)) {
        ctx.ui.notify(`Unknown plan-mode: ${requested}`, "error");
        return;
      }
      controller.setMode(ctx, requested);
    },
  });

  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Plan Mode TODO",
    description:
      "Create, list, update, remove, or clear the active Plan Mode TODO list.",
    promptSnippet: "Manage the Plan Mode TODO list and current execution step",
    promptGuidelines: [
      `Use ${TODO_TOOL_NAME} to create concrete TODOs during Plan phase before implementation.`,
      "In Act phase, update " +
        `${TODO_TOOL_NAME} items to in_progress before starting a step and done after ` +
        "finishing it so the widget shows the current step.",
    ],
    parameters: todoParamsSchema,
    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "set":
          controller.state.replaceTodos(params.items ?? []);
          break;
        case "add":
          if (!params.text) {
            return todoToolError("Error: text is required for add.");
          }
          controller.state.addTodo(
            params.text,
            params.status ?? "todo",
            params.notes,
          );
          break;
        case "update":
          if (params.id === undefined) {
            return todoToolError("Error: id is required for update.");
          }
          if (
            !controller.state.updateTodo(params.id, {
              ...(params.text !== undefined ? { text: params.text } : {}),
              ...(params.status !== undefined ? { status: params.status } : {}),
              ...(params.notes !== undefined ? { notes: params.notes } : {}),
            })
          ) {
            return todoToolError(`Error: TODO #${params.id} not found.`);
          }
          break;
        case "remove":
          if (params.id === undefined) {
            return todoToolError("Error: id is required for remove.");
          }
          controller.state.removeTodo(params.id);
          break;
        case "clear":
          controller.state.clearTodos();
          break;
        case "list":
          break;
      }

      controller.updateUi(ctx);
      controller.persist();
      return {
        content: [{ type: "text", text: formatTodoResult(controller.state) }],
        details: { todos: controller.state.todos.map((todo) => ({ ...todo })) },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    controller.restore(ctx);
    if (pi.getFlag?.("plan-mode") === true) {
      controller.state.setMode("auto");
    }
    controller.applyMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    controller.restore(ctx);
    controller.applyMode(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt ?? ""}\n\n${controller.buildModePrompt()}`,
  }));

  pi.on("tool_call", async (event, ctx) =>
    controller.maybeBlockTool(event, ctx),
  );

  pi.on("tool_result", async (event, ctx) => {
    controller.handleToolResult(event, ctx);
    controller.updateUi(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    controller.updateUi(ctx);
    if (turnWasAborted(event, ctx)) {
      return;
    }
    if (controller.state.isPlanPhase() && controller.state.todos.length === 0) {
      pi.sendUserMessage(
        "Plan Mode requires a concrete TODO list before ending this planning turn. " +
          `Call ${TODO_TOOL_NAME} with action "set" or "add", then create and ` +
          `submit a reviewable plan/spec with ${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
        { deliverAs: "followUp" },
      );
      return;
    }

    const latestArtifactPath = controller.state.latestReviewArtifactPath;
    if (latestArtifactPath) {
      const policyFailure = controller.validateArtifactPolicyForPath(
        ctx,
        latestArtifactPath,
      );
      if (policyFailure) {
        pi.sendUserMessage(policyFailure, { deliverAs: "followUp" });
        return;
      }
    }

    if (
      controller.config.requireReview &&
      controller.state.mode === "auto" &&
      controller.state.phase === "plan" &&
      controller.state.todos.length > 0 &&
      controller.state.reviewApprovedPlanPaths.size === 0
    ) {
      pi.sendUserMessage(
        "Plan Mode is waiting for an approved Plannotator plan/spec. Write the plan " +
          `under ${REVIEW_ARTIFACT_LOCATION}, then call ` +
          `${PLANNOTATOR_SUBMIT_TOOL_NAME}.`,
        { deliverAs: "followUp" },
      );
    }
  });
}
