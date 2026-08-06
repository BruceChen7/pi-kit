import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  FileEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";
import { resolveConfiguredModel } from "./config.ts";
import {
  buildAgentArgs,
  buildAgentName,
  buildPlaceholderData,
  FORK_PANEL_CUSTOM_TYPE,
  FORK_PANEL_LABEL,
  type ForkPanelPlaceholderData,
  findOwnPlaceholder,
  parseForkPanelArgs,
  refreshSafetyCheck,
  type SplitPlan,
  shouldBlockTreeNavigation,
  splitPlanForTab,
  summarizePrompt,
} from "./core.ts";

const HERDR_CLI_TIMEOUT_MS = 15_000;
const AGENT_START_TIMEOUT_MS = 40_000;
const SHELL_READY_TIMEOUT_MS = 15_000;
const SHELL_POLL_INTERVAL_MS = 300;
const SHELL_NAMES = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "nu"]);

const log = createLogger("fork-panel", { stderr: null });

// biome-ignore lint/suspicious/noExplicitAny: Herdr JSON 响应为宽松类型
type JsonObject = Record<string, any>;

function readSessionFile(file: string): FileEntry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FileEntry);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ctx.sessionManager 的类型是 ReadonlySessionManager，但运行时是完整
 * SessionManager（ExtensionRunner 构造时注入，getter 返回同一对象）。
 * refresh 与占位节点写入需要可变操作；此处 cast 是类型层面对齐运行时事实。
 */
function writableSessionManager(ctx: ExtensionContext): SessionManager {
  return ctx.sessionManager as unknown as SessionManager;
}

/** 重读磁盘上的 session 文件并移回自己的 leaf（安全检查不过则跳过） */ function refreshSession(
  sm: SessionManager,
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  },
): void {
  const file = sm.getSessionFile();
  if (!file) return;
  let entries: FileEntry[];
  try {
    entries = readSessionFile(file);
  } catch {
    return;
  }
  const safety = refreshSafetyCheck(entries);
  if (!safety.ok) {
    ui.notify(`fork-panel: ${safety.reason ?? "未知原因"}`, "warning");
    return;
  }
  const leaf0 = sm.getLeafId();
  try {
    sm.setSessionFile(file);
  } catch (error) {
    log.warn("refresh setSessionFile failed", { error: errorMessage(error) });
    return;
  }
  if (leaf0) sm.branch(leaf0);
}

