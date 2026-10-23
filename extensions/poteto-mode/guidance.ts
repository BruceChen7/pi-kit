/**
 * 注入正文的判定。纯函数：状态进，文本出，读写与事件都在 index.ts。
 *
 * 正文本身是 `guidance.md`，不放这里。原因：`--check-routes` 直接读 md 做
 * 双向校验，改文案不用碰 TS。
 */

export type PotetoModeState = {
  /** 本分支当前是否开启。 */
  enabled: boolean;
  /** 本分支是否被显式设置过。未设置过时不注入任何东西。 */
  explicit: boolean;
};

/**
 * 显式关闭后每轮都注入这一句。
 *
 * 每轮而不是只在切换那一轮：会话可能被恢复或切分支，唯一能告诉模型
 * 「早先的自动提醒已失效」的通道就是这里。代价约 25 词。
 */
export const POTETO_OFF_NOTICE =
  "poteto 模式在当前分支已关闭。早先的自动模式提醒不再适用，只在本次请求显式点名时才走对应流程。";

/**
 * 正文里的 playbook 目录占位符。
 *
 * 不能写死成 `skills/poteto-playbooks/playbooks`：扩展装在 `~/.pi/agent/extensions`
 * 里，在别的仓库启动时那个相对路径不存在。改成扩展加载时按自身位置算绝对路径，
 * 跟上游「把本文件绝对路径塞进每个 prompt」是同一种做法。
 */
export const PLAYBOOK_DIR_TOKEN = "{{PLAYBOOKS}}";

export const renderGuidance = (body: string, playbooksDir: string): string =>
  body.replaceAll(PLAYBOOK_DIR_TOKEN, playbooksDir.replace(/\/+$/, ""));

/** 空串表示这一轮不改 systemPrompt。 */
export const buildInjection = (
  state: PotetoModeState,
  body: string,
): string => {
  if (!state.explicit) {
    return "";
  }
  return state.enabled ? body : POTETO_OFF_NOTICE;
};

const lineCount = (text: string): number =>
  text.split("\n").filter((line) => line.trim() !== "").length;

export const formatStatus = (state: PotetoModeState, body: string): string => {
  const mode = state.enabled ? "on" : "off";
  const scope = state.explicit ? "" : "（本分支未设置）";
  const injected = state.enabled ? `${lineCount(body)} 行` : "无";
  return `poteto mode ${mode}${scope} | 注入 ${injected}`;
};
