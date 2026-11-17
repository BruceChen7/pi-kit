export type SettlementRole = "assistant" | "tool" | "user";

export type SettlementMessage = {
  role: SettlementRole;
  text: string;
};

export type SettlementStatus = "settled" | "intermediate" | "empty";

export type Settlement = {
  status: SettlementStatus;
  text: string;
};

export type SettlementInput = {
  messages: readonly SettlementMessage[];
  obligations?: readonly string[];
};

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

export type MessageLike = { role: string; content?: unknown };

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
