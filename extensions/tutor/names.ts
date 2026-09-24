/**
 * names — tutor 扩展对模型/用户可见的名字，字面量只在这里出现一次。
 *
 * 工具名是 gating 的键：`registerTool` 用什么名注册，mode-core 就按什么名
 * 摘/加；命令名印进 status 文案，必须和 `registerCommand` 一致。分开写会
 * 静默漂移（改名后 gating 失效，不报错）。
 *
 * 注意 `TUTOR_MODE_ENTRY_TYPE`（"tutor-mode"）不在本模块：那是会话条目类型，
 * 和命令名只是恰好同字面量，不是同一个概念。
 */

export const TUTOR_MODE_COMMAND_NAME = "tutor-mode";

export const QUIZ_TOOL_NAME = "quiz";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const BIND_NOTES_TOOL_NAME = "bind_notes";
export const TOPIC_STATUS_TOOL_NAME = "topic_status";
export const NUMBER_CHAPTERS_TOOL_NAME = "number_chapters";
export const SPLIT_TOPIC_TOOL_NAME = "split_topic";
export const NOTE_CONCEPT_TOOL_NAME = "note_concept";
export const CHECK_CONCEPTS_TOOL_NAME = "check_concepts";

/** 只在 tutor 会话里可见的工具（顺序即加回 active 时的顺序）。 */
export const TUTOR_SESSION_TOOL_NAMES = [
  QUIZ_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BIND_NOTES_TOOL_NAME,
  TOPIC_STATUS_TOOL_NAME,
  NUMBER_CHAPTERS_TOOL_NAME,
  SPLIT_TOPIC_TOOL_NAME,
  NOTE_CONCEPT_TOOL_NAME,
  CHECK_CONCEPTS_TOOL_NAME,
] as const;
