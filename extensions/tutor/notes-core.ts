/**
 * notes-core — 笔记落盘的纯函数核（Functional Core）。
 *
 * 负责：设置解析、主题校验与路径拼装、以及写进笔记的每一段文本格式
 * （Obsidian callout）。所有 IO 都在 notes-store；这里 value in / value out。
 */

import type { AskDetails } from "./ask-core.ts";
import type { QuizDetails } from "./quiz-core.ts";

export const TUTOR_SETTINGS_KEY = "tutor";
export const TUTOR_DEFAULT_VAULT_ROOT = "~/work/notes";
export const TUTOR_DEFAULT_TOP_DIR = "Learn";

export type TopicRejection = "empty" | "separator" | "parent" | "nul";

export const TOPIC_REJECTION_REASONS: TopicRejection[] = [
  "empty",
  "separator",
  "parent",
  "nul",
];

export type TopicCheck =
  | { ok: true; topic: string }
  | { ok: false; reason: TopicRejection };

/** 主题名必须能安全地变成一个目录名与文件名。 */
export const isValidTopic = (topic: string): TopicCheck => {
  const trimmed = topic.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.includes("\0")) return { ok: false, reason: "nul" };
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, reason: "separator" };
  }
  if (trimmed.includes("..")) return { ok: false, reason: "parent" };
  return { ok: true, topic: trimmed };
};

/** `~` 展开在 shell 侧传入 home，保证 core 不碰 env。 */
export const expandHome = (input: string, home: string): string => {
  if (input === "~") return home;
  if (input.startsWith("~/")) return `${home}${input.slice(1)}`;
  return input;
};

export type TutorSettings = {
  vaultRoot: string;
  topDir: string;
  warnings: string[];
};

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** 坏配置一律回落默认值并给出 warning，绝不因为设置写错就中断教学。 */
export const resolveTutorSettings = (
  merged: Record<string, unknown> | undefined,
): TutorSettings => {
  const warnings: string[] = [];
  const raw = merged?.[TUTOR_SETTINGS_KEY];
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    warnings.push(
      `settings.${TUTOR_SETTINGS_KEY} must be an object — using defaults`,
    );
  }
  const section = (raw ?? {}) as Record<string, unknown>;

  let vaultRoot = asNonEmptyString(section.vaultRoot);
  if (vaultRoot === undefined) {
    if (section.vaultRoot !== undefined) {
      warnings.push(
        `settings.${TUTOR_SETTINGS_KEY}.vaultRoot must be a non-empty string — using ${TUTOR_DEFAULT_VAULT_ROOT}`,
      );
    }
    vaultRoot = TUTOR_DEFAULT_VAULT_ROOT;
  }

  let topDir = asNonEmptyString(section.topDir);
  if (topDir === undefined) {
    if (section.topDir !== undefined) {
      warnings.push(
        `settings.${TUTOR_SETTINGS_KEY}.topDir must be a non-empty string — using ${TUTOR_DEFAULT_TOP_DIR}`,
      );
    }
    topDir = TUTOR_DEFAULT_TOP_DIR;
  }
  if (topDir.includes("/") || topDir.includes("\\")) {
    warnings.push(
      `settings.${TUTOR_SETTINGS_KEY}.topDir must be a single directory name — using ${TUTOR_DEFAULT_TOP_DIR}`,
    );
    topDir = TUTOR_DEFAULT_TOP_DIR;
  }

  return { vaultRoot, topDir, warnings };
};

const joinPath = (...parts: string[]): string =>
  parts
    .map((part, index) =>
      index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""),
    )
    .filter((part) => part.length > 0)
    .join("/");

/** `<vaultRoot>/<topDir>/<主题>/<主题>.md`（vaultRoot 需已展开 `~`）。 */
export const topicNotePath = (input: {
  vaultRoot: string;
  topDir: string;
  topic: string;
}): string =>
  joinPath(input.vaultRoot, input.topDir, input.topic, `${input.topic}.md`);

export const topicDirOf = (notePath: string): string =>
  notePath.slice(0, Math.max(0, notePath.lastIndexOf("/")));

/** 新笔记的开头：说明这份文件是谁维护的、怎么追加。 */
export const formatTopicHeader = (topic: string): string =>
  `# ${topic}\n\n> 由 tutor 维持：每次教学按时间顺序追加，只增不改。\n`;

