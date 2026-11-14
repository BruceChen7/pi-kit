/**
 * 结算判据（ADR-0002 D1）。
 *
 * 一个 run 的结果不是"最后一条 assistant 消息"，而是"在它该等的都等到之后的那条
 * assistant 消息"。判据必须能从 transcript 复算出来，不能靠内存里的标志位 —— 否则
 * 重启、重放、或多一个消费者，就会各说各话。
 *
 * 今天子会话拿不到 subagent 工具（`noExtensions: true`），所以 `obligations`
 * 恒为空，行为与以前一致。**规则先到，是为了让"允许 agent 自 spawn"那天不必回头
 * 改所有结算路径**：欠着结果时给出的那句"我还在推进"叫 intermediate，不是结果。
 */

export type SettlementRole = "assistant" | "tool" | "user";

export type SettlementMessage = {
  role: SettlementRole;
  text: string;
};

export type SettlementStatus = "settled" | "intermediate" | "empty";

export type Settlement = {
  status: SettlementStatus;
  /** 可交付的最终文本；`empty` 与 `intermediate` 交付时另有说明。 */
  text: string;
};

export type SettlementInput = {
  messages: readonly SettlementMessage[];
  /** 这次 run 仍欠着的结果（例如它自己 spawn 的组）。今天恒为空。 */
  obligations?: readonly string[];
};

/** 最后一条有内容的 assistant 消息；没有就是 undefined。 */
const lastAnswer = (
  messages: readonly SettlementMessage[],
): SettlementMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role !== "assistant") continue;
    if (message.text.trim() === "") continue;
    return message;
  }
  return undefined;
};

/**
 * 判这次 run 结没结算。
 *
 * - `empty`：子会话一句 assistant 文本都没有 —— 没有结果可交付。
 * - `intermediate`：它还有结果没等到就先给了答案（"我去查一下"）。答案本身是证据，
 *   但不结算这次工作，调用方不该把它当结果。
 * - `settled`：欠的都到齐了（今天恒成立）之后的那条答案。
 */
export const deriveSettlement = (input: SettlementInput): Settlement => {
  const answer = lastAnswer(input.messages);
  if (answer === undefined) {
    return { status: "empty", text: "" };
  }
  const pending = input.obligations ?? [];
  if (pending.length > 0) {
    return { status: "intermediate", text: answer.text.trim() };
  }
  return { status: "settled", text: answer.text.trim() };
};

/** 结构层之外的适配：pi 的 assistant 内容是一段 part 数组。 */
export const textOfAssistantContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  const texts = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as { type?: string; text?: unknown };
    return record.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  return texts.join("\n").trim();
};

/** 判据认识的输入形状：pi 的消息只需要 role 与 content。 */
export type MessageLike = { role: string; content?: unknown };

/**
 * 把子会话的消息映射成判据的输入。
 *
 * 只保留 role 与文本：`intermediate` 的判据今天只看"有没有答案 + 欠项是否结清"，
 * 不需要把工具调用展开；将来要判"无工具调用"时在这里加字段，而不是在 Shell 里。
 */
export const settlementMessagesFrom = (
  messages: readonly MessageLike[],
): SettlementMessage[] => {
  const out: SettlementMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        text: textOfAssistantContent(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", text: "" });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({ role: "tool", text: "" });
    }
  }
  return out;
};
