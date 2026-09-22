/**
 * mode-core — `tutor-mode` 会话开关的纯函数核（Functional Core）。
 *
 * 解决的问题：扩展加载时注册的 tutor 专属工具（quiz / ask_user_question /
 * bind_notes / …）在**任何会话**里都对模型可见，于是普通 dev 会话里模型会把
 * ask_user_question 当成通用提问工具用。这里只做判定，不看 pi、不碰磁盘：
 *
 * - 这一轮是不是 `/skill:tutor`？（展开后的 skill 块 / 流式 steer 的原始命令）
 * - 本会话的开关是什么？（显式 `tutor-mode` 条目优先，其次看转录里的 skill 块）
 * - 目标工具集该长什么样？（active × mode，纯字符串数组）
 */

import { TUTOR_MODE_COMMAND_NAME, TUTOR_SESSION_TOOL_NAMES } from "./names.ts";
import { type MessageContent, messageText } from "./notes-core.ts";

export type TutorMode = "on" | "off";

export const TUTOR_SKILL_NAME = "tutor";
/** 会话条目类型（notes-store 用的是 `tutor-notes`，互不干扰）。 */
export const TUTOR_MODE_ENTRY_TYPE = "tutor-mode";
export const TUTOR_MODE_STATUS_COMMAND = `/${TUTOR_MODE_COMMAND_NAME} on | off | status`;

/** 会话条目的结构镜像：只取判定需要的字段，不依赖 pi 的类型。 */
export type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: MessageContent };
};

/** 技能展开把 SKILL.md 包成这个块；带引号，`tutor-lite` 不会误命中。 */
const TUTOR_SKILL_HEAD = `<skill name="${TUTOR_SKILL_NAME}"`;

/** 展开后的 prompt 是否以 tutor skill 块开头。 */
export const detectTutorSkill = (prompt: string): boolean =>
  prompt.trimStart().startsWith(TUTOR_SKILL_HEAD);

/** 原始输入是否就是 `/skill:tutor`（流式中途 steer 时文本还没展开）。 */
export const detectTutorCommand = (text: string): boolean => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/skill:")) return false;
  const [name] = trimmed.slice("/skill:".length).split(/\s/u);
  return name === TUTOR_SKILL_NAME;
};

/** 条目自己声明的开关；形状不认识就返回 undefined（不参与判定）。 */
const entryMode = (entry: SessionEntryLike): TutorMode | undefined => {
  const active = (entry.data as { active?: unknown } | undefined)?.active;
  if (active === true) return "on";
  if (active === false) return "off";
  return undefined;
};

/**
 * 显式 `tutor-mode` 条目的最后一条说了算；一条都没有时看转录
 * （用户消息里有 tutor skill 块 = 这个会话开过 tutor）。
 */
export const restoreTutorMode = (
  entries: readonly SessionEntryLike[],
): TutorMode => {
  let explicit: TutorMode | undefined;
  let hasSkillBlock = false;
  for (const entry of entries) {
    if (
      entry?.type === "custom" &&
      entry.customType === TUTOR_MODE_ENTRY_TYPE
    ) {
      explicit = entryMode(entry) ?? explicit;
      continue;
    }
    if (
      entry?.type === "message" &&
      entry.message?.role === "user" &&
      detectTutorSkill(messageText(entry.message.content))
    ) {
      hasSkillBlock = true;
    }
  }
  return explicit ?? (hasSkillBlock ? "on" : "off");
};

const isTutorSessionTool = (name: string): boolean =>
  (TUTOR_SESSION_TOOL_NAMES as readonly string[]).includes(name);

/** 由「当前 active × mode」算目标工具集；changed=false 时调用方不要调 setActiveTools。 */
export const planToolSync = (
  active: readonly string[],
  mode: TutorMode,
): { tools: string[]; changed: boolean } => {
  const kept = active.filter((name) => !isTutorSessionTool(name));
  const tools =
    mode === "on"
      ? [
          ...kept,
          ...TUTOR_SESSION_TOOL_NAMES.filter((name) => !kept.includes(name)),
        ]
      : kept;
  const changed =
    tools.length !== active.length ||
    tools.some((name, index) => name !== active[index]);
  return { tools, changed };
};

export type TutorModeCommandDecision =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "invalid"; value: string };

/** 空参 = status（对齐 plan-mode 的 `parsePlanModeCommand`）。 */
export const parseTutorModeCommand = (
  args: string,
): TutorModeCommandDecision => {
  const requested = args.trim().toLowerCase();
  if (requested === "" || requested === "status") return { kind: "status" };
  if (requested === "on") return { kind: "on" };
  if (requested === "off") return { kind: "off" };
  return { kind: "invalid", value: args.trim() };
};

/** status 文案：开关状态 + 5 个工具在 active 里的真实存在性（能一秒自证）。 */
export const formatTutorModeStatus = (
  mode: TutorMode,
  active: readonly string[],
): string => {
  const present = TUTOR_SESSION_TOOL_NAMES.filter((name) =>
    active.includes(name),
  );
  const missing = TUTOR_SESSION_TOOL_NAMES.filter(
    (name) => !active.includes(name),
  );
  const parts = [
    `tutor 会话：${mode}`,
    `tutor 专属工具 ${present.length}/${TUTOR_SESSION_TOOL_NAMES.length} 在 active`,
  ];
  if (missing.length > 0) parts.push(`缺：${missing.join("、")}`);
  return `${parts.join("；")}。用法：${TUTOR_MODE_STATUS_COMMAND}`;
};
