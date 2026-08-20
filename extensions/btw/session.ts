// # btw session — 子会话 boot（Imperative Shell）
//
// 创建/销毁 btw 的只读 AgentSession：seed 主会话消息、组装 system prompt、
// 白名单只读工具、继承主会话模型与 thinking level。
// 与 core.ts（纯逻辑）和 index.ts（编排）分离，作为唯一的会话副作用出口。

import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  type ResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** btw role 系统提示：临时、只读、不承诺任何操作。 */
export const BTW_SYSTEM_PROMPT = [
  "You are a temporary, read-only side agent answering one quick question for the user.",
  "The main agent continues its work uninterrupted; you share its conversation as background context only.",
  "You have read-only tools (read, grep, find, ls) so you may inspect the repository to answer accurately.",
  "Never claim to have modified anything, and never promise to take any action later.",
  "Answer directly and concisely.",
].join(" ");

/** btw 子会话的工具白名单（只读，无 bash/edit/write）。 */
export const BTW_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * 组装子会话的资源加载器：继承主会话的 customPrompt 与 appendSystemPrompt，
 * 并追加 btw role 提示。context 文件 / skills 由 loader 从当前 cwd 磁盘按需加载。
 */
export async function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
): Promise<ResourceLoader> {
  const promptOptions = ctx.getSystemPromptOptions();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: promptOptions.customPrompt,
    appendSystemPrompt: [
      ...(promptOptions.appendSystemPrompt
        ? [promptOptions.appendSystemPrompt]
        : []),
      BTW_SYSTEM_PROMPT,
    ],
  });
  await loader.reload();
  return loader;
}

/**
 * 把主会话当前消息投影成 seed。
 * 写入 in-memory 子会话的 journal（而非仅 agent state），
 * 这样首次 compaction / 摘要重建时 seed 不会丢失。
 */
export function buildSeedMessages(ctx: ExtensionCommandContext): Message[] {
  const context = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  return convertToLlm(context.messages);
}

/**
 * boot 一个新的只读 btw 子会话：in-memory journal + 白名单工具 +
 * 继承主会话模型与 thinking level。调用方负责缓存/复用与 dispose。
 */
export async function bootBtwSession(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<AgentSession | null> {
  if (!ctx.model) return null;
  const resourceLoader = await createBtwResourceLoader(ctx);
  const sessionManager = SessionManager.inMemory(ctx.cwd);
  for (const message of buildSeedMessages(ctx)) {
    sessionManager.appendMessage(message);
  }
  const { session } = await createAgentSession({
    model: ctx.model,
    thinkingLevel: pi.getThinkingLevel(),
    tools: [...BTW_TOOLS],
    sessionManager,
    resourceLoader,
  });
  return session;
}

/**
 * 每次 ask 前重同步主会话的模型与 thinking level。
 * 失败时静默——保留子会话当前使用的配置。
 */
export async function reSyncBtwSession(
  session: AgentSession,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  try {
    if (ctx.model) await session.setModel(ctx.model);
    session.setThinkingLevel(pi.getThinkingLevel());
  } catch {
    // 保留子会话当前使用的模型/thinking level。
  }
}

/** 销毁 btw 子会话（reset 语义：abort 后 dispose 并懒重建）。 */
export function disposeBtwSession(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    // dispose 竞态可忽略。
  }
}

export type { AgentSession, AgentSessionEvent, AgentSessionEventListener };
