export type AllowRuleScope = "exact-command" | "path-prefix" | "tool-wide";

export type SessionAllowRule = {
  toolName: string;
  scope: AllowRuleScope;
  value: string;
  createdAt: number;
};

export type SessionState = {
  sessionId: string;
  sessionLabel: string;
};

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractCommand = (toolInput: Record<string, unknown>): string | null =>
  normalizeText(toolInput.command);

const extractFilePath = (toolInput: Record<string, unknown>): string | null =>
  normalizeText(toolInput.filePath) ?? normalizeText(toolInput.file_path);

export const createSessionState = ({
  sessionId,
  sessionLabel,
}: SessionState) => {
  const allowRules: SessionAllowRule[] = [];

  return {
    sessionId,
    sessionLabel,

    addAllowRule(rule: SessionAllowRule): void {
      allowRules.push(rule);
    },

    getAllowRules(): SessionAllowRule[] {
      return [...allowRules];
    },

    findMatchingAllowRule(
      toolName: string,
      toolInput: Record<string, unknown>,
    ): SessionAllowRule | null {
      for (const rule of allowRules) {
        if (rule.toolName !== toolName) {
          continue;
        }

        if (rule.scope === "tool-wide") {
          return rule;
        }

        if (rule.scope === "exact-command") {
          const command = extractCommand(toolInput);
          if (command && command === rule.value) {
            return rule;
          }
          continue;
        }

        if (rule.scope === "path-prefix") {
          const filePath = extractFilePath(toolInput);
          if (filePath?.startsWith(rule.value)) {
            return rule;
          }
        }
      }

      return null;
    },
  };
};
