type TextPart = {
  type: "text";
  text: string;
};

type MessageEntry = {
  type: "message";
  message: {
    role?: string;
    stopReason?: string;
    content?: unknown;
  };
};

type SessionEntry = MessageEntry | { type: string };

type ContextPreviewOptions = {
  maxTurns: number;
  maxChars: number;
};

const isTextPart = (value: unknown): value is TextPart =>
  Boolean(value) &&
  typeof value === "object" &&
  "type" in value &&
  value.type === "text" &&
  "text" in value &&
  typeof value.text === "string";

const getMessageText = (entry: SessionEntry): string | null => {
  if (entry.type !== "message") {
    return null;
  }
  const content = entry.message.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
};

const truncateInline = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return "…";
  }
  return `${value.slice(0, maxChars - 1)}…`;
};

export const extractContextPreview = (
  entries: SessionEntry[],
  options: ContextPreviewOptions,
): string[] => {
  const lines: string[] = [];

  for (
    let i = entries.length - 1;
    i >= 0 && lines.length < options.maxTurns;
    i--
  ) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = getMessageText(entry);
    if (!text) {
      continue;
    }
    lines.push(`${role}: ${truncateInline(text, options.maxChars)}`);
  }

  return lines.reverse();
};

export const extractFullContext = (
  entries: SessionEntry[],
  options: Pick<ContextPreviewOptions, "maxTurns">,
): string[] => {
  const lines: string[] = [];

  for (
    let i = entries.length - 1;
    i >= 0 && lines.length < options.maxTurns;
    i--
  ) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = getMessageText(entry);
    if (!text) {
      continue;
    }
    lines.push(`${role}: ${text}`);
  }

  return lines.reverse();
};

export const extractLastAssistantSummary = (
  entries: SessionEntry[],
): string | null => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    if (entry.message.stopReason && entry.message.stopReason !== "stop") {
      continue;
    }
    const text = getMessageText(entry);
    if (text) {
      return text;
    }
  }

  return null;
};
