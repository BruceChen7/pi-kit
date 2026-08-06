import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

// ─── 常量 ────────────────────────────────────────────────────────────

/** 占位节点的 customType（session 文件中识别 fork 分支） */
export const FORK_PANEL_CUSTOM_TYPE = "fork-panel";
/** 占位节点 label */
export const FORK_PANEL_LABEL = "fork-panel";
/** panel 进程侧角色标记环境变量（父侧不设置，子侧由启动命令设置） */
export const FORK_PANEL_MARKER_ENV = "FORK_PANEL_MARKER";
/** 占位节点 data 版本 */
export const PLACEHOLDER_DATA_VERSION = 1 as const;

export type ForkPanelPlaceholderData = {
  version: typeof PLACEHOLDER_DATA_VERSION;
  prompt: string;
  promptSummary: string;
  model?: string;
  createdAt: string;
};

// ─── 参数解析 ────────────────────────────────────────────────────────

export type ForkPanelArgs = {
  model?: string;
  prompt: string;
};

/**
 * 解析 `/fork-panel` 命令参数：
 * - 首 token 为 "--model" 时，次 token 为模型 id，其余 token 拼为 prompt
 * - 其余情况全部拼为 prompt
 */
export function parseForkPanelArgs(tokens: string[]): ForkPanelArgs {
  if (tokens[0] === "--model") {
    return { model: tokens[1], prompt: tokens.slice(2).join(" ").trim() };
  }
  return { prompt: tokens.join(" ").trim() };
}

// ─── 摘要 ────────────────────────────────────────────────────────────

/** 折叠空白并截断 prompt，用于占位节点/panel 名称摘要 */
export function summarizePrompt(prompt: string, maxLen = 40): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1)}…`;
}

// ─── 占位节点数据 ────────────────────────────────────────────────────

export function buildPlaceholderData(input: {
  prompt: string;
  model?: string;
  createdAt: string;
}): ForkPanelPlaceholderData {
  return {
    version: PLACEHOLDER_DATA_VERSION,
    prompt: input.prompt,
    promptSummary: summarizePrompt(input.prompt),
    ...(input.model ? { model: input.model } : {}),
    createdAt: input.createdAt,
  };
}

// ─── split 规划 ──────────────────────────────────────────────────────

export type SplitPlan = { direction: "right" | "down"; targetPaneId: string };

/**
 * 当前 tab 内 split 规划（用户指定规则）：
 * - 1 个 pane → 对唯一 pane 右侧 split
 * - ≥2 个 pane → 对最右侧（x 最大）pane 向下 split
 */
export function splitPlanForTab(
  panes: Array<{ paneId: string; x: number }>,
): SplitPlan {
  if (panes.length === 0) throw new Error("当前 tab 没有可用的 pane");
  if (panes.length === 1) {
    return { direction: "right", targetPaneId: panes[0].paneId };
  }
  const rightmost = panes.reduce((a, b) => (b.x > a.x ? b : a));
  return { direction: "down", targetPaneId: rightmost.paneId };
}

// ─── 导航拦截判定 ────────────────────────────────────────────────────

/**
 * 目标 entry 是否位于 fork 分支（任一占位节点及其后代）内。
 *
 * - 旧 session 侧：目标是 panel 分支 → 拦截（返回 true）
 * - panel 侧：目标不在自己分支（占位节点祖先链之外）→ 拦截（!isForkBranchTarget）
 *
 * @param parentOf 由调用方注入的 parent 查询（避免依赖 SessionManager，保持纯函数）
 */
export function isForkBranchTarget(
  targetId: string,
  placeholderIds: ReadonlySet<string>,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (placeholderIds.has(targetId)) return true;
  let cur = parentOf(targetId);
  while (cur) {
    if (placeholderIds.has(cur)) return true;
    cur = parentOf(cur);
  }
  return false;
}

/**
 * 从当前 leaf 向上找第一个占位节点 = 本进程自己的分叉起点。
 * 找到 → 本进程是 panel 角色；找不到 → 本进程是旧 session 角色。
 */
export function findOwnPlaceholder(
  leafId: string | null,
  isPlaceholder: (id: string) => boolean,
  parentOf: (id: string) => string | null | undefined,
): string | undefined {
  let cur = leafId;
  while (cur) {
    if (isPlaceholder(cur)) return cur;
    cur = parentOf(cur);
  }
  return undefined;
}

/** 统一拦截判定：返回是否应取消 /tree 导航 */
export function shouldBlockTreeNavigation(input: {
  targetId: string;
  ownPlaceholderId?: string;
  placeholderIds: ReadonlySet<string>;
  parentOf: (id: string) => string | null | undefined;
}): boolean {
  const { targetId, ownPlaceholderId, placeholderIds, parentOf } = input;
  if (placeholderIds.size === 0) return false;
  if (ownPlaceholderId) {
    // panel 角色：目标必须在自己分支（占位节点及后代）内
    return !isForkBranchTarget(targetId, new Set([ownPlaceholderId]), parentOf);
  }
  // 旧 session 角色：目标不能在任一 panel 分支内
  return isForkBranchTarget(targetId, placeholderIds, parentOf);
}

// ─── refresh 安全检查 ────────────────────────────────────────────────

export type RefreshSafety = { ok: boolean; reason?: string };

/**
 * refresh（setSessionFile 重读磁盘）前的安全检查：
 * - header version 与当前 pi 不一致 → 跳过（migration 会全文件重写，clobber 对方分支）
 * - 出现重复 entry id → 跳过（双进程 generateId 碰撞）
 */
export function refreshSafetyCheck(entries: FileEntry[]): RefreshSafety {
  const header = entries.find((e) => e.type === "session") as
    | SessionHeader
    | undefined;
  if (header && header.version !== CURRENT_SESSION_VERSION) {
    return {
      ok: false,
      reason: `session 文件版本 ${header.version} 与当前 pi 版本 ${CURRENT_SESSION_VERSION} 不一致，跳过刷新（避免 migration 重写破坏 panel 分支）`,
    };
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (seen.has(entry.id)) {
      return {
        ok: false,
        reason: `检测到重复 entry id: ${entry.id}，跳过刷新`,
      };
    }
    seen.add(entry.id);
  }
  return { ok: true };
}

// ─── agent 启动参数 ──────────────────────────────────────────────────

/** panel 侧 pi 的启动参数（-- 后传给 herdr agent start） */
export function buildAgentArgs(input: {
  sessionFile: string;
  name: string;
  model?: string;
}): string[] {
  const args = ["--session", input.sessionFile, "--name", input.name];
  if (input.model) args.push("--model", input.model);
  return args;
}

/**
 * herdr agent name 约束：小写字母开头，仅小写字母/数字/-/_，1-32 字符。
 * 从 prompt 摘要生成 slug（预留后缀空间）；不合法时用调用方提供的 fallback。
 * 调用方应追加唯一后缀（如随机 hex），避免同名 agent 冲突（agent_name_taken）。
 */
export function buildAgentName(summary: string, fallback: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 25);
  return /^[a-z][a-z0-9-]*$/.test(slug) ? slug : fallback;
}
