import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type PiKitPlanModeBadgeEvent,
  PLAN_MODE_BADGE_CHANNEL,
} from "../shared/internal-events.js";
import { loadPotetoModeConfig, type PotetoModeConfig } from "./config.js";
import {
  buildInjection,
  formatStatus,
  POTETO_OFF_NOTICE,
  type PotetoModeState,
  renderGuidance,
} from "./guidance.js";
import {
  latestPotetoState,
  POTETO_MODE_ENTRY,
  parsePotetoCommand,
  potetoSnapshot,
  resolvePotetoState,
} from "./state.js";

/** 按扩展自身位置解析，装到 `~/.pi/agent/extensions` 后仍然指向真仓库里的 playbook。 */
const PLAYBOOKS_DIR = fileURLToPath(
  new URL("../../skills/poteto-playbooks/playbooks", import.meta.url),
);

const GUIDANCE = renderGuidance(
  readFileSync(new URL("./guidance.md", import.meta.url), "utf8").trim(),
  PLAYBOOKS_DIR,
);

const branchEntries = (ctx: ExtensionContext): unknown[] => {
  const sessionManager = ctx.sessionManager as {
    getBranch?: () => unknown[];
    getEntries: () => unknown[];
  };
  return typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();
};

export type PotetoModeDeps = {
  /** 测试与脚本可以换掉 settings 读取；默认吃 pi 的两层 settings。 */
  loadConfig?: (cwd: string) => PotetoModeConfig;
};

export default function potetoMode(
  pi: ExtensionAPI,
  deps: PotetoModeDeps = {},
) {
  const loadConfig = deps.loadConfig ?? loadPotetoModeConfig;
  let state: PotetoModeState = { enabled: false, explicit: false };

  /**
   * footer 只有一个写点：广播给 plan-mode，由它拼进 widget 与状态行。
   *
   * 不再直接写 `ctx.ui.setStatus`：两段并列的 footer 没人读。`text: null` 撤下。
   * 事件总线没有 ack，没装 plan-mode 时这条广播会丢掉，`/poteto-mode status`
   * 仍是权威读法。
   */
  const emitBadge = (ctx: ExtensionContext) => {
    pi.events.emit(PLAN_MODE_BADGE_CHANNEL, {
      type: "plan-mode.badge",
      ctx,
      cwd: ctx.cwd,
      key: "poteto",
      text: state.enabled ? "poteto on" : null,
    } satisfies PiKitPlanModeBadgeEvent);
  };

  const restore = (ctx: ExtensionContext) => {
    state = resolvePotetoState(
      latestPotetoState(branchEntries(ctx)),
      loadConfig(ctx.cwd).defaultEnabled,
    );
    // `--poteto-mode` 只改本次进程的状态，不落 entry：脚本化验证用，不污染会话。
    if (pi.getFlag?.("poteto-mode") === true) {
      state = { enabled: true, explicit: true };
    }
    emitBadge(ctx);
  };

  const setEnabled = (ctx: ExtensionContext, enabled: boolean) => {
    state = { enabled, explicit: true };
    pi.appendEntry(POTETO_MODE_ENTRY, potetoSnapshot(enabled));
    emitBadge(ctx);
    ctx.ui.notify(
      enabled
        ? "poteto mode on：每轮注入路由、证据与角色表"
        : `poteto mode off：${POTETO_OFF_NOTICE}`,
      "info",
    );
  };

  pi.registerFlag?.("poteto-mode", {
    description: "Start with persistent poteto mode enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("poteto-mode", {
    description: "Toggle the persistent poteto mode: on, off, status, preview",
    handler: async (args, ctx) => {
      const command = parsePotetoCommand(args ?? "");
      switch (command.kind) {
        case "on":
          setEnabled(ctx, true);
          return;
        case "off":
          setEnabled(ctx, false);
          return;
        case "status":
          ctx.ui.notify(formatStatus(state, GUIDANCE), "info");
          return;
        case "preview":
          ctx.ui.notify(GUIDANCE, "info");
          return;
        case "invalid":
          ctx.ui.notify(
            `未知动词：${command.value}。用 on / off / status / preview`,
            "error",
          );
          return;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    // 每轮补发：两个扩展的 session_start 顺序不保证，先恢复的一方会画出一帧
    // 没有 badge 的 footer。补发让 footer 自愈，代价是一次同步 emit。
    emitBadge(ctx);
    const injection = buildInjection(state, GUIDANCE);
    if (injection === "") {
      return {};
    }
    return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${injection}` };
  });
}