export default function (pi: ExtensionAPI) {
  async function herdrJson(
    args: string[],
    timeout = HERDR_CLI_TIMEOUT_MS,
  ): Promise<JsonObject> {
    const result = await pi.exec("herdr", args, { timeout });
    if (result.code !== 0) {
      throw new Error(
        `herdr ${args.slice(0, 2).join(" ")} failed: ${
          (result.stderr || result.stdout).trim() || `exit ${result.code}`
        }`,
      );
    }
    try {
      return JSON.parse(result.stdout) as JsonObject;
    } catch {
      throw new Error(`herdr ${args.slice(0, 2).join(" ")} 返回非 JSON 输出`);
    }
  }

  async function herdr(args: string[], timeout = HERDR_CLI_TIMEOUT_MS) {
    const result = await pi.exec("herdr", args, { timeout });
    if (result.code !== 0) {
      throw new Error(
        `herdr ${args.slice(0, 2).join(" ")} failed: ${
          (result.stderr || result.stdout).trim() || `exit ${result.code}`
        }`,
      );
    }
    return result;
  }

  /** split 后 pane 的 shell 初始化有短暂延迟；轮询等待前台进程是 shell */
  async function waitForShellReady(paneId: string): Promise<void> {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const info = await herdrJson([
          "pane",
          "process-info",
          "--pane",
          paneId,
        ]);
        const procs = info.result?.process_info?.foreground_processes ?? [];
        const names = procs.map((p: JsonObject) => String(p.argv0 ?? ""));
        if (names.some((n) => SHELL_NAMES.has(n))) return;
      } catch {
        // pane 可能还在创建中，继续轮询
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SHELL_POLL_INTERVAL_MS),
      );
    }
    throw new Error(
      `pane ${paneId} 的 shell 在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内未就绪`,
    );
  }

  /** 占位节点渲染：`→ fork-panel: <prompt 摘要>` */
  pi.registerEntryRenderer<ForkPanelPlaceholderData>(
    FORK_PANEL_CUSTOM_TYPE,
    (entry, _options, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          `${theme.fg("accent", "→ fork-panel:")} ${data.promptSummary}`,
          0,
          0,
        ),
      );
      return box;
    },
  );

  /**
   * session_before_tree：先 refresh（重读磁盘，看到对方分支最新进展），
   * 再双向拦截（旧 session 不能进 panel 分支；panel 不能回旧分支）。
   */
  pi.on("session_before_tree", (event, ctx) => {
    const sm = writableSessionManager(ctx);
    refreshSession(sm, ctx.ui);

    const targetId = event.preparation.targetId;
    const parentOf = (id: string) => sm.getEntry(id)?.parentId ?? null;
    const placeholderIds = new Set(
      sm
        .getEntries()
        .filter(
          (e) => e.type === "custom" && e.customType === FORK_PANEL_CUSTOM_TYPE,
        )
        .map((e) => e.id),
    );
    if (placeholderIds.size === 0) return;

    const ownPlaceholderId = findOwnPlaceholder(
      sm.getLeafId(),
      (id) => placeholderIds.has(id),
      parentOf,
    );
    if (
      shouldBlockTreeNavigation({
        targetId,
        ownPlaceholderId,
        placeholderIds,
        parentOf,
      })
    ) {
      ctx.ui.notify(
        ownPlaceholderId
          ? "这是 fork 之前的旧分支；请到旧 panel 查看，或另开进程 /resume 同一 session 文件"
          : "这是 fork-panel 分支；请到对应 panel 查看",
        "warning",
      );
      return { cancel: true };
    }
  });

  pi.registerCommand("fork-panel", {
    description:
      "在当前 Herdr tab 分叉 session tree 到新 panel，并执行指定 prompt",
    handler: async (args, ctx) => {
      const sm = writableSessionManager(ctx);

      // ── 参数 ──────────────────────────────────────────────────────
      const parsed = parseForkPanelArgs(args.trim().split(/\s+/));
      let prompt = parsed.prompt;
      if (!prompt) {
        const edited = await ctx.ui.editor(
          "输入 panel 要执行的 prompt（留空取消）",
        );
        if (!edited?.trim()) {
          ctx.ui.notify("fork-panel: 已取消", "info");
          return;
        }
        prompt = edited.trim();
      }

      // ── 校验 ──────────────────────────────────────────────────────
      const sessionFile = sm.getSessionFile();
      if (!sm.isPersisted() || !sessionFile) {
        ctx.ui.notify(
          "fork-panel: 当前 session 未持久化（--no-session），无法分叉",
          "error",
        );
        return;
      }
      // 新 session（尚无 assistant 消息）pre-flush 不落盘：文件不存在时
      // 分叉点无处可写，且手动建文件会破坏后续 pre-flush 的排他创建路径。
      if (!existsSync(sessionFile)) {
        ctx.ui.notify(
          "fork-panel: 会话还没有任何对话（文件未落盘），无法分叉；先发一条消息再试",
          "error",
        );
        return;
      }
      if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
        ctx.ui.notify("fork-panel: 需要在 Herdr panel 中运行", "error");
        return;
      }
      const parentPaneId = process.env.HERDR_PANE_ID;

      // ── 模型：--model > 配置 > 默认 ──────────────────────────────
      const { global, project } = loadSettings(ctx.cwd);
      const configured = resolveConfiguredModel(
        global,
        project,
        ctx.isProjectTrusted(),
      );
      const model = parsed.model ?? configured.model;
      const modelSource = parsed.model ? "explicit" : configured.source;

      // ── parent pane 校验 ─────────────────────────────────────────
      let pane: JsonObject;
      try {
        const response = await herdrJson(["pane", "get", parentPaneId]);
        pane = response.result?.pane;
      } catch (error) {
        ctx.ui.notify(`fork-panel: ${errorMessage(error)}`, "error");
        return;
      }
      if (!pane?.workspace_id || pane.pane_id !== parentPaneId) {
        ctx.ui.notify("fork-panel: 无法校验当前 Herdr pane", "error");
        return;
      }
      const workspaceId = String(pane.workspace_id);
      const parentTabId = String(pane.tab_id);

      // ── 占位节点（锁定分叉点） ──────────────────────────────────
      const leaf0 = sm.getLeafId();
      if (!leaf0) {
        ctx.ui.notify("fork-panel: 会话为空，没有可分叉的位置", "error");
        return;
      }
      const placeholderId = sm.appendCustomEntry(
        FORK_PANEL_CUSTOM_TYPE,
        buildPlaceholderData({
          prompt,
          model,
          createdAt: new Date().toISOString(),
        }),
      );
      try {
        sm.appendLabelChange(placeholderId, FORK_PANEL_LABEL);
      } catch {
        // label 失败不致命
      }
      sm.branch(leaf0); // appendCustomEntry 推进了 leaf，移回原位置

      // ── split 规划与执行 ─────────────────────────────────────────
      let plan: SplitPlan;
      try {
        const layout = await herdrJson([
          "pane",
          "layout",
          "--pane",
          parentPaneId,
        ]);
        const panes = (layout.result?.layout?.panes ?? []).map(
          (p: JsonObject) => ({
            paneId: String(p.pane_id),
            x: Number(p.rect?.x ?? 0),
          }),
        );
        plan = splitPlanForTab(panes);
      } catch (error) {
        ctx.ui.notify(
          `fork-panel: ${errorMessage(error)}（占位节点已写入，但 panel 未创建）`,
          "error",
        );
        return;
      }

      let newPaneId: string;
      try {
        const split = await herdrJson([
          "pane",
          "split",
          plan.targetPaneId,
          "--direction",
          plan.direction,
          "--cwd",
          ctx.cwd,
          "--no-focus",
        ]);
        newPaneId = String(split.result?.pane?.pane_id ?? "");
        if (!newPaneId) throw new Error("split 未返回 pane id");
      } catch (error) {
        ctx.ui.notify(
          `fork-panel: ${errorMessage(error)}（占位节点已写入，但 panel 未创建）`,
          "error",
        );
        return;
      }

      const summary = summarizePrompt(prompt);
      const agentName = `Fork: ${summary}`;
      const herdrAgentName =
        `${buildAgentName(summary, "fork-panel")}-${randomBytes(3).toString("hex")}`.slice(
          0,
          32,
        );

      // split 后 shell 初始化有短暂延迟；等待 pane 就绪再启动 agent，
      // 否则 herdr 报 agent_pane_busy。
      try {
        await waitForShellReady(newPaneId);
      } catch (error) {
        try {
          await herdr(["pane", "close", newPaneId]);
        } catch {
          // 清理失败尽力而为
        }
        ctx.ui.notify(
          `fork-panel: panel shell 未就绪：${errorMessage(error)}（占位节点已写入）`,
          "error",
        );
        return;
      }

      try {
        await herdr(["pane", "rename", newPaneId, agentName]);
      } catch {
        // rename 失败不致命
      }

      // ── agent start（活的交互 pi） ───────────────────────────────
      const agentArgs = buildAgentArgs({ sessionFile, name: agentName, model });
      log.info("agent start", { herdrAgentName, paneId: newPaneId });
      const start = await pi.exec(
        "herdr",
        [
          "agent",
          "start",
          herdrAgentName,
          "--kind",
          "pi",
          "--pane",
          newPaneId,
          "--timeout",
          "30000",
          "--",
          ...agentArgs,
        ],
        { timeout: AGENT_START_TIMEOUT_MS },
      );
      log.info("agent start result", {
        code: start.code,
        stderr: (start.stderr || "").trim().slice(0, 120),
      });
      if (start.code !== 0) {
        try {
          await herdr(["pane", "close", newPaneId]);
        } catch {
          // 清理失败尽力而为
        }
        ctx.ui.notify(
          [
            `fork-panel: agent 启动失败：${(start.stderr || start.stdout)
              .trim()
              .slice(0, 200)}`,
            `手动启动：herdr agent start "${herdrAgentName}" --kind pi --pane ${newPaneId} -- ${agentArgs.join(" ")}`,
          ].join("\n"),
          "error",
        );
        return;
      }

      // ── 初始 prompt（fire-and-forget） ───────────────────────────
      const promptResult = await pi.exec(
        "herdr",
        ["agent", "prompt", newPaneId, prompt],
        { timeout: HERDR_CLI_TIMEOUT_MS },
      );
      if (promptResult.code !== 0) {
        ctx.ui.notify(
          `fork-panel: panel 已创建，但 prompt 提交失败（${(
            promptResult.stderr || ""
          )
            .trim()
            .slice(0, 200)}），可在 panel 中手动输入`,
          "warning",
        );
      }

      log.info("fork-panel created", {
        placeholderId,
        paneId: newPaneId,
        workspaceId,
        tabId: parentTabId,
        model,
        modelSource,
        prompt: summary,
      });
      ctx.ui.notify(
        `fork-panel: 已分叉（panel ${newPaneId}，模型 ${model ?? "默认"}，来源 ${modelSource}）`,
        "info",
      );
    },
  });
}