// ── 会话镜像的块格式（Obsidian callout） ──────────────────────────────────

const callout = (type: string, title: string, bodyLines: string[]): string => {
  const lines = [`> [!${type}] ${title}`];
  for (const line of bodyLines) {
    lines.push(line.length === 0 ? ">" : `> ${line}`);
  }
  return lines.join("\n");
};

/** skill 注入的大段 SKILL.md 不是用户的话，压缩成一行提示。 */
export const stripSkillBlocks = (text: string): string =>
  text.replace(
    /<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
    (_match, attrs: string) => {
      const name = /name="([^"]+)"/.exec(attrs)?.[1];
      return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
    },
  );

export const formatUserBlock = (text: string): string =>
  `> [!quote] YOU\n\n${text}`;

export const formatAssistantBlock = (text: string): string =>
  `> [!abstract] PI\n\n${text}`;

const toLines = (text: string): string[] => text.split("\n");

export type QuestionBlockInput = {
  kind: "Quiz" | "Question";
  question: string;
  context?: string;
  options: Array<{ index: number; label: string }>;
};

/** 问题块：永远不含正确答案与解释（笔记是用户会读的）。 */
export const formatQuestionBlock = (input: QuestionBlockInput): string => {
  const body: string[] = [...toLines(input.question)];
  if (input.context) {
    body.push("", ...toLines(input.context));
  }
  if (input.options.length > 0) {
    body.push(
      "",
      ...input.options.map((option) => `${option.index}. ${option.label}`),
    );
  }
  return callout("question", input.kind, body);
};

const correctAnswerLines = (details: QuizDetails): string[] =>
  (details.correctIndices ?? []).map((index) => {
    const label = details.options.find(
      (option) => option.index === index,
    )?.label;
    return label ? `${index}. ${label}` : `${index}`;
  });

export const formatQuizAnswerBlock = (details: QuizDetails): string => {
  if (details.status === "cancelled") {
    return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
  }
  if (details.status === "unavailable") {
    return callout("warning", "Quiz — unavailable", [details.message]);
  }
  const dontKnow = details.dontKnow === true;
  const title = dontKnow
    ? "Quiz — I don't know"
    : details.isCorrect
      ? "Quiz — correct ✓"
      : "Quiz — incorrect ✗";
  // 不要用 "question"：那个类型留给题面（约定：question 块不含答案），判定块里会
  // 写出正确答案，用 "info" 让这条不变量在类型层面成立。
  const type = dontKnow ? "info" : details.isCorrect ? "success" : "failure";

  const body: string[] = [];
  if (dontKnow) {
    body.push("Your answer: I don't know");
  } else {
    const picked =
      (details.answers ?? [])
        .map((answer) => `${answer.index}. ${answer.label}`)
        .join(", ") || "(none)";
    body.push(`Your answer: ${picked}`);
  }
  body.push(
    `Correct answer: ${correctAnswerLines(details).join(", ") || "(none)"}`,
  );
  if (details.explanation) {
    body.push("", ...toLines(details.explanation));
  }
  return callout(type, title, body);
};

export const formatAskAnswerBlock = (details: AskDetails): string => {
  if (details.status === "cancelled") {
    return callout("warning", "Question — cancelled", ["(user skipped)"]);
  }
  if (details.status === "unavailable") {
    return callout("warning", "Question — unavailable", [details.message]);
  }
  const body: string[] = [];
  if (details.otherText) {
    body.push(`Other: ${details.otherText}`);
  }
  body.push(
    ...details.selections.map(
      (selection) => `${selection.index}. ${selection.label}`,
    ),
  );
  if (body.length === 0) body.push("(no answer)");
  return callout("example", "Answer", body);
};

export const isQuizDetails = (
  details: QuizDetails | AskDetails,
): details is QuizDetails => "correctValues" in details;

export const formatAnswerBlock = (details: QuizDetails | AskDetails): string =>
  isQuizDetails(details)
    ? formatQuizAnswerBlock(details)
    : formatAskAnswerBlock(details);

// ── 从会话消息里抽取可读文本 ──────────────────────────────────────────────

export type MessageContent =
  | string
  | Array<{ type?: string; text?: string }>
  | undefined;

export const messageText = (content: MessageContent): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text as string).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
};
